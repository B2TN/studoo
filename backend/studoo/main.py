"""Point d'entrée de l'API Studoo (FastAPI)."""
import logging

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, RedirectResponse

from .config import get_settings
from .deps import csrf_guard
from .routes import admin, ai, auth, jobs, keys, site, timetable

# httpx écrit chaque adresse appelée : elles peuvent contenir des jetons (ticket de connexion de l'université,
# clés…). On ne garde que les avertissements.
for noisy in ("httpx", "httpcore"):
    logging.getLogger(noisy).setLevel(logging.WARNING)

from . import monitoring

monitoring.setup(get_settings().sentry_dsn, environment="local" if get_settings().is_local else "production")

app = FastAPI(
    title="Studoo API",
    docs_url="/api/docs" if get_settings().is_local else None,
    redoc_url=None,
    openapi_url="/api/openapi.json" if get_settings().is_local else None,
    dependencies=[Depends(csrf_guard)],
)

for module in (auth, site, ai, timetable, jobs, keys, admin):
    app.include_router(module.router)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    # HTTPS forcé : toute requête arrivée en HTTP est redirigée.
    if request.headers.get("x-forwarded-proto") == "http" and not get_settings().is_local:
        return RedirectResponse(str(request.url.replace(scheme="https")), status_code=308)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Cache-Control"] = "no-store"
    if get_settings().secure_cookies:
        response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload"
    return response


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError):
    """Messages d'erreur de formulaire lisibles, en français."""
    errors = []
    for err in exc.errors():
        field = ".".join(str(p) for p in err.get("loc", []) if p not in {"body", "query"})
        msg = err.get("msg", "Valeur invalide").removeprefix("Value error, ")
        errors.append({"field": field, "message": msg})
    first = errors[0]["message"] if errors else "Données invalides."
    return JSONResponse(status_code=422, content={"detail": {"code": "invalid", "message": first, "errors": errors}})
