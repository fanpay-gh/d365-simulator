# d365-simulator

Mock en Python del **contrato HTTP** de Dynamics 365 / Dataverse que usa un formulario web de contacto
(token de Entra ID con client credentials + Web API de `leads`). Sirve para desarrollar y probar sin
acceso al tenant real. No tiene UI de Dynamics, licencias ni lógica de negocio.

Dos implementaciones del mismo contrato: **Python** (FastAPI, para uso local; ≥ 3.12, probado con 3.13) y **TypeScript**
(Netlify Functions, ver [Despliegue en Netlify](#despliegue-en-netlify-versión-typescript)). Sin base de datos:
memoria, con volcado opcional a JSON en Python y Netlify Blobs en TypeScript.

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

## Formulario de contacto (`leads`)

Lo que envía el formulario web de contacto (app Next.js `gap-internal`, ruta `POST /api/contact`) al crear un lead.
Todos los campos están en `schema.yaml`; la app manda **solo estos** y el mock rechaza con 400 cualquier otro.

| Campo del formulario | Campo lógico | Tipo | Requerido | Máx. | Nota |
|---|---|---|---|---|---|
| Name | `firstname` + `lastname` | string | `lastname` sí | 50 y 50 | La primera palabra va a `firstname` y el resto a `lastname`. Con una sola palabra solo se envía `lastname` |
| Email | `emailaddress1` | string | no | 100 | |
| Message | `description` | memo | no | 2000 | |
| (fijo) | `subject` | string | sí | 300 | La app envía `"Website contact form"` |
| Organization type | `new_organizationtype` | optionset | no | | Provisional |
| Industry and size | `new_industrysize` | optionset | no | | Provisional |
| How did you hear about us? | `new_source` | optionset | no | | Textos definitivos; códigos provisionales |

El checkbox de términos **no se envía**: el esquema no tiene un campo para él.

Los option sets se envían como **entero**, nunca como texto (`100000001`, no `"100000001"`):

| Campo | Código | Texto |
|---|---|---|
| `new_organizationtype` | `100000000` | Enterprise |
| | `100000001` | Nonprofit |
| | `100000002` | Public sector |
| `new_industrysize` | `100000000` | 1 to 50 people |
| | `100000001` | 51 to 500 people |
| | `100000002` | More than 500 people |
| `new_source` | `100000000` | Referred by colleague |
| | `100000001` | Conference or event |
| | `100000002` | Genius Institute research |
| | `100000003` | Online search |
| | `100000004` | Social media |
| | `100000005` | Other |

`new_inquirytype` y `new_contactmethod` siguen en el esquema pero el formulario no los usa.

### Crear un lead (POST)

Con `$B`, `$T` y `$TOKEN` como en [Las tres llamadas](#las-tres-llamadas):

```bash
curl -si -X POST $B/api/data/v9.2/leads \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "OData-MaxVersion: 4.0" -H "OData-Version: 4.0" \
  -d '{
    "firstname": "Grace",
    "lastname": "Murray Hopper",
    "emailaddress1": "grace@example.com",
    "subject": "Website contact form",
    "description": "Tell us what you are facing...",
    "new_organizationtype": 100000001,
    "new_industrysize": 100000002,
    "new_source": 100000001
  }'
```

Respuesta: `204 No Content`, sin cuerpo, con la cabecera `OData-EntityId: $B/api/data/v9.2/leads(<guid>)`.
Para quedarte con el id y usarlo después:

```bash
ID=$(curl -si -X POST $B/api/data/v9.2/leads -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"lastname":"Lovelace","subject":"Website contact form"}' \
  | grep -i '^odata-entityid' | sed -E 's/.*leads\(([^)]+)\).*/\1/' | tr -d '\r')
```

### Borrar un lead (DELETE)

```bash
curl -si -X DELETE "$B/api/data/v9.2/leads($ID)" -H "Authorization: Bearer $TOKEN"
```

Respuesta: `204 No Content`. Un id que no existe da `404` (`lead With Id = <guid> Does Not Exist`, `0x80040217`) y un
id mal formado da `400` (`Unrecognized Guid format.`).

En Netlify el estado vive en Blobs (*last-writer-wins*) y las instancias pueden ver datos un poco desactualizados: un
`DELETE` justo después del `POST`, o del listado, puede dar `404` aunque el lead exista. Si pasa, reintenta pasados unos
segundos (en una prueba el segundo intento dio `204`).

Para encontrar el `leadid` de un lead: `GET $B/_mock/records` (sin auth) o el visor `GET $B/_mock/`.
Para borrarlos **todos**, `POST $B/_mock/reset`, que también borra el log de requests y la configuración; es destructivo,
así que para limpiar solo los de prueba es mejor un `DELETE` por id.

### Errores de validación (400)

Formato `{"error":{"code":"0x0","message":"..."}}`. Los mensajes que produce el formulario si algo no cuadra:

| Causa | `message` |
|---|---|
| Falta `lastname` o `subject` | `The attribute 'lastname' of the 'lead' entity is required.` |
| Campo que no existe en el esquema | `An error occurred while validating input parameters: Invalid property 'x' was found in entity 'Microsoft.Dynamics.CRM.lead'.` |
| Entero fuera de lista | `The option value 5 is not valid for the attribute 'new_source'.` |
| Texto en vez de entero | `Property 'new_source' expects an integer option value but got string.` |
| Texto más largo que `max_length` | `The length of the 'lastname' attribute of the 'lead' entity exceeded the maximum allowed length of '50'.` |

## Endpoints

- `POST /{tenant}/oauth2/v2.0/token`
- `/api/data/v9.2`: `POST /leads`, `GET /leads`, `GET|PATCH|DELETE /leads({id})`, `GET /WhoAmI`.
  Fuera de alcance: `$expand`, `$batch`, `$metadata`, otros flujos OAuth. `PATCH` no hace upsert (404 si no existe).
  `$filter` soporta solo `campo eq valor` unido con `and`.
- Admin (sin auth): `GET /_mock/` (visor HTML), `GET /_mock/records`, `GET /_mock/requests?limit=`,
  `POST /_mock/reset` (borra registros, log y config), `GET|PATCH /_mock/config`, `/_mock/docs`.

## Despliegue en Netlify (versión TypeScript)

Netlify Functions no ejecuta Python, así que el despliegue usa un **port a TypeScript** del mismo contrato
(`src/*.ts`, que reutiliza el mismo `schema.yaml`). La versión Python (`app/`) sigue siendo válida para uso local.

- `netlify/functions/d365-mock.ts`: función (API moderna `Request` → `Response`). Declara sus rutas en
  `export const config = { path: [...] }`: `/:tenant/oauth2/v2.0/token`, `/api/data/*`, `/_mock` y `/_mock/*`.
- `netlify.toml`: `NODE_VERSION=20`, esbuild e `included_files = ["schema.yaml"]`. `public/index.html` es la página de inicio.
- **Persistencia con Netlify Blobs**: las instancias de la función no comparten memoria (en `netlify dev` ni siquiera
  entre dos requests seguidos), así que registros, log de requests y `/_mock/config` se guardan en un blob y se
  rehidratan en cada request. Es *last-writer-wins*: suficiente para un mock, no para concurrencia alta.

```bash
npm install
npm test                 # vitest: contract tests de la versión TS
npm run dev              # servidor local en http://localhost:8000 (en memoria, sin Netlify CLI)
npm run dev:netlify      # netlify dev: runtime real de funciones + Blobs locales
```

### Instancia desplegada

URL base: **https://d365-simulator.netlify.app** (úsala como `B` en los ejemplos: `B=https://d365-simulator.netlify.app`).

- Visor de registros: <https://d365-simulator.netlify.app/_mock/>
- Registros en JSON (sin auth): <https://d365-simulator.netlify.app/_mock/records>
- Log de requests: <https://d365-simulator.netlify.app/_mock/requests?limit=20>
- Configuración y fallas: `GET|PATCH /_mock/config`

Pasos de despliegue:

1. Conecta el repo en Netlify (publish `public`, functions `netlify/functions`; ya está en `netlify.toml`).
2. Define en *Site settings → Environment variables*: `MOCK_TENANT_ID`, `MOCK_CLIENT_ID`, `MOCK_CLIENT_SECRET`,
   `TOKEN_TTL_SECONDS` y, opcional, `MOCK_BASE_URL`. **Si no la defines, el mock usa el origen de cada petición**
   (`https://<sitio>.netlify.app`) como `aud` y como scope esperado (`<origen>/.default`). Fíjala si usas varios
   dominios o deploy previews, para que `aud` y scope no cambien según el host.
3. En la app Next.js apunta la autoridad y el recurso a `https://<sitio>.netlify.app` (ya es https).
4. Vuelve a desplegar tras cambiar variables (no aplican hasta el siguiente deploy).

Ojo en local: `netlify dev` inyecta el `.env`. Si tu `.env` define `MOCK_BASE_URL=http://localhost:8000`, el scope
esperado será `http://localhost:8000/.default` aunque llames a `:8888`.

Qué se verificó y qué no:

- Verificado: 45 tests de vitest contra el handler (53 en la suite Python); la función carga y responde bajo `netlify dev` (token → crear →
  leer en invocaciones distintas, con Blobs locales); `tsc --noEmit` sin errores.
- **No verificado: un despliegue real en Netlify** (requiere cuenta/sitio). Blobs en producción usa el contexto
  que Netlify inyecta en las funciones; si el primer deploy falla al guardar, el error aparece en los logs de la
  función (`No se pudo cargar/guardar el estado`) y el mock sigue respondiendo con estado en memoria.
- Los timeouts de las funciones de Netlify (10 s por defecto) cortan las fallas `slow` y `timeout` largas:
  devolverá 502/504 de Netlify en vez de la respuesta del mock.
- El port TS no incluye `/_mock/docs` ni volcado a JSON (`MOCK_PERSIST_FILE`); la persistencia es Blobs.

## Esquema (`schema.yaml`)

Define entity set, nombre lógico, clave primaria y campos (`string`, `memo`, `optionset`, `boolean`, `datetime`)
con `required`, `max_length` y `options`. **La obligatoriedad (`lastname` y `subject` requeridos), las longitudes y los
campos `new_*` son provisionales: deben alinearse con lo que confirme el cliente. Son definitivos solo los textos de `new_source`
(salen del diseño); nombres y códigos del resto, incluidos `new_organizationtype` y `new_industrysize`, no.**
Detalle de los campos del formulario en [Formulario de contacto](#formulario-de-contacto-leads).
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
