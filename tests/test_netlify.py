"""La función de Netlify recibe eventos tipo API Gateway v1 y debe comportarse como el servidor."""
import base64
import json
from urllib.parse import urlencode

import pytest

from .conftest import SETTINGS, form


@pytest.fixture
def fn(monkeypatch, tmp_path):
    monkeypatch.setenv("MOCK_BASE_URL", SETTINGS.base_url)
    monkeypatch.setenv("MOCK_PERSIST_FILE", str(tmp_path / "r.json"))
    monkeypatch.setenv("MOCK_TENANT_ID", SETTINGS.tenant_id)
    from netlify.functions import d365_mock
    monkeypatch.setattr(d365_mock, "_app", None)
    return d365_mock.handler


def event(method, path, *, headers=None, body=None, query=None, b64=False):
    return {"httpMethod": method, "path": path, "headers": headers or {}, "body": body,
            "queryStringParameters": query, "isBase64Encoded": b64}


def test_three_calls_through_function(fn):
    r = fn(event("POST", f"/{SETTINGS.tenant_id}/oauth2/v2.0/token",
                 headers={"Content-Type": "application/x-www-form-urlencoded"}, body=urlencode(form())))
    assert r["statusCode"] == 200
    auth = {"Authorization": f"Bearer {json.loads(r['body'])['access_token']}", "Content-Type": "application/json"}

    r = fn(event("POST", "/api/data/v9.2/leads", headers=auth,
                 body=json.dumps({"lastname": "L", "subject": "S"})))
    assert r["statusCode"] == 204 and r["body"] == ""
    entity_id = next(v for k, v in r["headers"].items() if k.lower() == "odata-entityid")
    assert entity_id.startswith(f"{SETTINGS.base_url}/api/data/v9.2/leads(")

    guid = entity_id.split("(")[1].rstrip(")")
    r = fn(event("GET", f"/api/data/v9.2/leads({guid})", headers=auth, query={"$select": "lastname"}))
    assert r["statusCode"] == 200 and json.loads(r["body"])["lastname"] == "L"


def test_base64_body_and_fault_header(fn):
    body = base64.b64encode(urlencode(form(client_secret="mala")).encode()).decode()
    r = fn(event("POST", f"/{SETTINGS.tenant_id}/oauth2/v2.0/token", body=body, b64=True,
                 headers={"Content-Type": "application/x-www-form-urlencoded"}))
    assert r["statusCode"] == 401 and "AADSTS7000215" in r["body"]

    r = fn(event("GET", "/api/data/v9.2/WhoAmI", headers={"X-Mock-Fail": "429"}))
    assert r["statusCode"] == 429
    assert {k.lower(): v for k, v in r["headers"].items()}["retry-after"] == "5"


def test_base_url_from_request_host(monkeypatch, tmp_path):
    monkeypatch.delenv("MOCK_BASE_URL", raising=False)
    monkeypatch.setattr("app.settings.load_dotenv", lambda: None)  # ignora el .env local
    monkeypatch.setenv("MOCK_PERSIST_FILE", str(tmp_path / "r.json"))
    from netlify.functions import d365_mock
    monkeypatch.setattr(d365_mock, "_app", None)
    r = d365_mock.handler(event("GET", "/_mock/config", headers={"host": "mi-mock.netlify.app"}))
    assert r["statusCode"] == 200
    assert d365_mock._app.state.settings.base_url == "https://mi-mock.netlify.app"
