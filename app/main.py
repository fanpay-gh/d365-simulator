import re
import time

import uvicorn
from fastapi import FastAPI, Request

from . import admin, auth, dataverse
from .responses import DataverseError, dv_error_response
from .schema import load_schema
from .settings import Settings, load_settings
from .store import Store, now_iso

SENSITIVE = re.compile(r"secret|password|assertion|token|authorization", re.IGNORECASE)


def mask(value):
    if isinstance(value, dict):
        return {k: "***" if SENSITIVE.search(k) else mask(v) for k, v in value.items()}
    if isinstance(value, list):
        return [mask(v) for v in value]
    return value


def mask_headers(headers) -> dict:
    out = {}
    for k, v in headers.items():
        if k.lower() == "authorization":
            scheme = v.split(" ")[0]
            out[k] = f"{scheme} {v[len(scheme) + 1:][:10]}…(masked)" if " " in v else "***"
        else:
            out[k] = v
    return out


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    app = FastAPI(title="D365 / Dataverse mock", docs_url="/_mock/docs", openapi_url="/_mock/openapi.json")
    app.state.settings = settings
    app.state.schema = load_schema(settings.schema_file)
    app.state.store = Store(settings)

    @app.exception_handler(DataverseError)
    async def _dv_error(_: Request, exc: DataverseError):
        return dv_error_response(exc)

    @app.middleware("http")
    async def log_requests(request: Request, call_next):
        if request.url.path.startswith("/_mock"):
            return await call_next(request)
        started, status = time.perf_counter(), "aborted"
        try:
            response = await call_next(request)
            status = response.status_code
            return response
        finally:
            request.app.state.store.requests.append({
                "timestamp": now_iso(),
                "method": request.method,
                "path": request.url.path,
                "query": request.url.query,
                "headers": mask_headers(request.headers),
                "body": mask(getattr(request.state, "log_body", None)),
                "fault": getattr(request.state, "fault", None),
                "status": status,
                "duration_ms": round((time.perf_counter() - started) * 1000, 1),
            })

    app.include_router(auth.router)
    app.include_router(dataverse.router)
    app.include_router(admin.router)
    return app


def get_app() -> FastAPI:
    return create_app()


if __name__ == "__main__":
    uvicorn.run("app.main:get_app", factory=True, host="0.0.0.0", port=load_settings().port)
