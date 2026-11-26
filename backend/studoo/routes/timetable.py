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
from ..services import ade, aurion, higher, hyperplanning, pronote
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
    if keep.get("kind") == "celcat":
        def read():
            with httpx.Client(timeout=ade.TIMEOUT, headers={"User-Agent": ade.UA}) as client:
                return higher.celcat_events(client, _public_https(keep["base"]), keep["fid"])
        events = await run_in_threadpool(read)
        return {"events": events, "subjects": pronote.subjects(events), "sealed": None, "method": "celcat"}
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
def _public_https(url: str) -> str:
    """Adresse d'un logiciel d'emploi du temps : HTTPS, hôte public (jamais une adresse interne)."""
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise HTTPException(422, detail={"code": "bad_url", "message": "Adresse d'emploi du temps invalide."})
    _check_host(parsed.hostname)
    return f"https://{parsed.hostname}{parsed.path.rstrip('/')}"


class AdeLoginIn(BaseModel):
    university: str = Field(default="", max_length=40)
    base: str = Field(default="", max_length=200)  # adresse ADE détectée (recherche d'établissement)
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


def _ade_guard(step: str):
    """Erreur inattendue du robot ADE → message clair (jamais une « erreur 500 »), journal sans contenu."""
    import contextlib
    import logging

    @contextlib.contextmanager
    def guard():
        try:
            yield
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            logging.getLogger("studoo.ade").warning("Robot ADE (%s) : %s", step, type(exc).__name__)
            raise HTTPException(502, detail={"code": "ade_robot", "message": "Le robot n'a pas compris la réponse d'ADE. "
                                             "Réessaie ; si ça recommence, utilise le dernier recours (.ics)."}) from None
    return guard()


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
    uni = ade.UNIVERSITIES.get(body.university) or ({"base": _public_https(body.base)} if body.base else None)
    if not uni:
        raise HTTPException(422, detail={"code": "invalid", "message": "Université non prise en charge par le robot."})
    experimental = False
    with _ade_guard("connexion"):
        try:
            client, base = ade.login(uni["base"], body.username, body.password.get_secret_value())
            native = None
        except HTTPException as exc:
            if not (isinstance(exc.detail, dict) and exc.detail.get("code") == "ade_native"):
                raise
            # ADE avec ses propres identifiants (pas la page de l'université) : robot EXPÉRIMENTAL
            native = ade.login_native(uni["base"], body.username, body.password.get_secret_value())
            client, base, experimental = native[0], uni["base"], True
        try:
            if native:
                gwt, projects = native[1], native[2]
            else:
                gwt = ade.discover(client, base)
                ade.register(client, gwt)
                projects = ade.projects(client, gwt)
            state = {"kind": "ade-session", **ade.dump(client, base, gwt)}
        finally:
            client.close()
    return {"session": seal(user.sub, state), "projects": projects, "experimental": experimental}


@router.post("/ade/tree")
def ade_tree(body: AdeStepIn, user: CurrentUser):
    """Étapes suivantes : contenu d'un dossier (établissement → filière → classe). Aucun mot de passe ici."""
    rate_limit(f"ade-tree:{user.sub}", limit=120, window_seconds=600)
    state = _ade_state(user.sub, body.session)
    client = ade.resume(state)
    try:
        with _ade_guard("arborescence"):
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


# ---------- Supérieur : recherche, détection du logiciel, Celcat ----------
@router.get("/higher")
async def higher_search(user: CurrentUser, q: str = Query(min_length=2, max_length=80)):
    """Universités et écoles (annuaire officiel du ministère de l'Enseignement supérieur)."""
    rate_limit(f"schools:{user.sub}", limit=60, window_seconds=600)
    try:
        return {"schools": await higher.search(q)}
    except httpx.HTTPError:
        raise HTTPException(503, detail={"code": "unavailable", "message": "L'annuaire des établissements ne répond pas : réessaie."}) from None


class DetectIn(BaseModel):
    domain: str = Field(min_length=4, max_length=120)


@router.post("/higher/detect")
async def higher_detect(body: DetectIn, user: CurrentUser):
    """Quel logiciel d'emploi du temps utilise cet établissement ? (ADE, Celcat, HyperPlanning, Aurion…)"""
    rate_limit(f"detect:{user.sub}", limit=20, window_seconds=600)
    systems = await higher.detect(body.domain)
    return {"systems": [{**x, "name": higher.SOFTWARE_NAMES[x["software"]]} for x in systems]}


class CelcatIn(BaseModel):
    base: str = Field(min_length=10, max_length=200)
    session: str = Field(default="", max_length=20000)
    q: str = Field(default="", max_length=80)
    group: str = Field(default="", max_length=200)
    label: str = Field(default="", max_length=200)


class CelcatLoginIn(BaseModel):
    base: str = Field(min_length=10, max_length=200)
    username: str = Field(min_length=1, max_length=120)
    password: SecretStr = Field(min_length=1, max_length=200)


def _celcat_client(user: User, body: CelcatIn):
    base = _public_https(body.base)
    if body.session:
        state = unseal(user.sub, body.session)
        if state.get("kind") != "celcat-session" or state.get("base") != base:
            raise HTTPException(422, detail={"code": "bad_token", "message": "Session Celcat invalide : reconnecte-toi."})
        return base, ade.resume(state)
    return base, httpx.Client(timeout=ade.TIMEOUT, headers={"User-Agent": ade.UA})


@router.post("/celcat/login")
def celcat_login(body: CelcatLoginIn, user: CurrentUser):
    """Celcat protégé : connexion par la page de l'université (seule étape qui utilise le mot de passe)."""
    rate_limit(f"ade:{user.sub}", limit=8, window_seconds=600)
    base = _public_https(body.base)
    with _ade_guard("connexion Celcat"):
        client, _res = ade.sso_login(f"{base}/", body.username, body.password.get_secret_value(),
                                     back=lambda r: "/calendar" in r.url.path.lower() and "password" not in r.text.lower()[:20000])
        try:
            state = {"kind": "celcat-session", **ade.dump(client, base, {})}
        finally:
            client.close()
    return {"session": seal(user.sub, state)}


@router.post("/celcat/groups")
def celcat_groups(body: CelcatIn, user: CurrentUser):
    rate_limit(f"ade-tree:{user.sub}", limit=120, window_seconds=600)
    base, client = _celcat_client(user, body)
    try:
        with _ade_guard("groupes Celcat"):
            return {"groups": higher.celcat_groups(client, base, body.q.strip())}
    finally:
        client.close()


@router.post("/celcat/choose")
def celcat_choose(body: CelcatIn, user: CurrentUser):
    """Groupe choisi. Celcat public : on garde (chiffré) l'adresse + le groupe, relus à chaque visite, sans
    identifiant. Celcat protégé : copie des cours + rappel de reconnexion (la session ne dure pas)."""
    rate_limit(f"ics:{user.sub}", limit=30, window_seconds=600)
    if not body.group:
        raise HTTPException(422, detail={"code": "invalid", "message": "Choisis ton groupe."})
    base, client = _celcat_client(user, body)
    try:
        with _ade_guard("cours Celcat"):
            events = higher.celcat_events(client, base, body.group)
    finally:
        client.close()
    keep = None if body.session else {"kind": "celcat", "base": base, "fid": body.group}
    out = _result({"events": events, "subjects": pronote.subjects(events)}, user.sub, keep)
    out["method"] = "celcat" if keep else "snapshot"
    out["label"] = body.label or body.group
    return out


# ---------- Robots EXPÉRIMENTAUX (itération 6) : HyperPlanning et Aurion ----------
# Construits sans compte de test (voir services/hyperplanning.py et services/aurion.py) : l'interface les
# présente comme expérimentaux. Mêmes règles que les autres robots : le mot de passe ne vit que dans cette
# requête (SecretStr, jamais journalisé), puis disparaît, que ça marche ou non.
class RobotLoginIn(BaseModel):
    base: str = Field(min_length=10, max_length=200)
    username: str = Field(min_length=1, max_length=120)
    password: SecretStr = Field(min_length=1, max_length=200)
    label: str = Field(default="", max_length=200)


def _robot_guard(service: str):
    """Erreur inattendue d'un robot → message clair (« page modifiée »), journal sans contenu."""
    import contextlib
    import logging

    @contextlib.contextmanager
    def guard():
        try:
            yield
        except HTTPException:
            raise
        except httpx.TimeoutException:
            raise HTTPException(504, detail={"code": "timeout", "message": f"{service} met trop de temps à répondre."}) from None
        except Exception as exc:  # noqa: BLE001
            logging.getLogger("studoo.robots").warning("Robot %s : %s", service, type(exc).__name__)
            raise HTTPException(502, detail={"code": "page_changed", "message": f"Le robot n'a pas compris la réponse de {service}. "
                                             "Utilise le dernier recours (.ics) et signale-nous ton établissement."}) from None
    return guard()


@router.post("/hyperplanning")
async def hyperplanning_login(body: RobotLoginIn, user: CurrentUser):
    """HyperPlanning : connexion → adresse iCal personnelle (vérifiée), gardée chiffrée : mises à jour sans mot de passe."""
    rate_limit(f"ade:{user.sub}", limit=8, window_seconds=600)
    base = _public_https(body.base)
    with _robot_guard("HyperPlanning"):
        url = await run_in_threadpool(hyperplanning.robot, base, body.username, body.password.get_secret_value())
    start, end = _window()
    working_url, data = await fetch_working(url, start, end)
    out = _result(data, user.sub, {"kind": "ical", "url": working_url})
    out.update(method="ical", experimental=True, label=body.label or "HyperPlanning")
    return out


@router.post("/aurion")
def aurion_login(body: RobotLoginIn, user: CurrentUser):
    """Aurion : connexion → cours des prochaines semaines (pas de lien iCal dans Aurion : copie + rappel de reconnexion)."""
    rate_limit(f"ade:{user.sub}", limit=8, window_seconds=600)
    base = _public_https(body.base)
    with _robot_guard("Aurion"):
        events = aurion.robot(base, body.username, body.password.get_secret_value())
    out = _result({"events": events, "subjects": pronote.subjects(events)}, user.sub, None)
    out.update(method="snapshot", experimental=True, label=body.label or "Aurion")
    return out


# ---------- Signaler un établissement (itération 6, C4) ----------
# Après une erreur du robot ou un établissement non reconnu : l'élève peut nous dire QUEL établissement pose
# problème, pour qu'il soit pris en charge ensuite. Jamais d'identifiant, de mot de passe ni de cours.
REPORT_SOFTWARE = {"ade", "celcat", "hyperplanning", "aurion", "pronote", "ent", "autre", "inconnu"}
REPORT_ERRORS = {"bad_credentials", "two_factor", "page_changed", "timeout", "blocked", "unavailable", "not_recognized",
                 "ade_native_refused", "login_page", "login_loop", "ade_robot", "other"}


class ReportIn(BaseModel):
    establishment: str = Field(min_length=2, max_length=200)
    software: str = Field(default="inconnu", max_length=40)
    error_code: str = Field(default="other", max_length=40)
    website: str = Field(default="", max_length=200)  # pot de miel : un humain ne le voit pas
    elapsed_ms: int = Field(default=0, ge=0)


def _reporter(sub: str) -> str:
    import hashlib
    import hmac
    from ..config import get_settings
    return hmac.new(get_settings().session_secret.encode(), b"school-report|" + sub.encode(), hashlib.sha256).hexdigest()[:48]


@router.post("/report")
def report_school(body: ReportIn, user: CurrentUser):
    rate_limit(f"report:{user.sub}", limit=6, window_seconds=3600)
    name = " ".join("".join(ch for ch in body.establishment if ch.isprintable()).split())[:200]
    if len(name) < 2:
        raise HTTPException(422, detail={"code": "invalid", "message": "Indique le nom de ton établissement."})
    if body.website or body.elapsed_ms < 1500:  # robot : on fait comme si de rien n'était, sans rien garder
        return {"ok": True, "duplicate": False}
    software = body.software if body.software in REPORT_SOFTWARE else "autre"
    error = body.error_code if body.error_code in REPORT_ERRORS else "other"
    who = _reporter(user.sub)
    with db.get_engine().begin() as conn:
        from sqlalchemy import func, insert, select
        recent = conn.execute(select(func.count()).select_from(db.school_reports).where(
            db.school_reports.c.reporter == who, db.school_reports.c.software == software,
            func.lower(db.school_reports.c.establishment) == name.lower(),
            db.school_reports.c.created_at > db.now() - timedelta(days=1))).scalar_one()
        if not recent:
            conn.execute(insert(db.school_reports).values(created_at=db.now(), establishment=name, software=software,
                                                          error_code=error, reporter=who))
    return {"ok": True, "duplicate": bool(recent)}


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
