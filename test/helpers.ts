import { createHandler } from "../src/app.js";
import { makeToken } from "../src/auth.js";
import { loadSettings, type Settings } from "../src/settings.js";

export const BASE = "http://testserver";
export const API = `${BASE}/api/data/v9.2`;
export const VALID_LEAD = {
  firstname: "Ada", lastname: "Lovelace", subject: "Consulta", emailaddress1: "ada@example.com",
  description: "Hola", new_inquirytype: 100000001,
};

export function setup(overrides: Partial<Settings> = {}) {
  const settings = { ...loadSettings({}), baseUrl: BASE, tokenTtlSeconds: 3600, ...overrides };
  const handle = createHandler(settings);
  const tokenUrl = `${BASE}/${settings.tenantId}/oauth2/v2.0/token`;

  const call = (url: string, init: RequestInit & { json?: unknown } = {}) => {
    const { json, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (json !== undefined) { rest.body = JSON.stringify(json); headers.set("content-type", "application/json"); }
    return handle(new Request(url, { ...rest, headers }));
  };

  const form = (o: Record<string, string | null> = {}) => {
    const data: Record<string, string | null> = {
      grant_type: "client_credentials", client_id: settings.clientId,
      client_secret: settings.clientSecret, scope: `${BASE}/.default`, ...o,
    };
    return new URLSearchParams(Object.entries(data).filter(([, v]) => v !== null) as [string, string][]).toString();
  };
  const postToken = (o: Record<string, string | null> = {}, headers: Record<string, string> = {}) =>
    call(tokenUrl, { method: "POST", body: form(o), headers: { "content-type": "application/x-www-form-urlencoded", ...headers } });

  const token = async () => (await (await postToken()).json()).access_token as string;
  const auth = async (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${await token()}`, ...extra });
  const patchConfig = (json: unknown) => call(`${BASE}/_mock/config`, { method: "PATCH", json });
  const mint = (o: Parameters<typeof makeToken>[2]) => makeToken(settings, BASE, o);

  return { settings, handle, call, form, postToken, token, auth, tokenUrl, patchConfig, mint };
}
