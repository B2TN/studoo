"""Emploi du temps : robot de connexion (lycées), liens iCal et fichiers .ics (dernier recours).

Règles de sécurité :
- le mot de passe tapé pour le robot ne vit que dans la mémoire de la requête (≤ 2 min, région Paris) :
  jamais écrit en base, dans un fichier ou un journal ; il disparaît à la fin de la requête dans tous les cas
  (réussite, erreur, délai dépassé, plantage) ;
- tout ce qui donne accès à l'emploi du temps ensuite (lien iCal privé) est renvoyé au navigateur sous forme
  SCELLÉE (chiffrée) ; le navigateur le range dans le Drive de l'élève et le renvoie pour se synchroniser.
"""
from datetime import timedelta
from typing import Annotated, Literal
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, SecretStr
from starlette.concurrency import run_in_threadpool

from .. import db
from ..deps import User, current_user
from ..limits import rate_limit
from ..services import ade, pronote
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


ANNUAIRE = "https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-annuaire-education/records"


@router.get("/schools")
async def schools(user: CurrentUser, q: str = Query(min_length=2, max_length=80)):
    """Recherche d'un lycée ou collège dans l'annuaire officiel (données publiques de l'Éducation nationale)."""
    rate_limit(f"schools:{user.sub}", limit=60, window_seconds=600)
    words = [w for w in "".join(c if c.isalnum() or c in " -'" else " " for c in q).split() if len(w) > 1][:5]
    if not words:
        return {"schools": []}
    where = " and ".join(f'(search(nom_etablissement, "{w}") or search(nom_commune, "{w}"))' for w in words)
    params = {
        "select": "identifiant_de_l_etablissement,nom_etablissement,nom_commune,type_etablissement",
        "where": f'{where} and type_etablissement in ("Lycée", "Collège") and etat = "OUVERT"',
        "limit": 12,
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(ANNUAIRE, params=params)
            res.raise_for_status()
    except httpx.HTTPError:
        raise HTTPException(503, detail={"code": "unavailable", "message": "L'annuaire des établissements ne répond pas : réessaie."}) from None
    return {"schools": [{"uai": r["identifiant_de_l_etablissement"], "name": r["nom_etablissement"],
                         "city": r["nom_commune"], "type": r["type_etablissement"]} for r in res.json().get("results", [])]}


class ConnectIn(BaseModel):
    uai: str = Field(min_length=8, max_length=8)
    username: str = Field(min_length=1, max_length=120)
    password: SecretStr = Field(min_length=1, max_length=200)  # SecretStr : jamais affiché ni journalisé


@router.post("/connect")
def robot_connect(body: ConnectIn, user: CurrentUser):
    """Le robot : identifiant + mot de passe → emploi du temps (le mot de passe est oublié à la fin de la requête)."""
    rate_limit(f"pronote:{user.sub}", limit=8, window_seconds=600)
    events, keep = pronote.robot_login(body.uai, body.username, body.password.get_secret_value())
    durable = keep if keep.get("kind") == "ical" else None
    out = _result({"events": events, "subjects": pronote.subjects(events)}, user.sub, durable)
    out["method"] = "ical" if durable else "snapshot"  # snapshot : reconnexion conseillée toutes les 2 semaines
    return out


# ---------- Robot des universités (ADE) ----------
class AdeLoginIn(BaseModel):
    university: str = Field(min_length=2, max_length=40)
    username: str = Field(min_length=1, max_length=120)
    password: SecretStr = Field(min_length=1, max_length=200)


class AdeStepIn(BaseModel):
    session: str = Field(min_length=20, max_length=20000)
    project: int = Field(ge=0, le=100000)
    node: dict | None = None  # {"id", "name", "level"} ; absent = racine de l'arborescence


class AdeChooseIn(BaseModel):
    session: str = Field(min_length=20, max_length=20000)
    project: int = Field(ge=0, le=100000)
    resource: int = Field(ge=0, le=100_000_000)
    label: str = Field(default="", max_length=300)


def _ade_state(sub: str, sealed: str) -> dict:
    state = unseal(sub, sealed)
    if state.get("kind") != "ade-session":
        raise HTTPException(422, detail={"code": "bad_token", "message": "Session ADE invalide : reconnecte-toi."})
    return state


@router.get("/universities")
async def universities():
    return {"universities": [{"id": k, "name": v["name"], "tested": v["tested"]} for k, v in ade.UNIVERSITIES.items()]}


@router.post("/ade/login")
def ade_login(body: AdeLoginIn, user: CurrentUser):
    """Étape 1 : connexion à l'université (le SEUL moment où le mot de passe sert), puis liste des années ADE."""
    rate_limit(f"ade:{user.sub}", limit=8, window_seconds=600)
    uni = ade.UNIVERSITIES.get(body.university)
    if not uni:
        raise HTTPException(422, detail={"code": "invalid", "message": "Université non prise en charge par le robot."})
    client = ade.login(uni["base"], body.username, body.password.get_secret_value())
    try:
        gwt = ade.discover(client, uni["base"])
        ade.register(client, gwt)
        projects = ade.projects(client, gwt)
        state = {"kind": "ade-session", **ade.dump(client, uni["base"], gwt)}
    finally:
        client.close()
    return {"session": seal(user.sub, state), "projects": projects}


@router.post("/ade/tree")
def ade_tree(body: AdeStepIn, user: CurrentUser):
    """Étapes suivantes : contenu d'un dossier (établissement → filière → classe). Aucun mot de passe ici."""
    rate_limit(f"ade-tree:{user.sub}", limit=120, window_seconds=600)
    state = _ade_state(user.sub, body.session)
    client = ade.resume(state)
    try:
        node = body.node or {}
        if not node:
            ade.load_project(client, state["gwt"], body.project)
        nodes = ade.children(client, state["gwt"], int(node.get("id", -1)), str(node.get("name", "Formations"))[:200],
                             int(node.get("level", 0)))
    except httpx.HTTPError:
        raise HTTPException(503, detail={"code": "unavailable", "message": "ADE ne répond pas : réessaie."}) from None
    finally:
        client.close()
    return {"nodes": nodes}


@router.post("/ade/choose")
async def ade_choose(body: AdeChooseIn, user: CurrentUser):
    """Dernière étape : la classe choisie → lien d'export iCal officiel (lisible sans identifiant), gardé chiffré."""
    rate_limit(f"ics:{user.sub}", limit=30, window_seconds=600)
    state = _ade_state(user.sub, body.session)
    start, end = _window()
    working_url, data = await fetch_working(ade.export_url(state["base"], body.project, body.resource), start, end)
    out = _result(data, user.sub, {"kind": "ical", "url": working_url})
    out["label"] = body.label
    return out


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
