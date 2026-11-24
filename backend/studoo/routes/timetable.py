"""Emploi du temps : liens iCal, fichiers .ics et connecteur Pronote.

Règle de sécurité : tout ce qui donne accès à l'emploi du temps (lien iCal
privé, jeton Pronote) est renvoyé au navigateur sous forme SCELLÉE (chiffrée).
Le navigateur le range dans le Drive de l'élève et le renvoie pour se
synchroniser. Aucun mot de passe n'est conservé, ni écrit dans les journaux.
"""
from datetime import timedelta
from typing import Annotated, Literal
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, SecretStr
from starlette.concurrency import run_in_threadpool

from .. import db
from ..deps import User, current_user
from ..limits import rate_limit
from ..services import pronote
from ..services.ics import _check_host, fetch_working, parse_ics
from ..services.sealed import seal, unseal

router = APIRouter(prefix="/api/timetable", tags=["timetable"])
CurrentUser = Annotated[User, Depends(current_user)]


def _window(days_before: int = 7, days_after: int = 35):
    today = db.today()
    return today - timedelta(days=days_before), today + timedelta(days=days_after)


def _result(events_payload: dict, sub: str, keep: dict | None) -> dict:
    return {
        "events": events_payload["events"],
        "subjects": events_payload["subjects"],
        "sealed": seal(sub, keep) if keep else None,
        "method": keep["kind"] if keep else None,
    }


class UrlIn(BaseModel):
    url: str = Field(min_length=8, max_length=2000)


@router.post("/ics-url")
async def from_url(body: UrlIn, user: CurrentUser):
    """Ajoute un lien iCal (ADE, Celcat, HyperPlanning, Pronote…) et le renvoie scellé."""
    rate_limit(f"ics:{user.sub}", limit=30, window_seconds=600)
    start, end = _window()
    working_url, data = await fetch_working(body.url, start, end)
    return _result(data, user.sub, {"kind": "ical", "url": working_url})


class FileIn(BaseModel):
    content: str = Field(min_length=10, max_length=3_000_000)


@router.post("/ics-file")
async def from_file(body: FileIn, user: CurrentUser):
    rate_limit(f"ics:{user.sub}", limit=30, window_seconds=600)
    start, end = _window()
    return parse_ics(body.content, start, end)


class SyncIn(BaseModel):
    sealed: str = Field(min_length=20, max_length=8000)


@router.post("/sync")
async def sync(body: SyncIn, user: CurrentUser):
    """Met à jour l'emploi du temps à partir d'une source scellée."""
    rate_limit(f"sync:{user.sub}", limit=60, window_seconds=600)
    keep = unseal(user.sub, body.sealed)
    start, end = _window()
    if keep.get("kind") == "ical":
        _, data = await fetch_working(keep["url"], start, end)
        return {**data, "sealed": None, "method": "ical"}
    if keep.get("kind") == "pronote-token":
        events, new_keep = await run_in_threadpool(
            pronote.login, "token", url=keep["url"], username=keep["username"], password=keep["token"], uuid=keep["uuid"],
        )
        # Pronote donne un nouveau jeton à chaque connexion : on renvoie le nouveau, scellé.
        return _result({"events": events, "subjects": pronote.subjects(events)}, user.sub, new_keep)
    raise HTTPException(422, detail={"code": "bad_token", "message": "Source inconnue."})


@router.get("/ents")
async def list_ents():
    """ENT régionaux dont la connexion est prise en charge (pour la liste déroulante)."""
    return {"ents": [{"id": k, "name": v} for k, v in pronote.ENTS.items()]}


class PronoteIn(BaseModel):
    mode: Literal["qr", "password", "ent"]
    url: str = Field(default="", max_length=300)
    username: str = Field(default="", max_length=120)
    password: SecretStr = Field(default=SecretStr(""), max_length=200)  # SecretStr : jamais affiché en clair
    ent: str = Field(default="", max_length=60)
    qr: dict | None = None
    pin: str = Field(default="", max_length=4)
    uuid: str = Field(default="", max_length=64)


def _check_pronote_url(url: str) -> str:
    url = url.strip()
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or "pronote" not in parsed.path.lower():
        raise HTTPException(422, detail={
            "code": "bad_url",
            "message": "Colle l'adresse de ta page Pronote (elle commence par https:// et contient « pronote »).",
        })
    _check_host(parsed.hostname)
    return url


@router.post("/pronote")
def pronote_login(body: PronoteIn, user: CurrentUser):
    """Connexion Pronote (fonction synchrone : FastAPI l'exécute dans un fil séparé)."""
    rate_limit(f"pronote:{user.sub}", limit=8, window_seconds=600)
    if body.mode == "qr":
        qr = body.qr
        if not isinstance(qr, dict) or not {"url", "jeton", "login"} <= set(qr) or not body.pin.isdigit() or len(body.pin) != 4:
            raise HTTPException(422, detail={"code": "bad_qr", "message": "QR code ou code PIN invalide."})
        _check_pronote_url(str(qr["url"]))
        if len(body.uuid) < 8:
            raise HTTPException(422, detail={"code": "invalid", "message": "Identifiant d'appareil manquant."})
        kwargs = {"qr": qr, "pin": body.pin, "uuid": body.uuid}
    else:
        if not body.username or not body.password.get_secret_value():
            raise HTTPException(422, detail={"code": "invalid", "message": "Identifiant et mot de passe requis."})
        if body.mode == "ent" and body.ent not in pronote.ENTS:
            raise HTTPException(422, detail={"code": "invalid", "message": "ENT non pris en charge."})
        kwargs = {"url": _check_pronote_url(body.url), "username": body.username,
                  "password": body.password.get_secret_value(), "ent": body.ent}
    events, keep = pronote.login(body.mode, **kwargs)
    return _result({"events": events, "subjects": pronote.subjects(events)}, user.sub, keep)
