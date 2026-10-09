import { describe, expect, it } from "vitest";

import { API, BASE, setup, VALID_LEAD } from "./helpers.js";

describe("tres llamadas: token -> crear lead -> leerlo", () => {
  it("funciona de punta a punta", async () => {
    const t = setup();
    const r = await t.postToken();
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, ext_expires_in: 3600 });
    const h = { authorization: `Bearer ${body.access_token}` };

    const created = await t.call(`${API}/leads`, { method: "POST", json: VALID_LEAD, headers: h });
    expect(created.status).toBe(204);
    expect(await created.text()).toBe("");
    const entityId = created.headers.get("odata-entityid")!;
    const id = new RegExp(`^${BASE}/api/data/v9.2/leads\\(([0-9a-f-]{36})\\)$`).exec(entityId)![1];
    expect(created.headers.get("odata-version")).toBe("4.0");

    const got = await t.call(`${API}/leads(${id})`, { headers: h });
    expect(got.status).toBe(200);
    const lead = await got.json();
    expect(lead.leadid).toBe(id);
    expect(lead).toMatchObject(VALID_LEAD);
    expect(lead["@odata.context"]).toMatch(/\/\$metadata#leads\/\$entity$/);
  });

  it("claims del JWT", async () => {
    const t = setup();
    const claims = JSON.parse(Buffer.from((await t.token()).split(".")[1], "base64url").toString());
    expect(claims).toMatchObject({ aud: BASE, tid: t.settings.tenantId, appid: t.settings.clientId });
    expect(claims.exp - claims.iat).toBe(3600);
    expect(claims.iss).toBe(`https://sts.windows.net/${t.settings.tenantId}/`);
  });
});

describe("token endpoint: errores", () => {
  it.each([
    [{ client_secret: "nope" }, 401, "invalid_client", 7000215],
    [{ client_id: "00000000-0000-0000-0000-000000000000" }, 401, "invalid_client", 700016],
    [{ scope: "https://other.example/.default" }, 400, "invalid_scope", 70011],
    [{ grant_type: "password" }, 400, "unsupported_grant_type", 70003],
    [{ client_secret: null }, 400, "invalid_request", 900144],
  ])("%j", async (overrides, status, error, code) => {
    const r = await setup().postToken(overrides as Record<string, string | null>);
    expect(r.status).toBe(status);
    const b = await r.json();
    expect(b.error).toBe(error);
    expect(b.error_codes).toEqual([code]);
    expect(b.error_description).toMatch(new RegExp(`^AADSTS${code}:`));
    expect(b.error_description).toContain("Trace ID:");
    expect(Object.keys(b)).toEqual(expect.arrayContaining(["timestamp", "trace_id", "correlation_id"]));
  });

  it("tenant inexistente", async () => {
    const t = setup();
    const r = await t.call(`${BASE}/no-such-tenant/oauth2/v2.0/token`, { method: "POST", body: t.form() });
    expect(r.status).toBe(400);
    expect((await r.json()).error_codes).toEqual([90002]);
  });

  it("TTL configurable, expiración y refresh", async () => {
    const t = setup();
    await t.patchConfig({ token_ttl_seconds: 0 });
    const expired = await (await t.postToken()).json();
    expect(expired.expires_in).toBe(0);
    const r = await t.call(`${API}/WhoAmI`, { headers: { authorization: `Bearer ${expired.access_token}` } });
    expect(r.status).toBe(401);
    expect((await r.json()).error.message).toContain("token expired");
    expect(r.headers.get("www-authenticate")).toMatch(/^Bearer /);

    await t.patchConfig({ token_ttl_seconds: 60 });
    expect((await t.call(`${API}/WhoAmI`, { headers: await t.auth() })).status).toBe(200);
  });

  it("Basic auth", async () => {
    const t = setup();
    const cred = Buffer.from(`${t.settings.clientId}:${t.settings.clientSecret}`).toString("base64");
    const r = await t.postToken({ client_id: null, client_secret: null }, { authorization: `Basic ${cred}` });
    expect(r.status).toBe(200);
  });
});

describe("Dataverse: autenticación", () => {
  it("rechaza tokens inválidos", async () => {
    const t = setup();
    const bad: Record<string, string>[] = [
      {},
      { authorization: "Basic abc" },
      { authorization: "Bearer garbage" },
      { authorization: `Bearer ${t.mint({ ttl: -10 })}` },
      { authorization: `Bearer ${t.mint({ ttl: 3600, aud: "https://other.example" })}` },
      { authorization: `Bearer ${t.mint({ ttl: 3600, tid: "x" })}` },
      { authorization: `Bearer ${(await t.token()).slice(0, -2)}xx` },
    ];
    for (const headers of bad) {
      const r = await t.call(`${API}/WhoAmI`, { headers });
      expect(r.status, JSON.stringify(headers)).toBe(401);
      expect(r.headers.get("www-authenticate")).toMatch(/^Bearer /);
      expect((await r.json()).error).toHaveProperty("message");
    }
  });
});

describe("Dataverse: validación de esquema", () => {
  const { lastname: _l, ...sinLastname } = VALID_LEAD;
  const { subject: _s, ...sinSubject } = VALID_LEAD;
  it.each([
    [{ ...VALID_LEAD, nope: 1 }, "Invalid property 'nope'"],
    [{ ...VALID_LEAD, firstname: 123 }, "expects a string"],
    [{ ...VALID_LEAD, new_source: 5 }, "not valid for the attribute 'new_source'"],
    [{ ...VALID_LEAD, new_source: "100000000" }, "expects an integer"],
    [sinLastname, "'lastname'"],
    [sinSubject, "'subject'"],
    [{ ...VALID_LEAD, lastname: "x".repeat(51) }, "exceeded the maximum allowed length of '50'"],
  ])("%j", async (payload, fragment) => {
    const t = setup();
    const r = await t.call(`${API}/leads`, { method: "POST", json: payload, headers: await t.auth() });
    expect(r.status).toBe(400);
    const err = (await r.json()).error;
    expect(Object.keys(err).sort()).toEqual(["code", "message"]);
    expect(err.message).toContain(fragment);
    expect((await (await t.call(`${BASE}/_mock/records`)).json()).count).toBe(0);
  });

  it("JSON inválido", async () => {
    const t = setup();
    const r = await t.call(`${API}/leads`, { method: "POST", body: "{nope", headers: await t.auth({ "content-type": "application/json" }) });
    expect(r.status).toBe(400);
  });

  it("return=representation", async () => {
    const t = setup();
    const r = await t.call(`${API}/leads?$select=lastname,subject`, {
      method: "POST", json: VALID_LEAD, headers: await t.auth({ prefer: "return=representation" }),
    });
    expect(r.status).toBe(201);
    expect(r.headers.get("preference-applied")).toBe("return=representation");
    expect(r.headers.get("odata-entityid")).toBeNull();
    const b = await r.json();
    expect(b["@odata.context"]).toMatch(/\$metadata#leads\(lastname,subject\)\/\$entity$/);
    expect(b.lastname).toBe("Lovelace");
    expect(b).toHaveProperty("leadid");
    expect(b).not.toHaveProperty("firstname");
  });
});

describe("Dataverse: lectura, filtro, PATCH, DELETE", () => {
  async function create(t: ReturnType<typeof setup>, over: Record<string, unknown> = {}) {
    const r = await t.call(`${API}/leads`, { method: "POST", json: { ...VALID_LEAD, ...over }, headers: await t.auth({ prefer: "return=representation" }) });
    return (await r.json()).leadid as string;
  }

  it("lista con $select, $top y $filter", async () => {
    const t = setup();
    const h = await t.auth();
    for (const n of ["Uno", "Dos", "Tres"]) await create(t, { lastname: n });
    await create(t, { lastname: "Dos", subject: "Otra" });

    let r = await t.call(`${API}/leads?$select=lastname&$top=2`, { headers: h });
    const value = (await r.json()).value;
    expect(value).toHaveLength(2);
    expect(Object.keys(value[0]).sort()).toEqual(["@odata.etag", "lastname", "leadid"]);

    const count = async (q: string) => (await (await t.call(`${API}/leads?${q}`, { headers: h })).json()).value.length;
    expect(await count("$filter=lastname eq 'dos'")).toBe(2);
    expect(await count("$filter=lastname eq 'Dos' and subject eq 'Otra'")).toBe(1);
    expect(await count("$filter=new_inquirytype eq 100000001")).toBe(4);

    for (const q of ["$filter=lastname gt 'a'", "$filter=bogus eq 1", "$select=bogus", "$top=abc"]) {
      expect((await t.call(`${API}/leads?${q}`, { headers: h })).status, q).toBe(400);
    }
  });

  it("PATCH y DELETE", async () => {
    const t = setup();
    const h = await t.auth();
    const id = await create(t);
    const url = `${API}/leads(${id})`;
    expect((await t.call(url, { method: "PATCH", json: { lastname: "Byron" }, headers: h })).status).toBe(204);
    const rep = await t.call(url, { method: "PATCH", json: { lastname: "Byron2" }, headers: { ...h, prefer: "return=representation" } });
    expect(rep.status).toBe(200);
    const b = await rep.json();
    expect(b.lastname).toBe("Byron2");
    expect(b["@odata.etag"]).toBe('W/"3"');
    expect((await t.call(url, { method: "PATCH", json: { new_source: 9 }, headers: h })).status).toBe(400);
    expect((await t.call(url, { method: "PATCH", json: { lastname: null }, headers: h })).status).toBe(400);
    expect((await (await t.call(`${url}?$select=lastname`, { headers: h })).json()).lastname).toBe("Byron2");

    expect((await t.call(url, { method: "DELETE", headers: h })).status).toBe(204);
    const gone = await t.call(url, { headers: h });
    expect(gone.status).toBe(404);
    expect((await gone.json()).error.message).toContain("Does Not Exist");
    expect((await t.call(url, { method: "DELETE", headers: h })).status).toBe(404);
  });

  it("WhoAmI, entidad inexistente y métodos", async () => {
    const t = setup();
    const h = await t.auth();
    const who = await t.call(`${API}/WhoAmI`, { headers: h });
    expect(Object.keys(await who.json())).toEqual(expect.arrayContaining(["UserId", "BusinessUnitId", "OrganizationId"]));
    const acc = await t.call(`${API}/accounts`, { headers: h });
    expect(acc.status).toBe(404);
    expect(Object.keys((await acc.json()).error).sort()).toEqual(["code", "message"]);
    expect((await t.call(`${API}/leads/extra/segments`, { headers: h })).status).toBe(404);
    expect((await t.call(`${API}/leads`, { method: "DELETE", headers: h })).status).toBe(405);
    expect((await t.call(`${API}/leads(not-a-guid)`, { headers: h })).status).toBe(400);
  });
});
