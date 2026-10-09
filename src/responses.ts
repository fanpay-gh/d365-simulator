const MEDIA = "application/json; odata.metadata=minimal";

/** Error con el formato de Dataverse: {"error": {"code", "message"}}. */
export class DataverseError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "0x0",
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function dvJson(content: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(content), {
    status,
    headers: { "content-type": MEDIA, "OData-Version": "4.0", ...headers },
  });
}

export function dvErrorResponse(e: DataverseError): Response {
  return dvJson({ error: { code: e.code, message: e.message } }, e.status, e.headers);
}

export function plainJson(content: unknown, status = 200): Response {
  return new Response(JSON.stringify(content), { status, headers: { "content-type": "application/json" } });
}
