import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { DataverseError, plainJson } from "./responses.js";
import type { Settings } from "./settings.js";

// ---------- JWT HS256 (Entra real firma con RS256; HS256 es una simplificación del mock) ----------

const b64 = (data: string | Buffer) => Buffer.from(data).toString("base64url");
const sign = (input: string, key: string) => createHmac("sha256", key).update(input).digest("base64url");

export interface TokenOptions { ttl: number; appid?: string; aud?: string; tid?: string; iat?: number }

export function makeToken(s: Settings, base: string, o: TokenOptions): string {
  const iat = o.iat ?? Math.floor(Date.now() / 1000);
  const tid = o.tid ?? s.tenantId;
  const claims = {
    aud: o.aud ?? base,
    iss: `https://sts.windows.net/${tid}/`,
    tid,
    appid: o.appid ?? s.clientId,
    iat,
    nbf: iat,
    exp: iat + o.ttl,
  };
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify(claims));
  return `${head}.${body}.${sign(`${head}.${body}`, s.signingKey)}`;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Devuelve null si el token es válido, o el motivo del rechazo. */
export function verifyToken(s: Settings, base: string, token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return "malformed token";
  const [head, body, sig] = parts;
  if (!safeEqual(sig, sign(`${head}.${body}`, s.signingKey))) return "invalid signature";
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return "malformed token";
  }
  if (Date.now() / 1000 >= Number(claims.exp ?? 0)) return "token expired";
  if (claims.aud !== base) return "invalid audience";
  if (claims.tid !== s.tenantId) return "invalid tenant";
  return null;
}

export function unauthorized(s: Settings, base: string, message: string, invalidToken = false): DataverseError {
  // Formato de WWW-Authenticate APROXIMADO: la documentación de Dataverse no lo especifica.
  let challenge = `Bearer authorization_uri="https://login.microsoftonline.com/${s.tenantId}", resource_id="${base}"`;
  if (invalidToken) challenge += `, error="invalid_token", error_description="${message}"`;
  return new DataverseError(401, message, "", { "WWW-Authenticate": challenge });
}

export function requireToken(s: Settings, base: string, req: Request): void {
  const header = req.headers.get("authorization") ?? "";
  const [scheme, ...rest] = header.split(" ");
  const token = rest.join(" ").trim();
  if (!header) throw unauthorized(s, base, "Bearer token is missing.");
  if (scheme.toLowerCase() !== "bearer" || !token) throw unauthorized(s, base, "Authorization header must use the Bearer scheme.");
  const reason = verifyToken(s, base, token);
  if (reason) throw unauthorized(s, base, `Bearer token rejected: ${reason}.`, true);
}

// ---------- Token endpoint ----------

function aadError(status: number, error: string, code: number, text: string): Response {
  const trace = randomUUID(), corr = randomUUID();
  const ts = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
  const description = `AADSTS${code}: ${text}\r\nTrace ID: ${trace}\r\nCorrelation ID: ${corr}\r\nTimestamp: ${ts}`;
  return plainJson(
    { error, error_description: description, error_codes: [code], timestamp: ts, trace_id: trace, correlation_id: corr },
    status,
  );
}

function basicCredentials(req: Request): [string | undefined, string | undefined] {
  const h = req.headers.get("authorization") ?? "";
  if (h.toLowerCase().startsWith("basic ")) {
    const [id, ...secret] = Buffer.from(h.slice(6), "base64").toString().split(":");
    const dec = (v: string) => decodeURIComponent(v.replace(/\+/g, " "));
    return [dec(id), dec(secret.join(":"))];
  }
  return [undefined, undefined];
}

export interface TokenResult { response: Response; logBody: Record<string, string> }

export async function tokenEndpoint(s: Settings, base: string, ttl: number, tenant: string, req: Request): Promise<TokenResult> {
  const form = Object.fromEntries(new URLSearchParams(await req.text()));
  const [basicId, basicSecret] = basicCredentials(req);
  const clientId = form.client_id || basicId;
  const secret = form.client_secret || basicSecret;
  const out = (response: Response): TokenResult => ({ response, logBody: form });
  const missing = (p: string) => out(aadError(400, "invalid_request", 900144, `The request body must contain the following parameter: '${p}'.`));

  if (tenant !== s.tenantId) {
    return out(aadError(400, "invalid_request", 90002,
      `Tenant '${tenant}' not found. Check to make sure you have the correct tenant ID and are signing into the correct cloud.`));
  }
  if (!form.grant_type) return missing("grant_type");
  if (!clientId) return missing("client_id");
  if (form.grant_type !== "client_credentials") {
    return out(aadError(400, "unsupported_grant_type", 70003, "The app returned an unsupported grant type."));
  }
  if (clientId !== s.clientId) {
    return out(aadError(401, "invalid_client", 700016,
      `Application with identifier '${clientId}' was not found in the directory '${tenant}'. This can happen if the application has not been installed by the administrator of the tenant or consented to by any user in the tenant. You may have sent your authentication request to the wrong tenant.`));
  }
  if (!secret) return missing("client_secret");
  if (!safeEqual(secret, s.clientSecret)) {
    return out(aadError(401, "invalid_client", 7000215,
      `Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app '${clientId}'.`));
  }
  if (!form.scope) return missing("scope");
  const scopes = form.scope.split(/\s+/).filter(Boolean);
  if (scopes.length !== 1 || scopes[0] !== `${base}/.default`) {
    return out(aadError(400, "invalid_scope", 70011,
      `The provided value for the input parameter 'scope' isn't valid. The scope ${form.scope} isn't valid.`));
  }
  return out(plainJson({
    token_type: "Bearer",
    expires_in: ttl,
    ext_expires_in: ttl,
    access_token: makeToken(s, base, { ttl }),
  }));
}
