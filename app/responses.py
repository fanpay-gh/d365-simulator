from fastapi.responses import JSONResponse

MEDIA = "application/json; odata.metadata=minimal"


class DataverseError(Exception):
    """Error con el formato de Dataverse: {"error": {"code", "message"}}."""

    def __init__(self, status: int, message: str, code: str = "0x0", headers: dict | None = None):
        self.status, self.message, self.code, self.headers = status, message, code, headers or {}


def dv_json(content, status: int = 200, headers: dict | None = None) -> JSONResponse:
    return JSONResponse(
        content, status_code=status, media_type=MEDIA,
        headers={"OData-Version": "4.0", **(headers or {})},
    )


def dv_error_response(exc: DataverseError) -> JSONResponse:
    return dv_json({"error": {"code": exc.code, "message": exc.message}}, exc.status, exc.headers)
