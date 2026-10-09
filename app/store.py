import json
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

from .settings import Settings

CONFIG_DEFAULTS = {
    "fail": None,              # falla global: "401", "slow:500", "timeout"...
    "fail_rate": 0.0,          # modo probabilístico: probabilidad 0..1
    "fail_pool": ["500", "503", "429"],
    "delay_ms": 0,             # retardo extra en todas las respuestas de Dataverse
    "retry_after_seconds": 5,  # valor de Retry-After en 429
    "timeout_seconds": 60.0,   # cuánto se queda colgada la falla "timeout"
    "token_ttl_seconds": None, # None -> TOKEN_TTL_SECONDS del entorno
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Store:
    """Estado en memoria: registros, log de requests y configuración en runtime."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.records: dict[str, dict] = {}
        self.requests: deque = deque(maxlen=settings.request_log_max)
        self.config = dict(CONFIG_DEFAULTS)
        self._load()

    def reset(self) -> None:
        self.records.clear()
        self.requests.clear()
        self.config = dict(CONFIG_DEFAULTS)
        self.save()

    @property
    def token_ttl(self) -> int:
        override = self.config["token_ttl_seconds"]
        return self.settings.token_ttl_seconds if override is None else override

    def save(self) -> None:
        path = self.settings.persist_file
        if path:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).write_text(json.dumps(self.records, indent=2))

    def _load(self) -> None:
        path = self.settings.persist_file
        if path and Path(path).exists():
            self.records = json.loads(Path(path).read_text())
