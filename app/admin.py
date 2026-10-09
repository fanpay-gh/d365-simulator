import html

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from .faults import parse_spec

router = APIRouter(prefix="/_mock")


class ConfigUpdate(BaseModel):
    fail: str | None = None
    fail_rate: float | None = Field(None, ge=0, le=1)
    fail_pool: list[str] | None = None
    delay_ms: int | None = Field(None, ge=0)
    retry_after_seconds: int | None = Field(None, ge=0)
    timeout_seconds: float | None = Field(None, ge=0)
    token_ttl_seconds: int | None = None


@router.get("/records")
def records(request: Request):
    return {"count": len(request.app.state.store.records),
            "value": [{k: v for k, v in r.items() if not k.startswith("_")}
                      for r in request.app.state.store.records.values()]}


@router.get("/requests")
def requests(request: Request, limit: int = 50):
    log = list(request.app.state.store.requests)
    return {"count": len(log), "value": log[-limit:][::-1]}  # más reciente primero


@router.post("/reset")
def reset(request: Request):
    request.app.state.store.reset()
    return {"status": "reset"}


@router.get("/config")
def get_config(request: Request):
    return request.app.state.store.config


@router.patch("/config")
@router.put("/config")
def set_config(update: ConfigUpdate, request: Request):
    """Fusiona los campos enviados. `fail: null` limpia la falla global."""
    store = request.app.state.store
    changes = update.model_dump(exclude_unset=True)
    for spec in [changes.get("fail"), *(changes.get("fail_pool") or [])]:
        if spec:
            parse_spec(spec)
    store.config.update(changes)
    return store.config


@router.get("/", response_class=HTMLResponse, include_in_schema=False)
@router.get("", response_class=HTMLResponse, include_in_schema=False)
def viewer(request: Request):
    store, schema = request.app.state.store, request.app.state.schema
    cols = [schema.primary_key, "createdon", *schema.fields]
    head = "".join(f"<th>{html.escape(c)}</th>" for c in cols)
    rows = "".join(
        "<tr>" + "".join(f"<td>{html.escape('' if r.get(c) is None else str(r[c]))}</td>" for c in cols) + "</tr>"
        for r in store.records.values()
    ) or f'<tr><td colspan="{len(cols)}"><em>Sin registros</em></td></tr>'
    page = f"""<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5">
<title>D365 mock</title><style>body{{font:14px system-ui;margin:2rem}}table{{border-collapse:collapse}}
th,td{{border:1px solid #ccc;padding:4px 8px;text-align:left}}th{{background:#f3f3f3}}</style></head><body>
<h1>D365 mock · {html.escape(schema.entity_set)} ({len(store.records)})</h1>
<p><a href="/_mock/records">records</a> · <a href="/_mock/requests">requests</a> ·
<a href="/_mock/config">config</a> · POST /_mock/reset</p>
<table><tr>{head}</tr>{rows}</table></body></html>"""
    return HTMLResponse(page)
