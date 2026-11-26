"""Routes publiques : configuration, mesure d'audience maison, formulaire de contact."""
import random
import re
import time
from datetime import timedelta

from fastapi import APIRouter, Request
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import delete, insert
from sqlalchemy.exc import IntegrityError

from .. import db
from ..config import get_settings
from ..limits import client_ip, rate_limit
from ..security import daily_visitor_hash

router = APIRouter(prefix="/api", tags=["site"])

PATH_RE = re.compile(r"^/[a-z0-9\-/:]{0,120}$")


@router.get("/config")
async def public_config():
    """Infos publiques dont le navigateur a besoin (aucune clé secrète)."""
    s = get_settings()
    return {
        "appName": s.app_name,
        "googleClientId": s.google_client_id,
        "devLogin": s.dev_login_enabled,
        "aiFake": s.ai_fake_enabled,
        "vapidPublicKey": s.vapid_public_key,
    }


# Services d'emploi du temps à joindre depuis l'hébergeur (certains bloquent les serveurs).
CONNECTOR_HOSTS = {
    "Pronote (serveur de démonstration)": "https://demo.index-education.net/pronote/eleve.html",
    "Monlycée.net": "https://auth.monlycee.net/",
    "Mon Bureau Numérique": "https://cas.monbureaunumerique.fr/login",
    "ENT Hauts-de-France": "https://enthdf.fr/",
    "Toutatice": "https://www.toutatice.fr/",
    "Université Paris Cité (CAS)": "https://auth.u-paris.fr/idp/profile/cas/login",
    "ADE Paris Cité": "https://adeconsult.app.u-pariscite.fr/direct/myplanning.jsp",
}
_connector_cache: dict = {}


@router.get("/health/connecteurs")
def connectors_health(request: Request):
    """Diagnostic public : les services d'emploi du temps répondent-ils depuis ce serveur ?

    Fait aussi une vraie connexion au Pronote de DÉMONSTRATION (identifiants publics
    fournis par Index Éducation). Résultat gardé 10 minutes pour ne pas surcharger.
    """
    rate_limit(f"diag:{client_ip(request)}", limit=5, window_seconds=600)
    if _connector_cache.get("at", 0) > time.time() - 600:
        return _connector_cache["data"]
    import httpx
    from ..services import pronote
    hosts = {}
    with httpx.Client(timeout=10, follow_redirects=False, headers={"User-Agent": "Studoo-diagnostic/1.0"}) as client:
        for name, url in CONNECTOR_HOSTS.items():
            try:
                hosts[name] = client.get(url).status_code
            except httpx.HTTPError as exc:
                hosts[name] = f"erreur : {type(exc).__name__}"
    try:
        t = time.perf_counter()
        events, keep = pronote.login("password", url=CONNECTOR_HOSTS["Pronote (serveur de démonstration)"],
                                     username="demonstration", password="pronotevs")
        demo = {"ok": True, "cours": len(events), "lien_ical": bool(keep and keep["kind"] == "ical"),
                "secondes": round(time.perf_counter() - t, 1)}
    except Exception as exc:  # noqa: BLE001
        demo = {"ok": False, "erreur": getattr(exc, "detail", None) or type(exc).__name__}
    data = {"hotes": hosts, "pronote_demo": demo}
    _connector_cache.update(at=time.time(), data=data)
    return data


@router.get("/health")
async def health():
    from importlib.util import find_spec
    # Vérifie que les bibliothèques optionnelles sont bien installées sur l'hébergeur.
    return {"ok": True, "time": int(time.time()), "pronote": find_spec("pronotepy") is not None}


class EventIn(BaseModel):
    path: str = Field(max_length=200)


@router.post("/events", status_code=204)
async def page_view(body: EventIn, request: Request):
    """Compte une page vue, sans cookie et sans enregistrer l'IP."""
    path = body.path.split("?")[0].split("#")[0].rstrip("/") or "/"
    # Les identifiants de fichiers sont remplacés pour ne pas créer une ligne par fichier.
    path = re.sub(r"/[A-Za-z0-9_\-]{20,}", "/:id", path).lower()
    if not PATH_RE.match(path):
        return None
    ip = client_ip(request)
    rate_limit(f"events:{ip}", limit=120, window_seconds=60)
    day = db.today()
    db.increment(db.page_views, {"day": day, "path": path})
    h = daily_visitor_hash(ip, request.headers.get("user-agent", ""), day.isoformat())
    try:
        with db.get_engine().begin() as conn:
            conn.execute(insert(db.visitors).values(day=day, hash=h))
    except IntegrityError:
        pass
    if random.random() < 0.02:
        purge_old_data()
    return None


def purge_old_data() -> None:
    """Durées de conservation annoncées dans la page RGPD."""
    with db.get_engine().begin() as conn:
        conn.execute(delete(db.visitors).where(db.visitors.c.day < db.today() - timedelta(days=2)))
        conn.execute(delete(db.messages).where(db.messages.c.created_at < db.now() - timedelta(days=365)))
        conn.execute(delete(db.school_reports).where(db.school_reports.c.created_at < db.now() - timedelta(days=365)))
        conn.execute(delete(db.page_views).where(db.page_views.c.day < db.today() - timedelta(days=760)))
        conn.execute(delete(db.rate_limits).where(db.rate_limits.c.window < int(time.time()) - 2 * 86400))


class ContactIn(BaseModel):
    email: EmailStr
    subject: str = Field(min_length=3, max_length=120)
    message: str = Field(min_length=10, max_length=4000)
    website: str = Field(default="", max_length=200)  # pot de miel : doit rester vide
    elapsed_ms: int = Field(default=0, ge=0)  # temps passé sur le formulaire

    @field_validator("subject", "message")
    @classmethod
    def strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Champ vide")
        return v


@router.post("/contact")
async def contact(body: ContactIn, request: Request):
    """Formulaire de contact protégé contre le spam.

    - pot de miel : un champ invisible que seuls les robots remplissent ;
    - piège temporel : un humain met plus de 3 s à remplir le formulaire ;
    - limitation : 3 messages par heure et par IP.
    Les robots reçoivent une réponse « ok » pour ne pas qu'ils s'adaptent.
    """
    if body.website or body.elapsed_ms < 3000:
        return {"ok": True}
    rate_limit(f"contact:{client_ip(request)}", limit=3, window_seconds=3600)
    if len(re.findall(r"https?://", body.message)) > 3:
        return {"ok": True}
    with db.get_engine().begin() as conn:
        conn.execute(insert(db.messages).values(
            created_at=db.now(), email=str(body.email), subject=body.subject, body=body.message, handled=False,
        ))
    return {"ok": True}
