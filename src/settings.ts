import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Settings {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Si es null, se usa el origen de cada petición (https://<sitio>.netlify.app). */
  baseUrl: string | null;
  tokenTtlSeconds: number;
  signingKey: string;
  schemaFile: string;
  requestLogMax: number;
}

/** schema.yaml viaja con la función (included_files); según el runtime vive en distintas raíces. */
function findSchema(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const roots = [process.env.LAMBDA_TASK_ROOT, process.cwd(), path.resolve(here, ".."), path.resolve(here, "../..")];
  for (const root of roots) {
    if (root && existsSync(path.join(root, "schema.yaml"))) return path.join(root, "schema.yaml");
  }
  return path.resolve(here, "../schema.yaml");
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const base = env.MOCK_BASE_URL?.replace(/\/+$/, "");
  return {
    tenantId: env.MOCK_TENANT_ID ?? "11111111-1111-1111-1111-111111111111",
    clientId: env.MOCK_CLIENT_ID ?? "22222222-2222-2222-2222-222222222222",
    clientSecret: env.MOCK_CLIENT_SECRET ?? "mock-client-secret",
    baseUrl: base || null,
    tokenTtlSeconds: Number(env.TOKEN_TTL_SECONDS ?? 3600),
    signingKey: env.MOCK_SIGNING_KEY ?? "d365-simulator-signing-key",
    schemaFile: env.MOCK_SCHEMA_FILE ?? findSchema(),
    requestLogMax: Number(env.MOCK_REQUEST_LOG_MAX ?? 200),
  };
}
