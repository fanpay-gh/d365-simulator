import { requireToken, tokenEndpoint } from "./auth.js";
import { dataverseRoute } from "./dataverse.js";
import { injectFaults, parseSpec } from "./faults.js";
import { DataverseError, dvErrorResponse, plainJson } from "./responses.js";
import { loadSchema, type Schema } from "./schema.js";
import { loadSettings, type Settings } from "./settings.js";
import { nowIso, Store, type MockConfig, type Persistence } from "./store.js";

const SENSITIVE = /secret|password|assertion|token|authorization/i;
const mask = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(mask)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SENSITIVE.test(k) ? "***" : mask(x)]))
      : v;

function maskHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    out[k] = k === "authorization" ? (v.includes(" ") ? `${v.split(" ")[0]} ${v.slice(v.indexOf(" ") + 1, v.indexOf(" ") + 11)}…(masked)` : "***") : v;
  });
  return out;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type ConfigKey = keyof MockConfig;
const CONFIG_CHECKS: Record<ConfigKey, (v: unknown) => boolean> = {
  fail: (v) => v === null || typeof v === "string",
  fail_rate: (v) => typeof v === "number" && v >= 0 && v <= 1,
  fail_pool: (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  delay_ms: (v) => Number.isInteger(v) && (v as number) >= 0,
  retry_after_seconds: (v) => Number.isInteger(v) && (v as number) >= 0,
  timeout_seconds: (v) => typeof v === "number" && v >= 0,
  token_ttl_seconds: (v) => v === null || Number.isInteger(v),
};

export function createHandler(
  settings: Settings = loadSettings(),
  schema: Schema = loadSchema(settings.schemaFile),
  persistence?: Persistence,
) {
  const store = new Store(settings, persistence);

  async function admin(req: Request, path: string, url: URL): Promise<Response> {
    const route = path.replace(/^\/_mock\/?/, "");
    const m = req.method;
    if (route === "" && m === "GET") return viewer();
    if (route === "records" && m === "GET") {
      const value = [...store.records.values()].map(({ _v, ...r }) => r);
      return plainJson({ count: value.length, value });
    }
    if (route === "requests" && m === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return plainJson({ count: store.requests.length, value: store.requests.slice(-limit).reverse() }); // más reciente primero
    }
    if (route === "reset" && m === "POST") {
      store.reset();
      return plainJson({ status: "reset" });
    }
    if (route === "config" && m === "GET") return plainJson(store.config);
    if (route === "config" && (m === "PATCH" || m === "PUT")) {
      let changes: Record<string, unknown>;
      try { changes = JSON.parse(await req.text()); } catch { return plainJson({ detail: "Invalid JSON body" }, 422); }
      for (const [k, v] of Object.entries(changes)) {
        if (!(k in CONFIG_CHECKS) || !CONFIG_CHECKS[k as ConfigKey](v)) return plainJson({ detail: `Invalid config field '${k}'` }, 422);
      }
      try {
        for (const spec of [changes.fail, ...((changes.fail_pool as string[]) ?? [])]) if (spec) parseSpec(spec as string);
      } catch (e) {
        return dvErrorResponse(e as DataverseError);
      }
      Object.assign(store.config, changes);
      return plainJson(store.config);
    }
    return plainJson({ detail: "Not Found" }, 404);
  }

  function viewer(): Response {
    const cols = [schema.primaryKey, "createdon", ...schema.fields.keys()];
    const head = cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
    const rows = [...store.records.values()]
      .map((r) => `<tr>${cols.map((c) => `<td>${escapeHtml(r[c] == null ? "" : String(r[c]))}</td>`).join("")}</tr>`)
      .join("") || `<tr><td colspan="${cols.length}"><em>Sin registros</em></td></tr>`;
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5">
<title>D365 mock</title><style>body{font:14px system-ui;margin:2rem}table{border-collapse:collapse}
th,td{border:1px solid #ccc;padding:4px 8px;text-align:left}th{background:#f3f3f3}</style></head><body>
<h1>D365 mock · ${escapeHtml(schema.entitySet)} (${store.records.size})</h1>
<p><a href="/_mock/records">records</a> · <a href="/_mock/requests">requests</a> ·
<a href="/_mock/config">config</a> · POST /_mock/reset</p>
<table><tr>${head}</tr>${rows}</table></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/_mock" || path.startsWith("/_mock/")) return admin(req, path, url);

    const base = settings.baseUrl ?? url.origin;
    const started = performance.now();
    let status: number | "aborted" = "aborted";
    let logBody: unknown = null;
    let fault: string | null = null;
    try {
      let response: Response;
      const tokenMatch = /^\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(path);
      if (tokenMatch) {
        if (req.method !== "POST") response = plainJson({ detail: "Method Not Allowed" }, 405);
        else {
          const r = await tokenEndpoint(settings, base, store.tokenTtl, decodeURIComponent(tokenMatch[1]), req);
          logBody = r.logBody;
          response = r.response;
        }
      } else if (path === "/api/data/v9.2" || path.startsWith("/api/data/v9.2/")) {
        try {
          await injectFaults(req, settings, base, store.config, schema, (s) => (fault = s));
          requireToken(settings, base, req);
          response = await dataverseRoute(
            { req, url, base, tenantId: settings.tenantId, schema, store, setLogBody: (b) => (logBody = b) },
            path.slice("/api/data/v9.2/".length),
          );
        } catch (e) {
          if (!(e instanceof DataverseError)) throw e;
          response = dvErrorResponse(e);
        }
      } else {
        response = plainJson({ detail: "Not Found" }, 404);
      }
      status = response.status;
      return response;
    } finally {
      store.log({
        timestamp: nowIso(), method: req.method, path, query: url.search.replace(/^\?/, ""),
        headers: maskHeaders(req), body: mask(logBody), fault, status,
        duration_ms: Math.round((performance.now() - started) * 10) / 10,
      });
    }
  }

  async function handle(req: Request): Promise<Response> {
    await store.hydrate();
    try {
      return await route(req);
    } finally {
      await store.flush();
    }
  }

  return Object.assign(handle, { store, settings, schema });
}
