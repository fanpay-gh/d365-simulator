import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings

SETTINGS = Settings(base_url="http://testserver", token_ttl_seconds=3600)
API = "/api/data/v9.2"
VALID_LEAD = {"firstname": "Ada", "lastname": "Lovelace", "subject": "Consulta", "emailaddress1": "ada@example.com",
              "description": "Hola", "new_inquirytype": 100000001}


def form(settings=SETTINGS, **overrides):
    data = {"grant_type": "client_credentials", "client_id": settings.client_id,
            "client_secret": settings.client_secret, "scope": f"{settings.base_url}/.default"}
    data.update(overrides)
    return {k: v for k, v in data.items() if v is not None}


@pytest.fixture
def client():
    with TestClient(create_app(SETTINGS)) as c:
        yield c


@pytest.fixture
def token(client):
    return client.post(f"/{SETTINGS.tenant_id}/oauth2/v2.0/token", data=form()).json()["access_token"]


@pytest.fixture
def auth(token):
    return {"Authorization": f"Bearer {token}"}
