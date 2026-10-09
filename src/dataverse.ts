import { randomUUID } from "node:crypto";

import { DataverseError, dvJson } from "./responses.js";
import { GUID_RE, validate, type Schema } from "./schema.js";
import { nowIso, type DbRecord, type Store } from "./store.js";

const SEGMENT_RE = /^([A-Za-z_]\w*)(?:\(([^()]*)\))?$/;
const CLAUSE_RE = /^\s*(\w+)\s+eq\s+(.+?)\s*$/i;

const bad = (message: string) => new DataverseError(400, message, "0x0");
const notFoundSegment = (segment: string) => new DataverseError(404, `Resource not found for the segment '${segment}'.`, "0x8006088a");

const wantsRepresentation = (req: Request) =>
  (req.headers.get("prefer") ?? "").split(",").map((p) => p.trim().toLowerCase()).includes("return=representation");

function parseSelect(url: URL, schema: Schema): string[] | null {
  const raw = url.searchParams.get("$select");
  if (!raw) return null;
  const cols = raw.split(",").map((c) => c.trim()).filter(Boolean);
  for (const c of cols) {
    if (!schema.readable.has(c)) throw bad(`Could not find a property named '${c}' on type '${schema.typeName}'.`);
  }
  return cols;
}

function project(record: DbRecord, schema: Schema, select: string[] | null): Record<string, unknown> {
  const cols = select === null ? [...schema.fields.keys(), "createdon", "modifiedon"] : select.filter((c) => c !== schema.primaryKey);
  const out: Record<string, unknown> = {};
  for (const c of cols) out[c] = record[c] ?? null;
  out[schema.primaryKey] = record[schema.primaryKey];
  return out;
}

const context = (base: string, schema: Schema, select: string[] | null) =>
  `${base}/api/data/v9.2/$metadata#${schema.entitySet}${select?.length ? `(${select.join(",")})` : ""}`;

const etag = (r: DbRecord) => `W/"${r._v}"`;
const entity = (r: DbRecord, schema: Schema, select: string[] | null, base: string) =>
  ({ "@odata.context": `${context(base, schema, select)}/$entity`, "@odata.etag": etag(r), ...project(r, schema, select) });
const entityId = (base: string, schema: Schema, id: string) => `${base}/api/data/v9.2/${schema.entitySet}(${id})`;

function parseLiteral(text: string): string | number | boolean | null {
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  const low = text.toLowerCase();
  if (low === "true" || low === "false") return low === "true";
  if (low === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  throw bad(`Unsupported $filter literal '${text}'.`);
}

function parseFilter(raw: string, schema: Schema): [string, unknown][] {
  return raw.split(/\s+and\s+/i).map((clause) => {
    const m = CLAUSE_RE.exec(clause);
    if (!m) throw bad(`Unsupported $filter expression '${clause}'. The mock only supports '<field> eq <value>' joined by 'and'.`);
    if (!schema.readable.has(m[1])) throw bad(`Could not find a property named '${m[1]}' on type '${schema.typeName}'.`);
    return [m[1], parseLiteral(m[2])];
  });
}

function matches(record: DbRecord, conds: [string, unknown][]): boolean {
  return conds.every(([field, expected]) => {
    const actual = record[field] ?? null;
    return typeof actual === "string" && typeof expected === "string"
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  });
}

function whoami(base: string, tenantId: string): Response {
  // GUIDs deterministas derivados del tenant (aproximado: el formato de WhoAmI no se verificó).
  const derive = (name: string) => {
    const h = [...(tenantId + name)].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, "0");
    return `${h}-0000-4000-8000-${(h + h + h).slice(0, 12)}`;
  };
  return dvJson({
    "@odata.context": `${base}/api/data/v9.2/$metadata#Microsoft.Dynamics.CRM.WhoAmIResponse`,
    BusinessUnitId: derive("businessunit"),
    UserId: derive("user"),
    OrganizationId: derive("organization"),
  });
}

export interface DvContext {
  req: Request;
  url: URL;
  base: string;
  tenantId: string;
  schema: Schema;
  store: Store;
  setLogBody: (b: unknown) => void;
}

async function jsonBody(c: DvContext): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    throw bad("Invalid JSON. The request body could not be parsed.");
  }
  c.setLogBody(body);
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw bad("Invalid JSON. The request body must be a JSON object.");
  return body as Record<string, unknown>;
}

export async function dataverseRoute(c: DvContext, rest: string): Promise<Response> {
  const { req, url, base, schema, store } = c;
  const method = req.method;
  const noRoute = () => new DataverseError(404, `No HTTP resource was found that matches the request URI '${base}/api/data/v9.2/${rest}'.`, "0x0");

  if (rest === "" || rest.includes("/")) throw noRoute();
  const segment = decodeURIComponent(rest);
  const m = SEGMENT_RE.exec(segment);
  if (!m) throw notFoundSegment(segment);
  const [, name, key] = m;
  const hasKey = segment.includes("(") && key !== "";

  if (name === "WhoAmI") {
    if (method !== "GET" || segment.includes("(") && key) throw noRoute();
    return whoami(base, c.tenantId);
  }
  if (name !== schema.entitySet) throw notFoundSegment(name);
  if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method)) throw noRoute();

  const select = parseSelect(url, schema);
  const pk = schema.primaryKey;

  // ---- colección: /leads ----
  if (!hasKey) {
    if (method === "GET") {
      const filter = url.searchParams.get("$filter");
      const conds = filter !== null ? parseFilter(filter, schema) : [];
      let rows = [...store.records.values()].filter((r) => matches(r, conds));
      const top = url.searchParams.get("$top");
      if (top !== null) {
        if (!/^\d+$/.test(top)) throw bad(`Invalid value '${top}' for $top query option.`);
        rows = rows.slice(0, Number(top));
      }
      return dvJson({
        "@odata.context": context(base, schema, select),
        value: rows.map((r) => ({ "@odata.etag": etag(r), ...project(r, schema, select) })),
      });
    }
    if (method === "POST") {
      const body = await jsonBody(c);
      validate(schema, body, true);
      const id = ((body[pk] as string | undefined) ?? randomUUID()).toLowerCase();
      if (store.records.has(id)) throw new DataverseError(412, `A record with the same primary key '${id}' already exists.`, "0x80040237");
      const ts = nowIso();
      const record: DbRecord = { _v: 1 } as DbRecord;
      for (const f of schema.fields.keys()) record[f] = null;
      for (const [k, v] of Object.entries(body)) if (k !== pk) record[k] = v;
      Object.assign(record, { [pk]: id, createdon: ts, modifiedon: ts });
      store.records.set(id, record);
      if (wantsRepresentation(req)) return dvJson(entity(record, schema, select, base), 201, { "Preference-Applied": "return=representation" });
      return new Response(null, { status: 204, headers: { "OData-Version": "4.0", "OData-EntityId": entityId(base, schema, id) } });
    }
    throw new DataverseError(405, `The HTTP method '${method}' is not allowed on the collection '${schema.entitySet}'.`, "0x0");
  }

  // ---- registro: /leads({id}) ----
  if (!GUID_RE.test(key)) throw bad("Unrecognized Guid format.");
  const id = key.toLowerCase();
  const record = store.records.get(id);
  if (!record) throw new DataverseError(404, `${schema.logicalName} With Id = ${id} Does Not Exist`, "0x80040217");

  if (method === "GET") return dvJson(entity(record, schema, select, base));
  if (method === "PATCH") {
    const body = await jsonBody(c);
    validate(schema, body, false);
    if (pk in body && String(body[pk]).toLowerCase() !== id) throw bad(`The primary key '${pk}' in the payload does not match the key in the URL.`);
    for (const [k, v] of Object.entries(body)) if (k !== pk) record[k] = v;
    record.modifiedon = nowIso();
    record._v += 1;
    if (wantsRepresentation(req)) return dvJson(entity(record, schema, select, base), 200, { "Preference-Applied": "return=representation" });
    return new Response(null, { status: 204, headers: { "OData-Version": "4.0", "OData-EntityId": entityId(base, schema, id) } });
  }
  if (method === "DELETE") {
    store.records.delete(id);
    return new Response(null, { status: 204, headers: { "OData-Version": "4.0" } });
  }
  throw new DataverseError(405, `The HTTP method '${method}' is not allowed on this resource.`, "0x0");
}
