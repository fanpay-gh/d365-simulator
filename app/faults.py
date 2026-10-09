import asyncio
import random
import re

from fastapi import Request

from .responses import DataverseError

STATUS_FAULTS = {"401", "403", "404", "429", "500", "503"}


def parse_spec(spec: str) -> tuple[str, int | None]:
    """'401' | '429' | 'slow:500' | 'timeout' -> (kind, ms)."""
    spec = spec.strip().lower()
    if spec in STATUS_FAULTS or spec == "timeout":
        return spec, None
    m = re.fullmatch(r"slow[:=](\d+)", spec)
    if m:
        return "slow", int(m.group(1))
    raise DataverseError(400, f"Invalid X-Mock-Fail value '{spec}'. Use 401, 403, 404, 429, 500, 503, slow:<ms> or timeout.")


def _fault_error(kind: str, request: Request) -> DataverseError:
    settings, cfg = request.app.state.settings, request.app.state.store.config
    # Status verificados en la documentación; códigos hex y mensajes de 403/404/500/503 son aproximados.
    if kind == "401":
        from .auth import unauthorized
        return unauthorized(settings, "Injected fault: unauthorized.")
    if kind == "403":
        schema = request.app.state.schema
        verb = {"GET": "Read", "POST": "Create", "PATCH": "Write", "DELETE": "Delete"}.get(request.method, "Read")
        return DataverseError(403, f"Principal user is missing prv{verb}{schema.logical_name.capitalize()} privilege.",
                              "0x80040220")
    if kind == "404":
        return DataverseError(404, "Injected fault: resource not found.", "0x80040217")
    if kind == "429":
        # Código y mensaje de 0x80072322 y header Retry-After (segundos) verificados.
        return DataverseError(429, "Number of requests exceeded the limit of 6000 over time window of 300 seconds.",
                              "0x80072322", {"Retry-After": str(cfg["retry_after_seconds"])})
    if kind == "500":
        return DataverseError(500, "An unexpected error occurred.", "0x80040216")
    return DataverseError(503, "The service is temporarily unavailable.", "")


async def inject_faults(request: Request) -> None:
    """Dependencia de las rutas de Dataverse: aplica la falla pedida por header, config o azar."""
    cfg = request.app.state.store.config
    if cfg["delay_ms"]:
        await asyncio.sleep(cfg["delay_ms"] / 1000)

    spec = request.headers.get("x-mock-fail") or cfg["fail"]
    if not spec and cfg["fail_rate"] > 0 and cfg["fail_pool"] and random.random() < cfg["fail_rate"]:
        spec = random.choice(cfg["fail_pool"])
    if not spec:
        return

    kind, ms = parse_spec(spec)
    request.state.fault = spec
    if kind == "slow":
        await asyncio.sleep(ms / 1000)
    elif kind == "timeout":
        await asyncio.sleep(cfg["timeout_seconds"])
        raise DataverseError(504, "Injected fault: timeout.", "")
    else:
        raise _fault_error(kind, request)
