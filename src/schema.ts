import { readFileSync } from "node:fs";
import { parse } from "yaml";

import { DataverseError } from "./responses.js";

export type FieldType = "string" | "memo" | "optionset" | "boolean" | "datetime";
const TYPES: FieldType[] = ["string", "memo", "optionset", "boolean", "datetime"];
export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Field {
  name: string;
  type: FieldType;
  required: boolean;
  maxLength?: number;
  options: Set<number>;
}

export interface Schema {
  entitySet: string;
  logicalName: string;
  primaryKey: string;
  fields: Map<string, Field>;
  typeName: string;
  readable: Set<string>;
}

export function loadSchema(file: string): Schema {
  const raw = parse(readFileSync(file, "utf8")).entity;
  const fields = new Map<string, Field>();
  for (const [name, spec] of Object.entries<any>(raw.fields)) {
    if (!TYPES.includes(spec.type)) throw new Error(`schema: campo '${name}' con tipo desconocido '${spec.type}'`);
    fields.set(name, {
      name,
      type: spec.type,
      required: Boolean(spec.required),
      maxLength: spec.max_length,
      options: new Set(Object.keys(spec.options ?? {}).map(Number)),
    });
  }
  return {
    entitySet: raw.entity_set,
    logicalName: raw.logical_name,
    primaryKey: raw.primary_key,
    fields,
    typeName: `Microsoft.Dynamics.CRM.${raw.logical_name}`,
    readable: new Set([...fields.keys(), raw.primary_key, "createdon", "modifiedon"]),
  };
}

// Código 0x0 verificado para errores de validación de entrada; los mensajes son aproximados.
const bad = (message: string) => new DataverseError(400, message, "0x0");

export function validate(schema: Schema, body: Record<string, unknown>, creating: boolean): void {
  for (const [key, value] of Object.entries(body)) {
    if (key === schema.primaryKey) {
      if (typeof value !== "string" || !GUID_RE.test(value)) throw bad(`Unrecognized Guid format for property '${key}'.`);
      continue;
    }
    const f = schema.fields.get(key);
    if (!f) {
      throw bad(`An error occurred while validating input parameters: Invalid property '${key}' was found in entity '${schema.typeName}'.`);
    }
    if (value === null) {
      if (f.required) throw bad(`The attribute '${key}' of the '${schema.logicalName}' entity is required and cannot be null.`);
      continue;
    }
    checkValue(schema, f, value);
  }
  if (creating) {
    for (const f of schema.fields.values()) {
      if (f.required && (body[f.name] === undefined || body[f.name] === null)) {
        throw bad(`The attribute '${f.name}' of the '${schema.logicalName}' entity is required.`);
      }
    }
  }
}

const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function checkValue(schema: Schema, f: Field, value: unknown): void {
  switch (f.type) {
    case "string":
    case "memo":
      if (typeof value !== "string") throw bad(`Property '${f.name}' expects a string value but got ${kind(value)}.`);
      if (f.maxLength !== undefined && value.length > f.maxLength) {
        throw bad(`The length of the '${f.name}' attribute of the '${schema.logicalName}' entity exceeded the maximum allowed length of '${f.maxLength}'.`);
      }
      break;
    case "optionset":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw bad(`Property '${f.name}' expects an integer option value but got ${kind(value)}.`);
      }
      if (!f.options.has(value)) throw bad(`The option value ${value} is not valid for the attribute '${f.name}'.`);
      break;
    case "boolean":
      if (typeof value !== "boolean") throw bad(`Property '${f.name}' expects a boolean value but got ${kind(value)}.`);
      break;
    case "datetime":
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value) || Number.isNaN(Date.parse(value))) {
        throw bad(`Property '${f.name}' expects an ISO 8601 datetime string.`);
      }
      break;
  }
}
