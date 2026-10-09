import { describe, expect, it } from "vitest";

import { API, BASE, setup, VALID_LEAD } from "./helpers.js";

describe("inyección de fallas", () => {
  it.each([401, 403, 404, 429, 500, 503])("header X-Mock-Fail: %i", async (status) => {
    const t = setup();
    const r = await t.call(`${API}/WhoAmI`, { headers: await t.auth({ "x-mock-fail": String(status) }) });
    expect(r.status).toBe(status);
    const b = await r.json();
    expect(Object.keys(b.error).sort()).toEqual(["code", "message"]);
    if (status === 429) {
      expect(r.headers.get("retry-after")).toBe("5");
      expect(b.error.code).toBe("0x80072322");
    }
    if (status === 401) expect(r.headers.get("www-authenticate")).toMatch(/^Bearer /);
  });

  it("aplica aunque no haya token", async () => {
    expect((await setup().call(`${API}/WhoAmI`, { headers: { "x-mock-fail": "503" } })).status).toBe(503);
  });

  it("Retry-After configurable", async () => {
    const t = setup();
    await t.patchConfig({ retry_after_seconds: 42 });
    const r = await t.call(`${API}/WhoAmI`, { headers: await t.auth({ "x-mock-fail": "429" }) });
    expect(r.headers.get("retry-after")).toBe("42");
  });

  it("slow, delay global y timeout", async () => {
    const t = setup();
    const h = await t.auth();
    let s = performance.now();
    expect((await t.call(`${API}/WhoAmI`, { headers: { ...h, "x-mock-fail": "slow:250" } })).status).toBe(200);
    expect(performance.now() - s).toBeGreaterThanOrEqual(240);

    await t.patchConfig({ delay_ms: 200 });
    s = performance.now();
    expect((await t.call(`${API}/WhoAmI`, { headers: h })).status).toBe(200);
    expect(performance.now() - s).toBeGreaterThanOrEqual(190);
    await t.patchConfig({ delay_ms: 0, timeout_seconds: 0.2 });

    s = performance.now();
    expect((await t.call(`${API}/WhoAmI`, { headers: { ...h, "x-mock-fail": "timeout" } })).status).toBe(504);
    expect(performance.now() - s).toBeGreaterThanOrEqual(190);
  });

  it("valores inválidos", async () => {
    const t = setup();
    expect((await t.call(`${API}/WhoAmI`, { headers: await t.auth({ "x-mock-fail": "banana" }) })).status).toBe(400);
    expect((await t.patchConfig({ fail: "banana" })).status).toBe(400);
    expect((await t.patchConfig({ fail_rate: 2 })).status).toBe(422);
    expect((await t.patchConfig({ desconocido: 1 })).status).toBe(422);
  });

  it("falla global y reset", async () => {
    const t = setup();
    const h = await t.auth();
    expect((await (await t.patchConfig({ fail: "500" })).json()).fail).toBe("500");
    expect((await t.call(`${API}/WhoAmI`, { headers: h })).status).toBe(500);
    await t.call(`${BASE}/_mock/reset`, { method: "POST" });
    expect((await (await t.call(`${BASE}/_mock/config`)).json()).fail).toBeNull();
    expect((await t.call(`${API}/WhoAmI`, { headers: h })).status).toBe(200);
  });

  it("modo probabilístico", async () => {
    const t = setup();
    const h = await t.auth();
    await t.patchConfig({ fail_rate: 1, fail_pool: ["503"] });
    for (let i = 0; i < 5; i++) expect((await t.call(`${API}/WhoAmI`, { headers: h })).status).toBe(503);
    await t.patchConfig({ fail_rate: 0 });
    expect((await t.call(`${API}/WhoAmI`, { headers: h })).status).toBe(200);
  });

  it("una falla no persiste el registro", async () => {
    const t = setup();
    await t.call(`${API}/leads`, { method: "POST", json: VALID_LEAD, headers: await t.auth({ "x-mock-fail": "500" }) });
    expect((await (await t.call(`${BASE}/_mock/records`)).json()).count).toBe(0);
  });
});

describe("admin", () => {
  it("records, requests y enmascarado", async () => {
    const t = setup();
    const tok = await t.token();
    await t.call(`${API}/leads`, { method: "POST", json: VALID_LEAD, headers: { authorization: `Bearer ${tok}`, "x-mock-fail": "slow:1" } });

    const records = await (await t.call(`${BASE}/_mock/records`)).json();
    expect(records.count).toBe(1);
    expect(records.value[0].lastname).toBe("Lovelace");
    expect(Object.keys(records.value[0]).some((k) => k.startsWith("_"))).toBe(false);

    const log = (await (await t.call(`${BASE}/_mock/requests`)).json()).value;
    expect(log.slice(0, 2).map((e: any) => e.path)).toEqual([`/api/data/v9.2/leads`, `/${t.settings.tenantId}/oauth2/v2.0/token`]);
    expect(log[1].body.client_secret).toBe("***");
    expect(log[1].body.client_id).toBe(t.settings.clientId);
    const dump = JSON.stringify(log);
    expect(dump).not.toContain(t.settings.clientSecret);
    expect(dump).not.toContain(tok);
    expect(log[0].headers.authorization).toMatch(/\(masked\)$/);
    expect(log[0].fault).toBe("slow:1");

    expect(await (await t.call(`${BASE}/_mock/reset`, { method: "POST" })).json()).toEqual({ status: "reset" });
    expect((await (await t.call(`${BASE}/_mock/records`)).json()).count).toBe(0);
    expect((await (await t.call(`${BASE}/_mock/requests`)).json()).count).toBe(0);
  });

  it("visor HTML escapa contenido", async () => {
    const t = setup();
    await t.call(`${API}/leads`, { method: "POST", json: { ...VALID_LEAD, lastname: "<b>x</b>" }, headers: await t.auth() });
    const r = await t.call(`${BASE}/_mock/`);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("&#60;b&#62;x");
    expect(html).not.toContain("<b>x");
  });

  it("base URL toma el origen de la petición si MOCK_BASE_URL no está definida", async () => {
    const t = setup({ baseUrl: null });
    const origin = "https://mi-mock.netlify.app";
    const r = await t.call(`${origin}/${t.settings.tenantId}/oauth2/v2.0/token`, {
      method: "POST", body: t.form({ scope: `${origin}/.default` }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(r.status).toBe(200);
    const tok = (await r.json()).access_token;
    const created = await t.call(`${origin}/api/data/v9.2/leads`, { method: "POST", json: VALID_LEAD, headers: { authorization: `Bearer ${tok}` } });
    expect(created.headers.get("odata-entityid")).toMatch(/^https:\/\/mi-mock\.netlify\.app\/api\/data\/v9\.2\/leads\(/);
  });
});

describe("tipos boolean y datetime", () => {
  it("valida con un esquema alternativo", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/d365-`);
    writeFileSync(`${dir}/s.yaml`, `
entity:
  entity_set: leads
  logical_name: lead
  primary_key: leadid
  fields:
    lastname: {type: string}
    new_consent: {type: boolean}
    new_callbackat: {type: datetime}
    new_kind: {type: optionset, options: {1: A}}
`);
    const t = setup({ schemaFile: `${dir}/s.yaml` });
    const h = await t.auth();
    const post = async (json: unknown) => (await t.call(`${API}/leads`, { method: "POST", json, headers: h })).status;
    expect(await post({ lastname: "x", new_consent: true, new_callbackat: "2026-10-09T12:00:00Z", new_kind: 1 })).toBe(204);
    expect(await post({ new_consent: "yes" })).toBe(400);
    expect(await post({ new_consent: 1 })).toBe(400);
    expect(await post({ new_callbackat: "mañana" })).toBe(400);
    expect(await post({ new_kind: true })).toBe(400);
    expect(await post({})).toBe(204);
  });
});

describe("persistencia externa (Netlify Blobs)", () => {
  it("el estado sobrevive entre instancias del handler", async () => {
    const { createHandler } = await import("../src/app.js");
    let saved: any = null; // simula el blob compartido
    const persistence = { load: async () => saved, save: async (s: any) => { saved = structuredClone(s); } };
    const base = setup();
    const mk = () => createHandler(base.settings, undefined, persistence);
    const post = (h: ReturnType<typeof mk>, url: string, init: RequestInit) => h(new Request(url, init));

    const a = mk();
    const tok = (await (await post(a, base.tokenUrl, {
      method: "POST", body: base.form(), headers: { "content-type": "application/x-www-form-urlencoded" },
    })).json()).access_token;
    const created = await post(a, `${API}/leads`, {
      method: "POST", body: JSON.stringify(VALID_LEAD), headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    });
    const id = /\(([^)]+)\)/.exec(created.headers.get("odata-entityid")!)![1];
    await post(a, `${BASE}/_mock/config`, { method: "PATCH", body: JSON.stringify({ retry_after_seconds: 9 }) });

    const b = mk(); // otra instancia, otra memoria
    const got = await post(b, `${API}/leads(${id})`, { headers: { authorization: `Bearer ${tok}` } });
    expect(got.status).toBe(200);
    expect((await got.json()).lastname).toBe("Lovelace");
    expect((await (await post(b, `${BASE}/_mock/config`, {})).json()).retry_after_seconds).toBe(9);
    expect((await (await post(b, `${BASE}/_mock/requests`, {})).json()).count).toBe(3);
  });
});
