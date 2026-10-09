import re
import uuid

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response

from .auth import require_token
from .faults import inject_faults
from .responses import DataverseError, dv_json
from .schema import GUID_RE, Schema, validate
from .store import now_iso

router = APIRouter(prefix="/api/data/v9.2", dependencies=[Depends(inject_faults), Depends(require_token)])

SEGMENT_RE = re.compile(r"^([A-Za-z_]\w*)(?:\(([^()]*)\))?$")
CLAUSE_RE = re.compile(r"^\s*(\w+)\s+eq\s+(.+?)\s*$", re.IGNORECASE)


def _not_found_segment(segment: str) -> DataverseError:
    return DataverseError(404, f"Resource not found for the segment '{segment}'.", "0x8006088a")


def _bad(message: str) -> DataverseError:
    return DataverseError(400, message, "0x0")


def _wants_representation(request: Request) -> bool:
    prefer = request.headers.get("prefer", "")
    return "return=representation" in [p.strip().lower() for p in prefer.split(",")]


def _parse_select(request: Request, schema: Schema) -> list[str] | None:
    raw = request.query_params.get("$select")
    if not raw:
        return None
    cols = [c.strip() for c in raw.split(",") if c.strip()]
    for c in cols:
        if c not in schema.readable:
            raise _bad(f"Could not find a property named '{c}' on type '{schema.type_name}'.")
    return cols


def _project(record: dict, schema: Schema, select: list[str] | None) -> dict:
    if select is None:
        cols = [*schema.fields, "createdon", "modifiedon"]
    else:
        cols = [c for c in select if c != schema.primary_key]
    out = {c: record.get(c) for c in cols}
    out[schema.primary_key] = record[schema.primary_key]
    return out


def _entity(record: dict, schema: Schema, select: list[str] | None, base: str) -> dict:
    ctx = f"{base}/api/data/v9.2/$metadata#{schema.entity_set}"
    if select:
        ctx += f"({','.join(select)})"
    return {"@odata.context": f"{ctx}/$entity", "@odata.etag": f'W/"{record["_v"]}"',
            **_project(record, schema, select)}


def _entity_id(base: str, schema: Schema, record_id: str) -> str:
    return f"{base}/api/data/v9.2/{schema.entity_set}({record_id})"


def _parse_literal(text: str):
    if text.startswith("'") and text.endswith("'") and len(text) >= 2:
        return text[1:-1].replace("''", "'")
    low = text.lower()
    if low in ("true", "false"):
        return low == "true"
    if low == "null":
        return None
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        raise _bad(f"Unsupported $filter literal '{text}'.") from None


def _parse_filter(raw: str, schema: Schema) -> list[tuple[str, object]]:
    conds = []
    for clause in re.split(r"\s+and\s+", raw, flags=re.IGNORECASE):
        m = CLAUSE_RE.match(clause)
        if not m:
            raise _bad(f"Unsupported $filter expression '{clause}'. The mock only supports '<field> eq <value>' joined by 'and'.")
        field, literal = m.group(1), _parse_literal(m.group(2))
        if field not in schema.readable:
            raise _bad(f"Could not find a property named '{field}' on type '{schema.type_name}'.")
        conds.append((field, literal))
    return conds


def _matches(record: dict, conds) -> bool:
    for field, expected in conds:
        actual = record.get(field)
        if isinstance(actual, str) and isinstance(expected, str):
            if actual.casefold() != expected.casefold():
                return False
        elif actual != expected:
            return False
    return True


def _whoami(request: Request) -> Response:
    s = request.app.state.settings
    ns = uuid.UUID(s.tenant_id) if re.fullmatch(GUID_RE, s.tenant_id) else uuid.NAMESPACE_DNS
    return dv_json({
        "@odata.context": f"{s.base_url}/api/data/v9.2/$metadata#Microsoft.Dynamics.CRM.WhoAmIResponse",
        "BusinessUnitId": str(uuid.uuid5(ns, "businessunit")),
        "UserId": str(uuid.uuid5(ns, "user")),
        "OrganizationId": str(uuid.uuid5(ns, "organization")),
    })


async def _json_body(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        raise _bad("Invalid JSON. The request body could not be parsed.") from None
    request.state.log_body = body
    if not isinstance(body, dict):
        raise _bad("Invalid JSON. The request body must be a JSON object.")
    return body


@router.api_route("/{segment}", methods=["GET", "POST", "PATCH", "PUT", "DELETE"])
async def entity_route(segment: str, request: Request):
    store, schema = request.app.state.store, request.app.state.schema
    base = request.app.state.settings.base_url
    method = request.method

    m = SEGMENT_RE.match(segment)
    if not m:
        raise _not_found_segment(segment)
    name, key = m.groups()

    if name == "WhoAmI":
        if method != "GET" or key:
            raise DataverseError(404, "No HTTP resource was found that matches the request URI "
                                      f"'{base}/api/data/v9.2/{segment}'.", "0x0")
        return _whoami(request)
    if name != schema.entity_set:
        raise _not_found_segment(name)

    select = _parse_select(request, schema)
    pk = schema.primary_key

    # ---- colección: /leads ----
    if not key:
        if method == "GET":
            conds = _parse_filter(request.query_params["$filter"], schema) if "$filter" in request.query_params else []
            rows = [r for r in store.records.values() if _matches(r, conds)]
            if "$top" in request.query_params:
                top = request.query_params["$top"]
                if not top.isdigit():
                    raise _bad(f"Invalid value '{top}' for $top query option.")
                rows = rows[: int(top)]
            ctx = f"{base}/api/data/v9.2/$metadata#{schema.entity_set}"
            if select:
                ctx += f"({','.join(select)})"
            return dv_json({"@odata.context": ctx,
                            "value": [{"@odata.etag": f'W/"{r["_v"]}"', **_project(r, schema, select)} for r in rows]})
        if method == "POST":
            body = await _json_body(request)
            validate(schema, body, creating=True)
            record_id = body.get(pk) or str(uuid.uuid4())
            if record_id in store.records:
                raise DataverseError(412, f"A record with the same primary key '{record_id}' already exists.", "0x80040237")
            ts = now_iso()
            record = {f: None for f in schema.fields}
            record.update({k: v for k, v in body.items() if k != pk})
            record.update({pk: record_id, "createdon": ts, "modifiedon": ts, "_v": 1})
            store.records[record_id] = record
            store.save()
            if _wants_representation(request):
                return dv_json(_entity(record, schema, select, base), 201,
                               {"Preference-Applied": "return=representation"})
            return Response(status_code=204, headers={"OData-Version": "4.0",
                                                      "OData-EntityId": _entity_id(base, schema, record_id)})
        raise DataverseError(405, f"The HTTP method '{method}' is not allowed on the collection '{schema.entity_set}'.", "0x0")

    # ---- registro: /leads({id}) ----
    if not GUID_RE.match(key):
        raise _bad("Unrecognized Guid format.")
    record_id = key.lower()
    record = store.records.get(record_id)
    if record is None:
        raise DataverseError(404, f"{schema.logical_name} With Id = {record_id} Does Not Exist", "0x80040217")

    if method == "GET":
        return dv_json(_entity(record, schema, select, base))
    if method == "PATCH":
        body = await _json_body(request)
        validate(schema, body, creating=False)
        if pk in body and body[pk].lower() != record_id:
            raise _bad(f"The primary key '{pk}' in the payload does not match the key in the URL.")
        record.update({k: v for k, v in body.items() if k != pk})
        record["modifiedon"] = now_iso()
        record["_v"] += 1
        store.save()
        if _wants_representation(request):
            return dv_json(_entity(record, schema, select, base), 200,
                           {"Preference-Applied": "return=representation"})
        return Response(status_code=204, headers={"OData-Version": "4.0",
                                                  "OData-EntityId": _entity_id(base, schema, record_id)})
    if method == "DELETE":
        del store.records[record_id]
        store.save()
        return Response(status_code=204, headers={"OData-Version": "4.0"})
    raise DataverseError(405, f"The HTTP method '{method}' is not allowed on this resource.", "0x0")


@router.api_route("/{path:path}", methods=["GET", "POST", "PATCH", "PUT", "DELETE"])
async def no_route(path: str, request: Request):
    base = request.app.state.settings.base_url
    raise DataverseError(404, f"No HTTP resource was found that matches the request URI '{base}/api/data/v9.2/{path}'.", "0x0")
