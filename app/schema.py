import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import yaml

from .responses import DataverseError

TYPES = {"string", "memo", "optionset", "boolean", "datetime"}
GUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


@dataclass
class Field:
    name: str
    type: str
    required: bool = False
    max_length: int | None = None
    options: dict[int, str] = field(default_factory=dict)


@dataclass
class Schema:
    entity_set: str
    logical_name: str
    primary_key: str
    fields: dict[str, Field]

    @property
    def type_name(self) -> str:
        return f"Microsoft.Dynamics.CRM.{self.logical_name}"

    @property
    def readable(self) -> set[str]:
        return set(self.fields) | {self.primary_key, "createdon", "modifiedon"}


def load_schema(path: str) -> Schema:
    raw = yaml.safe_load(Path(path).read_text())["entity"]
    fields = {}
    for name, spec in raw["fields"].items():
        if spec["type"] not in TYPES:
            raise ValueError(f"schema: campo '{name}' con tipo desconocido '{spec['type']}'")
        fields[name] = Field(
            name=name,
            type=spec["type"],
            required=bool(spec.get("required", False)),
            max_length=spec.get("max_length"),
            options={int(k): v for k, v in (spec.get("options") or {}).items()},
        )
    return Schema(raw["entity_set"], raw["logical_name"], raw["primary_key"], fields)


def _bad(message: str) -> DataverseError:
    # Código 0x0 verificado para errores de validación de entrada; los mensajes son aproximados.
    return DataverseError(400, message, "0x0")


def validate(schema: Schema, body: dict, *, creating: bool) -> None:
    """Valida un payload de POST/PATCH contra el esquema. Lanza DataverseError 400."""
    for key, value in body.items():
        if key == schema.primary_key:
            if not isinstance(value, str) or not GUID_RE.match(value):
                raise _bad(f"Unrecognized Guid format for property '{key}'.")
            continue
        f = schema.fields.get(key)
        if f is None:
            raise _bad(
                "An error occurred while validating input parameters: "
                f"Invalid property '{key}' was found in entity '{schema.type_name}'."
            )
        if value is None:
            if f.required:
                raise _bad(f"The attribute '{key}' of the '{schema.logical_name}' entity is required and cannot be null.")
            continue
        _check_value(schema, f, value)

    if creating:
        for f in schema.fields.values():
            if f.required and body.get(f.name) is None:
                raise _bad(f"The attribute '{f.name}' of the '{schema.logical_name}' entity is required.")


def _check_value(schema: Schema, f: Field, value) -> None:
    if f.type in ("string", "memo"):
        if not isinstance(value, str):
            raise _bad(f"Property '{f.name}' expects a string value but got {type(value).__name__}.")
        if f.max_length is not None and len(value) > f.max_length:
            raise _bad(
                f"The length of the '{f.name}' attribute of the '{schema.logical_name}' entity "
                f"exceeded the maximum allowed length of '{f.max_length}'."
            )
    elif f.type == "optionset":
        if isinstance(value, bool) or not isinstance(value, int):
            raise _bad(f"Property '{f.name}' expects an integer option value but got {type(value).__name__}.")
        if value not in f.options:
            raise _bad(f"The option value {value} is not valid for the attribute '{f.name}'.")
    elif f.type == "boolean":
        if not isinstance(value, bool):
            raise _bad(f"Property '{f.name}' expects a boolean value but got {type(value).__name__}.")
    elif f.type == "datetime":
        try:
            if not isinstance(value, str):
                raise ValueError
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            raise _bad(f"Property '{f.name}' expects an ISO 8601 datetime string.") from None
