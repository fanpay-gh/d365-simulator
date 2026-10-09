# d365-simulator

Mock en Python del **contrato HTTP** de Dynamics 365 / Dataverse que usa un formulario web de contacto
(token de Entra ID con client credentials + Web API de `leads`). Sirve para desarrollar y probar sin
acceso al tenant real. No tiene UI de Dynamics, licencias ni lógica de negocio.

Stack: Python ≥ 3.12 (probado con 3.13), FastAPI + uvicorn, pydantic, pytest + httpx. Sin base de datos:
memoria, con volcado opcional a JSON.

## Arranque

```bash
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
cp .env.example .env
.venv/bin/python -m app.main          # o: .venv/bin/uvicorn app.main:get_app --factory --port 8000
.venv/bin/python -m pytest            # contract tests
```

## Configuración (`.env`)

| Variable | Default | Uso |
|---|---|---|
| `MOCK_TENANT_ID` | `1111…` | Único tenant aceptado en `/{tenant}/oauth2/v2.0/token` |
| `MOCK_CLIENT_ID` / `MOCK_CLIENT_SECRET` | `2222…` / `mock-client-secret` | Credenciales aceptadas |
| `MOCK_BASE_URL` | `http://localhost:$PORT` | `aud` del token, scope esperado (`<base>/.default`), `OData-EntityId` y `@odata.context` |
| `TOKEN_TTL_SECONDS` | `3600` | `expires_in`; se puede cambiar en caliente con `PATCH /_mock/config` |
| `PORT` | `8000` | Puerto |
| `MOCK_SIGNING_KEY`, `MOCK_PERSIST_FILE`, `MOCK_SCHEMA_FILE`, `MOCK_REQUEST_LOG_MAX` | | Opcionales |

## Apuntar la app Next.js al mock

El mock corre en **http** local, no https. Cambia en la app (los nombres de las variables dependen de cómo estén definidas allí):

- **Host de la autoridad**: de `https://login.microsoftonline.com` a `http://localhost:8000`
  (la URL final queda `http://localhost:8000/{MOCK_TENANT_ID}/oauth2/v2.0/token`).
- **URL del recurso / Dataverse**: de `https://{org}.crm.dynamics.com` a `http://localhost:8000`.
  El scope pasa a ser `http://localhost:8000/.default` (debe coincidir con `MOCK_BASE_URL`).
- `tenant`, `client_id` y `client_secret` de la app = los `MOCK_*` del `.env` del mock.
- Si la app usa MSAL, hay que permitir autoridad http (MSAL exige https por defecto, por ejemplo con
  `knownAuthorities` o desactivando la validación de autoridad). Con un `fetch` directo al token endpoint no hay problema.
- Si Next.js corre en Docker, `localhost` apunta al contenedor: usa `host.docker.internal` y ponlo también en `MOCK_BASE_URL`.

## Las tres llamadas

```bash
B=http://localhost:8000; T=11111111-1111-1111-1111-111111111111
curl -si -X POST $B/$T/oauth2/v2.0/token -d grant_type=client_credentials \
  -d client_id=22222222-2222-2222-2222-222222222222 -d client_secret=mock-client-secret \
  --data-urlencode "scope=$B/.default"
curl -si -X POST $B/api/data/v9.2/leads -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"lastname":"Lovelace","subject":"Consulta web","new_inquirytype":100000001}'
curl -si "$B/api/data/v9.2/leads($ID)?\$select=lastname,subject" -H "Authorization: Bearer $TOKEN"
```

## Endpoints

- `POST /{tenant}/oauth2/v2.0/token`
- `/api/data/v9.2`: `POST /leads`, `GET /leads`, `GET|PATCH|DELETE /leads({id})`, `GET /WhoAmI`.
  Fuera de alcance: `$expand`, `$batch`, `$metadata`, otros flujos OAuth. `PATCH` no hace upsert (404 si no existe).
  `$filter` soporta solo `campo eq valor` unido con `and`.
- Admin (sin auth): `GET /_mock/` (visor HTML), `GET /_mock/records`, `GET /_mock/requests?limit=`,
  `POST /_mock/reset` (borra registros, log y config), `GET|PATCH /_mock/config`, `/_mock/docs`.

## Esquema (`schema.yaml`)

Define entity set, nombre lógico, clave primaria y campos (`string`, `memo`, `optionset`, `boolean`, `datetime`)
con `required`, `max_length` y `options`. **La obligatoriedad (`lastname` y `subject` requeridos), las longitudes y los
tres campos `new_*` con sus valores son provisionales: deben alinearse con lo que confirme el cliente.**
Las longitudes por defecto son de memoria y no se verificaron contra un tenant real.

## Inyección de fallas

Por header `X-Mock-Fail: <valor>` (por request) o globalmente con `PATCH /_mock/config {"fail": "<valor>"}`.
Valores: `401`, `403`, `404`, `429`, `500`, `503`, `slow:<ms>`, `timeout`. La falla se evalúa antes de la
autenticación y no persiste nada. Otros ajustes de `/_mock/config`: `delay_ms` (retardo global),
`retry_after_seconds` (default 5), `timeout_seconds` (default 60; luego responde 504), `fail_rate` +
`fail_pool` (modo probabilístico), `token_ttl_seconds` (`0` emite tokens ya expirados) y `fail: null` para limpiar.
`POST /_mock/reset` deja todo como al arrancar.

## Verificado vs aproximado

Verificado = consultado en Microsoft Learn el 2026-10-09. Aproximado = inferido o de memoria; **no lo trates como oficial**.

| Elemento | Estado | Fuente / nota |
|---|---|---|
| Token: `POST /{tenant}/oauth2/v2.0/token`, form con `client_id`, `scope`, `client_secret`, `grant_type`; respuesta `token_type`/`expires_in`/`access_token` | Verificado | [client credentials](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow) |
| Campos del error de Entra (`error`, `error_description` con `Trace ID`/`Correlation ID`/`Timestamp`, `error_codes`, `timestamp`, `trace_id`, `correlation_id`) | Verificado | misma página |
| Códigos AADSTS 70011, 70003, 90002, 700016, 7000215 y su significado | Verificado | [error codes](https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes) |
| Texto de `error_description` de 70011 | Verificado (ejemplo oficial) | |
| Texto de `error_description` de 70003, 90002, 700016, 7000215, 900144 | Aproximado | El código es oficial; la redacción es de memoria o abreviada |
| `invalid_scope` con status 400 | Verificado | Es el único status de error de token que aparece en la documentación |
| Status/`error` de los otros errores (401 `invalid_client` para client desconocido y secret malo; 400 `invalid_request` para tenant; 400 `unsupported_grant_type`) | Aproximado | |
| AADSTS900144 para parámetros faltantes | Aproximado | |
| `ext_expires_in` en la respuesta | Aproximado | Pedido en la spec; no aparece en el ejemplo oficial |
| JWT HS256 con `aud`, `iss`, `tid`, `appid`, `iat`, `exp` (+`nbf`) | Aproximado | Entra firma RS256; el `iss` v1 es de memoria |
| Basic auth para las credenciales | Verificado | Mencionado en la página de client credentials |
| `POST` → 204 + `OData-EntityId: …/leads({guid})` + `OData-Version: 4.0` | Verificado | [create](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-entity-web-api) |
| `Prefer: return=representation` → 201, `Preference-Applied`, `@odata.context`/`@odata.etag`/campos, sin `OData-EntityId`; `$select` aplicable | Verificado | misma página |
| `PATCH` → 204, o 200 con `return=representation` | Verificado | [Compose HTTP requests](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/compose-http-requests-handle-errors) |
| `GET` colección `{"@odata.context","value":[…]}`, `$filter … eq …`, strings case-insensitive, `''` como escape | Verificado | [filter rows](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query/filter-rows) |
| Formato de error `{"error":{"code","message"}}`; `code` "frecuentemente vacío" | Verificado | Compose HTTP requests |
| Status 400/401/403/404/405/412/429/503 y los nombres de tipo de error de 401/403 | Verificado | misma página |
| 429 con `Retry-After` en segundos; código `0x80072322` y su mensaje | Verificado | [API limits](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/api-limits) |
| `Content-Type: application/json; odata.metadata=minimal` | Verificado | ejemplos de la documentación |
| 400 de validación con código `0x0` ("An error occurred while validating input parameters") para propiedad inválida | Parcialmente verificado | Visto en un snippet de [client errors](https://learn.microsoft.com/en-us/troubleshoot/power-platform/power-apps/dataverse/web-api-client-errors); no se pudo leer la página completa |
| Mensajes de 400 para tipo erróneo, option set inexistente, requerido faltante, longitud excedida, `$select`/`$filter` inválidos | Aproximado | Se usa código `0x0` por defecto |
| 404 entidad inexistente: "Resource not found for the segment '…'" con `0x8006088a` | Parcialmente verificado | Mismo snippet |
| 404 registro inexistente (`… With Id = … Does Not Exist`, `0x80040217`) | Aproximado | |
| 404 "No HTTP resource was found that matches the request URI" (rutas desconocidas, WhoAmI mal usado) | Parcialmente verificado | Mismo snippet |
| 403: código `0x80040220` y mensaje de privilegio faltante | Aproximado | Solo el status y los tipos son oficiales |
| 500 (`0x80040216`), 503 y 504 (timeout): códigos y mensajes | Aproximado | Solo los status 500/503 son oficiales; 504 es decisión del mock |
| 401: `WWW-Authenticate: Bearer authorization_uri=…, resource_id=…` y el cuerpo JSON | Aproximado | Dataverse no documenta el formato; los mensajes son del mock |
| 405 en `DELETE`/`PATCH` sobre la colección | Verificado (status) | El mensaje es aproximado |
| 412 por clave primaria duplicada | Aproximado | |
| `WhoAmI`: `UserId`, `BusinessUnitId`, `OrganizationId` y `@odata.context` | Aproximado | GUIDs derivados del tenant |
| Longitudes por defecto de los campos de `lead` | Aproximado | De memoria |
| Header `X-Mock-Fail`, `/_mock/*`, 504 en timeout | Propio del mock | No existe en Microsoft |
