import time

import pytest

from .conftest import API, SETTINGS, VALID_LEAD, form


@pytest.mark.parametrize("fault,status", [("401", 401), ("403", 403), ("404", 404), ("429", 429),
                                          ("500", 500), ("503", 503)])
def test_fault_by_header(client, auth, fault, status):
    r = client.get(f"{API}/WhoAmI", headers={**auth, "X-Mock-Fail": fault})
    assert r.status_code == status
    assert set(r.json()["error"]) == {"code", "message"}
    if status == 429:
        assert r.headers["Retry-After"] == "5"
        assert r.json()["error"]["code"] == "0x80072322"
    if status == 401:
        assert r.headers["WWW-Authenticate"].startswith("Bearer ")


def test_fault_applies_without_valid_token(client):
    assert client.get(f"{API}/WhoAmI", headers={"X-Mock-Fail": "503"}).status_code == 503


def test_retry_after_configurable(client, auth):
    client.patch("/_mock/config", json={"retry_after_seconds": 42})
    r = client.get(f"{API}/WhoAmI", headers={**auth, "X-Mock-Fail": "429"})
    assert r.headers["Retry-After"] == "42"


def test_slow_response(client, auth):
    t = time.perf_counter()
    r = client.get(f"{API}/WhoAmI", headers={**auth, "X-Mock-Fail": "slow:250"})
    assert r.status_code == 200 and time.perf_counter() - t >= 0.25


def test_global_delay(client, auth):
    client.patch("/_mock/config", json={"delay_ms": 200})
    t = time.perf_counter()
    assert client.get(f"{API}/WhoAmI", headers=auth).status_code == 200
    assert time.perf_counter() - t >= 0.2


def test_timeout(client, auth):
    client.patch("/_mock/config", json={"timeout_seconds": 0.2})
    t = time.perf_counter()
    r = client.get(f"{API}/WhoAmI", headers={**auth, "X-Mock-Fail": "timeout"})
    assert r.status_code == 504 and time.perf_counter() - t >= 0.2


def test_invalid_fault_spec(client, auth):
    assert client.get(f"{API}/WhoAmI", headers={**auth, "X-Mock-Fail": "banana"}).status_code == 400
    assert client.patch("/_mock/config", json={"fail": "banana"}).status_code == 400


def test_global_fault_and_reset(client, auth):
    assert client.patch("/_mock/config", json={"fail": "500"}).json()["fail"] == "500"
    assert client.get(f"{API}/WhoAmI", headers=auth).status_code == 500
    client.post("/_mock/reset")
    assert client.get("/_mock/config").json()["fail"] is None
    assert client.get(f"{API}/WhoAmI", headers=auth).status_code == 200


def test_probabilistic_mode(client, auth):
    client.patch("/_mock/config", json={"fail_rate": 1.0, "fail_pool": ["503"]})
    assert all(client.get(f"{API}/WhoAmI", headers=auth).status_code == 503 for _ in range(5))
    client.patch("/_mock/config", json={"fail_rate": 0})
    assert client.get(f"{API}/WhoAmI", headers=auth).status_code == 200


def test_fault_does_not_persist_record(client, auth):
    client.post(f"{API}/leads", json=VALID_LEAD, headers={**auth, "X-Mock-Fail": "500"})
    assert client.get("/_mock/records").json()["count"] == 0


# ---------- admin ----------

def test_admin_records_requests_and_masking(client):
    tok = client.post(f"/{SETTINGS.tenant_id}/oauth2/v2.0/token", data=form()).json()["access_token"]
    client.post(f"{API}/leads", json=VALID_LEAD, headers={"Authorization": f"Bearer {tok}", "X-Mock-Fail": "slow:1"})

    records = client.get("/_mock/records").json()
    assert records["count"] == 1 and records["value"][0]["lastname"] == "Lovelace"
    assert not any(k.startswith("_") for k in records["value"][0])

    log = client.get("/_mock/requests").json()["value"]
    assert [e["path"] for e in log][:2] == [f"{API}/leads", f"/{SETTINGS.tenant_id}/oauth2/v2.0/token"]
    token_entry = log[1]
    assert token_entry["body"]["client_secret"] == "***"
    assert token_entry["body"]["client_id"] == SETTINGS.client_id
    dump = str(log)
    assert SETTINGS.client_secret not in dump and tok not in dump
    assert log[0]["headers"]["authorization"].endswith("(masked)") and log[0]["fault"] == "slow:1"

    assert client.post("/_mock/reset").json() == {"status": "reset"}
    assert client.get("/_mock/records").json()["count"] == 0
    assert client.get("/_mock/requests").json()["count"] == 0


def test_viewer_html_escapes(client, auth):
    client.post(f"{API}/leads", json={**VALID_LEAD, "lastname": "<script>x</script>"}, headers=auth)
    r = client.get("/_mock/")
    assert r.status_code == 200 and "text/html" in r.headers["content-type"]
    assert "&lt;script&gt;" in r.text and "<script>x" not in r.text


def test_persistence(tmp_path):
    from fastapi.testclient import TestClient
    from dataclasses import replace
    from app.main import create_app
    cfg = replace(SETTINGS, persist_file=str(tmp_path / "records.json"))
    with TestClient(create_app(cfg)) as c:
        tok = c.post(f"/{cfg.tenant_id}/oauth2/v2.0/token", data=form(cfg)).json()["access_token"]
        c.post(f"{API}/leads", json=VALID_LEAD, headers={"Authorization": f"Bearer {tok}"})
    with TestClient(create_app(cfg)) as c:
        assert c.get("/_mock/records").json()["count"] == 1


def test_all_schema_types(tmp_path, ):
    """Tipos boolean y datetime con un esquema alternativo."""
    from dataclasses import replace
    from fastapi.testclient import TestClient
    from app.main import create_app
    schema = tmp_path / "s.yaml"
    schema.write_text("""
entity:
  entity_set: leads
  logical_name: lead
  primary_key: leadid
  fields:
    lastname: {type: string}
    new_consent: {type: boolean}
    new_callbackat: {type: datetime}
    new_kind: {type: optionset, options: {1: A}}
""")
    cfg = replace(SETTINGS, schema_file=str(schema))
    with TestClient(create_app(cfg)) as c:
        tok = c.post(f"/{cfg.tenant_id}/oauth2/v2.0/token", data=form(cfg)).json()["access_token"]
        h = {"Authorization": f"Bearer {tok}"}
        ok = {"lastname": "x", "new_consent": True, "new_callbackat": "2026-10-09T12:00:00Z", "new_kind": 1}
        assert c.post(f"{API}/leads", json=ok, headers=h).status_code == 204
        assert c.post(f"{API}/leads", json={"new_consent": "yes"}, headers=h).status_code == 400
        assert c.post(f"{API}/leads", json={"new_consent": 1}, headers=h).status_code == 400
        assert c.post(f"{API}/leads", json={"new_callbackat": "mañana"}, headers=h).status_code == 400
        assert c.post(f"{API}/leads", json={"new_kind": True}, headers=h).status_code == 400
        assert c.post(f"{API}/leads", json={}, headers=h).status_code == 204  # nada requerido en este esquema
