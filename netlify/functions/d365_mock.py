"""Función de Netlify (formato AWS Lambda / API Gateway v1) que sirve la app FastAPI del mock.

Netlify entrega el evento con `path`, `httpMethod`, `headers`, `queryStringParameters`, `body`,
`isBase64Encoded`. Se traduce a una petición ASGI en proceso con httpx, sin servidor ni sockets.
El estado vive en memoria de la instancia: se pierde cuando Netlify recicla la función.
"""
from __future__ import annotations

import asyncio
import base64
import os
import sys
from dataclasses import replace
from pathlib import Path
from urllib.parse import urlencode

import httpx

ROOT = Path(__file__).resolve().parents[2]
for candidate in (ROOT, Path(os.getenv("LAMBDA_TASK_ROOT", ROOT))):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from app.main import create_app  # noqa: E402
from app.settings import load_settings  # noqa: E402

_app = None


def _header(headers: dict | None, name: str) -> str | None:
    for key, value in (headers or {}).items():
        if key.lower() == name:
            return value
    return None


def _get_app(headers: dict | None):
    """Crea la app una vez por instancia. Si MOCK_BASE_URL no está definida, usa el host de la petición."""
    global _app
    if _app is None:
        settings = load_settings()
        if not os.getenv("MOCK_BASE_URL"):
            host = _header(headers, "x-forwarded-host") or _header(headers, "host")
            proto = _header(headers, "x-forwarded-proto") or "https"
            if host:
                settings = replace(settings, base_url=f"{proto}://{host}")
        if not settings.persist_file:
            settings = replace(settings, persist_file="/tmp/d365-mock-records.json")  # /tmp es lo único escribible
        _app = create_app(settings)
    return _app


async def _call(app, event: dict) -> dict:
    query = event.get("multiValueQueryStringParameters") or {}
    pairs = [(k, v) for k, vs in query.items() for v in vs] or list((event.get("queryStringParameters") or {}).items())
    body = event.get("body") or ""
    content = base64.b64decode(body) if event.get("isBase64Encoded") else body.encode()

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://lambda") as client:
        response = await client.request(
            event.get("httpMethod", "GET"),
            event.get("path", "/"),
            params=pairs,
            headers=event.get("headers") or {},
            content=content,
            timeout=None,
        )
    return {
        "statusCode": response.status_code,
        "headers": {k: v for k, v in response.headers.items() if k.lower() not in ("content-length", "transfer-encoding")},
        "body": response.text,
        "isBase64Encoded": False,
    }


def handler(event: dict, context=None) -> dict:
    del context
    return asyncio.run(_call(_get_app(event.get("headers")), event))
