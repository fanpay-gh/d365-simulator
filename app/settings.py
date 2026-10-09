import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    tenant_id: str = "11111111-1111-1111-1111-111111111111"
    client_id: str = "22222222-2222-2222-2222-222222222222"
    client_secret: str = "mock-client-secret"
    base_url: str = "http://localhost:8000"
    token_ttl_seconds: int = 3600
    port: int = 8000
    signing_key: str = "d365-simulator-signing-key"
    persist_file: str | None = None
    schema_file: str = str(Path(__file__).resolve().parent.parent / "schema.yaml")
    request_log_max: int = 200


def load_settings() -> Settings:
    load_dotenv()
    d = Settings()
    port = int(os.getenv("PORT", d.port))
    return Settings(
        tenant_id=os.getenv("MOCK_TENANT_ID", d.tenant_id),
        client_id=os.getenv("MOCK_CLIENT_ID", d.client_id),
        client_secret=os.getenv("MOCK_CLIENT_SECRET", d.client_secret),
        base_url=os.getenv("MOCK_BASE_URL", f"http://localhost:{port}").rstrip("/"),
        token_ttl_seconds=int(os.getenv("TOKEN_TTL_SECONDS", d.token_ttl_seconds)),
        port=port,
        signing_key=os.getenv("MOCK_SIGNING_KEY", d.signing_key),
        persist_file=os.getenv("MOCK_PERSIST_FILE") or None,
        schema_file=os.getenv("MOCK_SCHEMA_FILE", d.schema_file),
        request_log_max=int(os.getenv("MOCK_REQUEST_LOG_MAX", d.request_log_max)),
    )
