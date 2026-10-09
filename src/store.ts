import type { Settings } from "./settings.js";

export interface MockConfig {
  fail: string | null;
  fail_rate: number;
  fail_pool: string[];
  delay_ms: number;
  retry_after_seconds: number;
  timeout_seconds: number;
  token_ttl_seconds: number | null;
}

const defaults = (): MockConfig => ({
  fail: null,               // falla global: "401", "slow:500", "timeout"...
  fail_rate: 0,             // modo probabilístico: probabilidad 0..1
  fail_pool: ["500", "503", "429"],
  delay_ms: 0,              // retardo extra en todas las respuestas de Dataverse
  retry_after_seconds: 5,   // valor de Retry-After en 429
  timeout_seconds: 60,      // cuánto se queda colgada la falla "timeout"
  token_ttl_seconds: null,  // null -> TOKEN_TTL_SECONDS del entorno
});

export type DbRecord = Record<string, unknown> & { _v: number };

export interface LogEntry {
  timestamp: string;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: unknown;
  fault: string | null;
  status: number | "aborted";
  duration_ms: number;
}

export interface State {
  records: Record<string, DbRecord>;
  requests: LogEntry[];
  config: Partial<MockConfig>;
}

/** Almacén externo del estado (Netlify Blobs). Sin él, el estado vive solo en memoria de la instancia. */
export interface Persistence {
  load(): Promise<State | null>;
  save(state: State): Promise<void>;
}

/** Registros, log de requests y configuración en runtime. Con `persistence`, se rehidrata y se guarda en cada request. */
export class Store {
  records = new Map<string, DbRecord>();
  requests: LogEntry[] = [];
  config = defaults();

  constructor(private settings: Settings, private persistence?: Persistence) {}

  async hydrate(): Promise<void> {
    if (!this.persistence) return;
    try {
      const s = await this.persistence.load();
      if (!s) return;
      this.records = new Map(Object.entries(s.records ?? {}));
      this.requests = s.requests ?? [];
      this.config = { ...defaults(), ...s.config };
    } catch (e) {
      console.error("No se pudo cargar el estado:", e);
    }
  }

  async flush(): Promise<void> {
    if (!this.persistence) return;
    try {
      await this.persistence.save({ records: Object.fromEntries(this.records), requests: this.requests, config: this.config });
    } catch (e) {
      console.error("No se pudo guardar el estado:", e);
    }
  }

  reset(): void {
    this.records.clear();
    this.requests = [];
    this.config = defaults();
  }

  log(entry: LogEntry): void {
    this.requests.push(entry);
    if (this.requests.length > this.settings.requestLogMax) this.requests.shift();
  }

  get tokenTtl(): number {
    return this.config.token_ttl_seconds ?? this.settings.tokenTtlSeconds;
  }
}

export const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
