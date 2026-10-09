import { unauthorized } from "./auth.js";
import { DataverseError } from "./responses.js";
import type { Schema } from "./schema.js";
import type { Settings } from "./settings.js";
import type { MockConfig } from "./store.js";

const STATUS_FAULTS = new Set(["401", "403", "404", "429", "500", "503"]);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Fault = { kind: string; ms?: number };

export function parseSpec(spec: string): Fault {
  const s = spec.trim().toLowerCase();
  if (STATUS_FAULTS.has(s) || s === "timeout") return { kind: s };
  const m = /^slow[:=](\d+)$/.exec(s);
  if (m) return { kind: "slow", ms: Number(m[1]) };
  throw new DataverseError(400, `Invalid X-Mock-Fail value '${s}'. Use 401, 403, 404, 429, 500, 503, slow:<ms> or timeout.`);
}

function faultError(kind: string, s: Settings, base: string, cfg: MockConfig, schema: Schema, method: string): DataverseError {
  // Status verificados en la documentación; códigos hex y mensajes de 403/404/500/503 son aproximados.
  switch (kind) {
    case "401": return unauthorized(s, base, "Injected fault: unauthorized.");
    case "403": {
      const verb = ({ GET: "Read", POST: "Create", PATCH: "Write", DELETE: "Delete" } as Record<string, string>)[method] ?? "Read";
      const entity = schema.logicalName[0].toUpperCase() + schema.logicalName.slice(1);
      return new DataverseError(403, `Principal user is missing prv${verb}${entity} privilege.`, "0x80040220");
    }
    case "404": return new DataverseError(404, "Injected fault: resource not found.", "0x80040217");
    case "429":
      // Código y mensaje de 0x80072322 y header Retry-After (segundos) verificados.
      return new DataverseError(429, "Number of requests exceeded the limit of 6000 over time window of 300 seconds.",
        "0x80072322", { "Retry-After": String(cfg.retry_after_seconds) });
    case "500": return new DataverseError(500, "An unexpected error occurred.", "0x80040216");
    default: return new DataverseError(503, "The service is temporarily unavailable.", "");
  }
}

/** Aplica la falla pedida por header, config global o azar. Devuelve el spec aplicado (para el log). */
export async function injectFaults(
  req: Request, s: Settings, base: string, cfg: MockConfig, schema: Schema, onFault: (spec: string) => void,
): Promise<void> {
  if (cfg.delay_ms) await sleep(cfg.delay_ms);
  let spec = req.headers.get("x-mock-fail") || cfg.fail;
  if (!spec && cfg.fail_rate > 0 && cfg.fail_pool.length && Math.random() < cfg.fail_rate) {
    spec = cfg.fail_pool[Math.floor(Math.random() * cfg.fail_pool.length)];
  }
  if (!spec) return;
  const fault = parseSpec(spec);
  onFault(spec);
  if (fault.kind === "slow") await sleep(fault.ms!);
  else if (fault.kind === "timeout") {
    await sleep(cfg.timeout_seconds * 1000);
    throw new DataverseError(504, "Injected fault: timeout.", "");
  } else throw faultError(fault.kind, s, base, cfg, schema, req.method);
}
