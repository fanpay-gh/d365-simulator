"""Contract test: la prueba de tres llamadas (token -> crear lead -> leerlo) y sus casos negativos."""
import re

import pytest

from app.auth import make_token
from .conftest import API, SETTINGS, VALID_LEAD, form

TOKEN_URL = f"/{SETTINGS.tenant_id}/oauth2/v2.0/token"


def test_three_call_flow(client):
    # 1. token
    r = client.post(TOKEN_URL, data=form())
    assert r.status_code == 200
    body = r.json()
    assert body["token_type"] == "Bearer" and body["expires_in"] == 3600 and body["ext_expires_in"] == 3600
    headers = {"Authorization": f"Bearer {body['access_token']}"}

    # 2. crear lead (204 + OData-EntityId)
    r = client.post(f"{API}/leads", json=VALID_LEAD, headers=headers)
    assert r.status_code == 204 and r.content == b""
    entity_id = r.headers["OData-EntityId"]
    m = re.fullmatch(rf"{SETTINGS.base_url}{API}/leads\(([0-9a-f-]{{36}})\)", entity_id)
    assert m and r.headers["OData-Version"] == "4.0"

    # 3. leerlo de vuelta
    r = client.get(f"{API}/leads({m.group(1)})", headers=headers)
    assert r.status_code == 200
    lead = r.json()
    assert lead["leadid"] == m.group(1)
    assert {k: lead[k] for k in VALID_LEAD} == VALID_LEAD
    assert lead["@odata.context"].endswith("/$metadata#leads/$entity")


def test_token_claims(client, token):
    import base64, json
    claims = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))
    assert claims["aud"] == SETTINGS.base_url and claims["tid"] == SETTINGS.tenant_id
    assert claims["appid"] == SETTINGS.client_id and claims["exp"] - claims["iat"] == 3600
    assert claims["iss"] == f"https://sts.windows.net/{SETTINGS.tenant_id}/"


# ---------- token endpoint: errores ----------

@pytest.mark.parametrize("overrides,status,error,code", [
    ({"client_secret": "nope"}, 401, "invalid_client", 7000215),
    ({"client_id": "00000000-0000-0000-0000-000000000000"}, 401, "invalid_client", 700016),
    ({"scope": "https://other.example/.default"}, 400, "invalid_scope", 70011),
    ({"grant_type": "password"}, 400, "unsupported_grant_type", 70003),
    ({"client_secret": None}, 400, "invalid_request", 900144),
])
def test_token_errors(client, overrides, status, error, code):
    r = client.post(TOKEN_URL, data=form(**overrides))
    assert r.status_code == status
    body = r.json()
    assert body["error"] == error and body["error_codes"] == [code]
    assert body["error_description"].startswith(f"AADSTS{code}:")
    assert {"timestamp", "trace_id", "correlation_id"} <= body.keys()
    assert "Trace ID:" in body["error_description"]


def test_token_unknown_tenant(client):
    r = client.post("/no-such-tenant/oauth2/v2.0/token", data=form())
    assert r.status_code == 400 and r.json()["error_codes"] == [90002]


def test_token_ttl_configurable_and_expiry(client):
    client.patch("/_mock/config", json={"token_ttl_seconds": 0})
    body = client.post(TOKEN_URL, data=form()).json()
    assert body["expires_in"] == 0
    r = client.get(f"{API}/WhoAmI", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert r.status_code == 401 and "token expired" in r.json()["error"]["message"]
    assert r.headers["WWW-Authenticate"].startswith("Bearer ")
    # refresh: pedir otro token con TTL normal vuelve a funcionar
    client.patch("/_mock/config", json={"token_ttl_seconds": 60})
    fresh = client.post(TOKEN_URL, data=form()).json()["access_token"]
    assert client.get(f"{API}/WhoAmI", headers={"Authorization": f"Bearer {fresh}"}).status_code == 200


def test_basic_auth_client_credentials(client):
    import base64
    cred = base64.b64encode(f"{SETTINGS.client_id}:{SETTINGS.client_secret}".encode()).decode()
    data = form(client_id=None, client_secret=None)
    r = client.post(TOKEN_URL, data=data, headers={"Authorization": f"Basic {cred}"})
    assert r.status_code == 200


# ---------- Dataverse: autenticación ----------

@pytest.mark.parametrize("headers", [
    {},
    {"Authorization": "Basic abc"},
    {"Authorization": "Bearer garbage"},
    {"Authorization": f"Bearer {make_token(SETTINGS, ttl=-10)}"},
    {"Authorization": f"Bearer {make_token(SETTINGS, ttl=3600, aud='https://other.example')}"},
    {"Authorization": f"Bearer {make_token(SETTINGS, ttl=3600, tid='x')}"},
])
def test_dataverse_rejects_bad_tokens(client, headers):
    r = client.get(f"{API}/WhoAmI", headers=headers)
    assert r.status_code == 401
    assert r.headers["WWW-Authenticate"].startswith("Bearer ")
    assert "message" in r.json()["error"]


def test_tampered_signature_rejected(client, token):
    h, b, s = token.split(".")
    r = client.get(f"{API}/WhoAmI", headers={"Authorization": f"Bearer {h}.{b}.{s[:-2]}xx"})
    assert r.status_code == 401


# ---------- Dataverse: validación de esquema ----------

@pytest.mark.parametrize("payload,fragment", [
    ({**VALID_LEAD, "nope": 1}, "Invalid property 'nope'"),
    ({**VALID_LEAD, "firstname": 123}, "expects a string"),
    ({**VALID_LEAD, "new_source": 5}, "not valid for the attribute 'new_source'"),
    ({**VALID_LEAD, "new_source": "100000000"}, "expects an integer"),
    ({k: v for k, v in VALID_LEAD.items() if k != "lastname"}, "'lastname'"),
    ({k: v for k, v in VALID_LEAD.items() if k != "subject"}, "'subject'"),
    ({**VALID_LEAD, "lastname": "x" * 51}, "exceeded the maximum allowed length of '50'"),
])
def test_create_validation_errors(client, auth, payload, fragment):
    r = client.post(f"{API}/leads", json=payload, headers=auth)
    assert r.status_code == 400
    err = r.json()["error"]
    assert set(err) == {"code", "message"} and fragment in err["message"]
    assert client.get("/_mock/records").json()["count"] == 0


def test_create_invalid_json(client, auth):
    r = client.post(f"{API}/leads", content="{nope", headers={**auth, "Content-Type": "application/json"})
    assert r.status_code == 400 and "error" in r.json()


def test_create_return_representation(client, auth):
    r = client.post(f"{API}/leads?$select=lastname,subject", json=VALID_LEAD,
                    headers={**auth, "Prefer": "return=representation"})
    assert r.status_code == 201
    assert r.headers["Preference-Applied"] == "return=representation"
    assert "OData-EntityId" not in r.headers
    body = r.json()
    assert body["@odata.context"].endswith("/$metadata#leads(lastname,subject)/$entity")
    assert body["lastname"] == "Lovelace" and "leadid" in body and "firstname" not in body


# ---------- Dataverse: lectura, filtro, PATCH, DELETE ----------

def _create(client, auth, **over):
    r = client.post(f"{API}/leads", json={**VALID_LEAD, **over}, headers={**auth, "Prefer": "return=representation"})
    return r.json()["leadid"]


def test_list_select_top_filter(client, auth):
    for name in ("Uno", "Dos", "Tres"):
        _create(client, auth, lastname=name)
    _create(client, auth, lastname="Dos", subject="Otra")

    r = client.get(f"{API}/leads?$select=lastname&$top=2", headers=auth)
    assert r.status_code == 200 and len(r.json()["value"]) == 2
    assert set(r.json()["value"][0]) == {"@odata.etag", "lastname", "leadid"}

    r = client.get(f"{API}/leads?$filter=lastname eq 'dos'", headers=auth)  # eq sobre strings no distingue mayúsculas
    assert len(r.json()["value"]) == 2
    r = client.get(f"{API}/leads?$filter=lastname eq 'Dos' and subject eq 'Otra'", headers=auth)
    assert len(r.json()["value"]) == 1
    r = client.get(f"{API}/leads?$filter=new_inquirytype eq 100000001", headers=auth)
    assert len(r.json()["value"]) == 4

    assert client.get(f"{API}/leads?$filter=lastname gt 'a'", headers=auth).status_code == 400
    assert client.get(f"{API}/leads?$filter=bogus eq 1", headers=auth).status_code == 400
    assert client.get(f"{API}/leads?$select=bogus", headers=auth).status_code == 400
    assert client.get(f"{API}/leads?$top=abc", headers=auth).status_code == 400


def test_patch_and_delete(client, auth):
    lead_id = _create(client, auth)
    r = client.patch(f"{API}/leads({lead_id})", json={"lastname": "Byron"}, headers=auth)
    assert r.status_code == 204
    r = client.patch(f"{API}/leads({lead_id})", json={"lastname": "Byron2"},
                     headers={**auth, "Prefer": "return=representation"})
    assert r.status_code == 200 and r.json()["lastname"] == "Byron2" and r.json()["@odata.etag"] == 'W/"3"'
    assert client.patch(f"{API}/leads({lead_id})", json={"new_source": 9}, headers=auth).status_code == 400
    assert client.patch(f"{API}/leads({lead_id})", json={"lastname": None}, headers=auth).status_code == 400

    got = client.get(f"{API}/leads({lead_id})?$select=lastname", headers=auth).json()
    assert got["lastname"] == "Byron2"

    assert client.delete(f"{API}/leads({lead_id})", headers=auth).status_code == 204
    r = client.get(f"{API}/leads({lead_id})", headers=auth)
    assert r.status_code == 404 and "Does Not Exist" in r.json()["error"]["message"]
    assert client.delete(f"{API}/leads({lead_id})", headers=auth).status_code == 404


def test_whoami(client, auth):
    r = client.get(f"{API}/WhoAmI", headers=auth)
    assert r.status_code == 200
    assert {"UserId", "BusinessUnitId", "OrganizationId"} <= r.json().keys()


def test_unknown_entity_and_methods(client, auth):
    r = client.get(f"{API}/accounts", headers=auth)
    assert r.status_code == 404 and set(r.json()["error"]) == {"code", "message"}
    assert client.get(f"{API}/leads/extra/segments", headers=auth).status_code == 404
    assert client.delete(f"{API}/leads", headers=auth).status_code == 405
    assert client.get(f"{API}/leads(not-a-guid)", headers=auth).status_code == 400
