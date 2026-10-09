import base64
import hashlib
import hmac
import json
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import parse_qs, unquote_plus

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .responses import DataverseError
from .settings import Settings

router = APIRouter()


# ---------- JWT HS256 (Entra real firma con RS256; HS256 es una simplificación del mock) ----------

def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(signing_input: str, key: str) -> str:
    return _b64(hmac.new(key.encode(), signing_input.encode(), hashlib.sha256).digest())


def make_token(settings: Settings, *, ttl: int, appid: str | None = None, aud: str | None = None,
               tid: str | None = None, iat: int | None = None) -> str:
    iat = int(time.time()) if iat is None else iat
    tid = tid or settings.tenant_id
    claims = {
        "aud": aud or settings.base_url,
        "iss": f"https://sts.windows.net/{tid}/",
        "tid": tid,
        "appid": appid or settings.client_id,
        "iat": iat,
        "nbf": iat,
        "exp": iat + ttl,
    }
    head = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = _b64(json.dumps(claims, separators=(",", ":")).encode())
    return f"{head}.{body}.{_sign(f'{head}.{body}', settings.signing_key)}"


def verify_token(settings: Settings, token: str) -> str | None:
    """Devuelve None si el token es válido, o el motivo del rechazo."""
    try:
        head, body, sig = token.split(".")
        if not hmac.compare_digest(sig, _sign(f"{head}.{body}", settings.signing_key)):
            return "invalid signature"
        claims = json.loads(_unb64(body))
    except Exception:
        return "malformed token"
    if time.time() >= claims.get("exp", 0):
        return "token expired"
    if claims.get("aud") != settings.base_url:
        return "invalid audience"
    if claims.get("tid") != settings.tenant_id:
        return "invalid tenant"
    return None


def unauthorized(settings: Settings, message: str, *, invalid_token: bool = False) -> DataverseError:
    # Formato de WWW-Authenticate APROXIMADO: la documentación de Dataverse no lo especifica.
    challenge = (f'Bearer authorization_uri="https://login.microsoftonline.com/{settings.tenant_id}", '
                 f'resource_id="{settings.base_url}"')
    if invalid_token:
        challenge += f', error="invalid_token", error_description="{message}"'
    return DataverseError(401, message, "", {"WWW-Authenticate": challenge})


async def require_token(request: Request) -> None:
    settings: Settings = request.app.state.settings
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if not header:
        raise unauthorized(settings, "Bearer token is missing.")
    if scheme.lower() != "bearer" or not token.strip():
        raise unauthorized(settings, "Authorization header must use the Bearer scheme.")
    reason = verify_token(settings, token.strip())
    if reason:
        raise unauthorized(settings, f"Bearer token rejected: {reason}.", invalid_token=True)


# ---------- Token endpoint ----------

def _aad_error(status: int, error: str, code: int, text: str) -> JSONResponse:
    trace_id, corr_id = str(uuid.uuid4()), str(uuid.uuid4())
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")
    description = f"AADSTS{code}: {text}\r\nTrace ID: {trace_id}\r\nCorrelation ID: {corr_id}\r\nTimestamp: {ts}"
    return JSONResponse(
        {"error": error, "error_description": description, "error_codes": [code],
         "timestamp": ts, "trace_id": trace_id, "correlation_id": corr_id},
        status_code=status,
    )


def _basic_credentials(request: Request) -> tuple[str | None, str | None]:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("basic "):
        try:
            cid, _, secret = base64.b64decode(header[6:]).decode().partition(":")
            return unquote_plus(cid), unquote_plus(secret)
        except Exception:
            pass
    return None, None


@router.post("/{tenant}/oauth2/v2.0/token")
async def token_endpoint(tenant: str, request: Request):
    settings: Settings = request.app.state.settings
    store = request.app.state.store
    raw = parse_qs((await request.body()).decode(), keep_blank_values=True)
    form = {k: v[0] for k, v in raw.items()}
    request.state.log_body = form

    basic_id, basic_secret = _basic_credentials(request)
    client_id = form.get("client_id") or basic_id
    secret = form.get("client_secret") or basic_secret

    if tenant != settings.tenant_id:
        return _aad_error(400, "invalid_request", 90002,
                          f"Tenant '{tenant}' not found. Check to make sure you have the correct tenant ID "
                          "and are signing into the correct cloud.")
    for param, value in (("grant_type", form.get("grant_type")), ("client_id", client_id)):
        if not value:
            return _aad_error(400, "invalid_request", 900144,
                              f"The request body must contain the following parameter: '{param}'.")
    if form["grant_type"] != "client_credentials":
        return _aad_error(400, "unsupported_grant_type", 70003, "The app returned an unsupported grant type.")
    if client_id != settings.client_id:
        return _aad_error(401, "invalid_client", 700016,
                          f"Application with identifier '{client_id}' was not found in the directory '{tenant}'. "
                          "This can happen if the application has not been installed by the administrator of "
                          "the tenant or consented to by any user in the tenant. You may have sent your "
                          "authentication request to the wrong tenant.")
    if not secret:
        return _aad_error(400, "invalid_request", 900144,
                          "The request body must contain the following parameter: 'client_secret'.")
    if not hmac.compare_digest(secret, settings.client_secret):
        return _aad_error(401, "invalid_client", 7000215,
                          "Invalid client secret provided. Ensure the secret being sent in the request is the "
                          f"client secret value, not the client secret ID, for a secret added to app '{client_id}'.")
    scope = form.get("scope", "")
    if not scope:
        return _aad_error(400, "invalid_request", 900144,
                          "The request body must contain the following parameter: 'scope'.")
    if scope.split() != [f"{settings.base_url}/.default"]:
        return _aad_error(400, "invalid_scope", 70011,
                          "The provided value for the input parameter 'scope' isn't valid. "
                          f"The scope {scope} isn't valid.")

    ttl = store.token_ttl
    return JSONResponse({
        "token_type": "Bearer",
        "expires_in": ttl,
        "ext_expires_in": ttl,
        "access_token": make_token(settings, ttl=ttl),
    })
