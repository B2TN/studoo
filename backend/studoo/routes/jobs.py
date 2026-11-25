"""File de tâches lourdes : l'élève lance une génération puis peut fermer la page.

L'API ne fait que DÉPOSER la tâche dans la base ; le worker (serveur de tâches)
la récupère, la traite, range le résultat dans le Drive et prévient l'élève.
"""
import logging
import uuid
from datetime import timedelta
from urllib.parse import urlsplit
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import delete, desc, func, insert, select, update

from .. import db
from ..config import get_settings
from ..deps import User, current_user
from ..jobcrypto import seal_payload
from ..limits import rate_limit
from ..services import user_keys

router = APIRouter(prefix="/api", tags=["jobs"])
CurrentUser = Annotated[User, Depends(current_user)]

PUBLIC_FIELDS = ("id", "kind", "title", "status", "progress", "step", "error", "result_file_id", "result_name",
                 "created_at", "started_at", "finished_at", "attempts")
KINDS = Literal["podcast", "video", "fiche", "ocr"]


class Source(BaseModel):
    title: str = Field(max_length=200)
    text: str = Field(min_length=1, max_length=200_000)


class JobIn(BaseModel):
    kind: KINDS
    title: str = Field(default="", max_length=160)
    sources: list[Source] = Field(default=[], max_length=30)
    images: list[str] = Field(default=[], max_length=8)  # OCR : photos réduites en base64
    options: dict = Field(default_factory=dict)
    folder_id: str = Field(min_length=5, max_length=128)
    course: str = Field(default="", max_length=120)
    chapter: str = Field(default="", max_length=120)

    @model_validator(mode="after")
    def check(self):
        if self.kind == "ocr":
            if not self.images:
                raise ValueError("Ajoute au moins une photo.")
            if sum(len(i) for i in self.images) > 3_500_000:
                raise ValueError("Photos trop lourdes.")
        elif not self.sources:
            raise ValueError("Choisis au moins un cours.")
        if sum(len(s.text) for s in self.sources) > 400_000:
            raise ValueError("Trop de texte : sélectionne moins de cours à la fois.")
        allowed = {"minutes": {10, 20, 30}, "format": {"short", "medium", "long"},
                   "voice": {"vivienne-remy", "denise-henri", "naturelle", "rapide"}}  # 2 dernières : anciennes pages
        for key, value in self.options.items():
            if key in {"pdf_id", "title"}:  # OCR : fichier PDF à relier, titre
                if not isinstance(value, str) or len(value) > 160:
                    raise ValueError(f"Option invalide : {key}")
            elif key not in allowed or value not in allowed[key]:
                raise ValueError(f"Option invalide : {key}")
        return self


log = logging.getLogger("studoo.jobs")


def _queue_messages_url(queue_url: str) -> str:
    """https://compte.queue.core.windows.net/studoo-jobs?<sas> → …/studoo-jobs/messages?<sas>"""
    parts = urlsplit(queue_url)
    return f"{parts.scheme}://{parts.netloc}{parts.path.rstrip('/')}/messages?{parts.query}&messagettl=86400"


async def wake_worker() -> None:
    """Dépose un message (sans aucune donnée) dans la file Azure : le serveur de tâches démarre aussitôt."""
    s = get_settings()
    if not s.worker_queue_url:
        return
    try:
        async with httpx.AsyncClient(timeout=6) as client:
            res = await client.post(_queue_messages_url(s.worker_queue_url),
                                    content="<QueueMessage><MessageText>studoo</MessageText></QueueMessage>",
                                    headers={"Content-Type": "application/xml"})
            res.raise_for_status()
    except httpx.HTTPError as exc:  # pas grave : la page « Mes générations » relancera le réveil
        log.warning("Réveil du serveur de tâches impossible : %s", type(exc).__name__)


def _stuck(row, now) -> bool:
    """Tâche qui attend depuis trop longtemps (réveil perdu) ou dont le serveur s'est arrêté en route."""
    created = row["created_at"] if row["created_at"].tzinfo else row["created_at"].replace(tzinfo=now.tzinfo)
    locked = row["locked_until"]
    if locked is not None and locked.tzinfo is None:
        locked = locked.replace(tzinfo=now.tzinfo)
    return (row["status"] == "queued" and now - created > timedelta(minutes=3)) or            (row["status"] == "running" and locked is not None and locked < now)


def _public(row) -> dict:
    out = {k: row[k] for k in PUBLIC_FIELDS}
    for k in ("created_at", "started_at", "finished_at"):
        out[k] = out[k].isoformat() if out[k] else None
    return out


@router.post("/jobs", status_code=201)
async def create_job(body: JobIn, user: CurrentUser):
    s = get_settings()
    if not s.is_local and s.job_secret.startswith("dev-job-secret"):
        raise HTTPException(503, detail={"code": "not_configured", "message": "Le serveur de tâches n'est pas encore configuré."})
    if not user.refresh_token or user.refresh_token == "dev" and not s.is_local:
        raise HTTPException(401, detail={"code": "session_expired", "message": "Reconnecte-toi pour lancer une génération."})
    # Anti-spam : pas de limite de durée, mais un nombre raisonnable de tâches en attente.
    rate_limit(f"jobs:{user.sub}", limit=30, window_seconds=3600)
    with db.get_engine().connect() as conn:
        pending = conn.execute(select(func.count()).select_from(db.jobs).where(
            db.jobs.c.sub == user.sub, db.jobs.c.status.in_(["queued", "running"]))).scalar_one()
    if pending >= s.max_pending_jobs:
        raise HTTPException(429, detail={"code": "too_many_jobs",
                                         "message": f"Tu as déjà {pending} générations en cours : attends qu'une se termine."})
    job_id = str(uuid.uuid4())
    payload = seal_payload(s.job_secret, {
        # Jeton Google « hors ligne » : permet au serveur d'écrire dans TON Drive pendant que tu es absent.
        # Il est effacé de la base dès la fin de la tâche.
        "refresh_token": user.refresh_token, "email": user.email,
        "sources": [x.model_dump() for x in body.sources], "images": body.images,
        "options": body.options, "folder_id": body.folder_id, "course": body.course, "chapter": body.chapter,
        # Clé Gemini personnelle (facultative) : secours si l'IA ou les voix du site sont indisponibles.
        "gemini_key": user_keys.load(user.sub) if body.kind in {"podcast", "video", "fiche"} else "",
    })
    titles = {"podcast": "Podcast", "video": "Vidéo", "fiche": "Fiche", "ocr": "Lecture de copie"}
    with db.get_engine().begin() as conn:
        conn.execute(insert(db.jobs).values(
            id=job_id, sub=user.sub, kind=body.kind, title=(body.title or titles[body.kind])[:160], status="queued",
            progress=0, step="En attente du serveur", attempts=0, payload=payload, error="", result_file_id="",
            result_name="", notified=False, created_at=db.now(),
        ))
        row = conn.execute(select(db.jobs).where(db.jobs.c.id == job_id)).mappings().one()
    await wake_worker()
    return {"job": _public(row)}


@router.get("/jobs")
async def list_jobs(user: CurrentUser):
    with db.get_engine().connect() as conn:
        rows = conn.execute(select(db.jobs).where(db.jobs.c.sub == user.sub)
                            .order_by(desc(db.jobs.c.created_at)).limit(20)).mappings().all()
    now = db.now()
    if any(_stuck(r, now) for r in rows):
        try:  # au plus un nouveau réveil toutes les 5 minutes par élève
            rate_limit(f"rewake:{user.sub}", limit=1, window_seconds=300)
            await wake_worker()
        except HTTPException:
            pass
    return {"jobs": [_public(r) for r in rows]}


def _own(conn, job_id: str, sub: str):
    row = conn.execute(select(db.jobs).where(db.jobs.c.id == job_id, db.jobs.c.sub == sub)).mappings().first()
    if not row:
        raise HTTPException(404, detail={"code": "not_found", "message": "Tâche introuvable."})
    return row


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str, user: CurrentUser):
    with db.get_engine().begin() as conn:
        row = _own(conn, job_id, user.sub)
        if row["status"] in {"queued", "running"}:
            conn.execute(update(db.jobs).where(db.jobs.c.id == job_id).values(
                status="cancelled", payload=None, step="Annulée", finished_at=db.now()))
    return {"ok": True}


@router.post("/jobs/{job_id}/retry")
async def retry_job(job_id: str, user: CurrentUser):
    """Relance une tâche échouée. Le contenu ayant été effacé, il faut la recréer depuis le site."""
    with db.get_engine().begin() as conn:
        row = _own(conn, job_id, user.sub)
        if row["status"] != "failed" or not row["payload"]:
            raise HTTPException(409, detail={"code": "cannot_retry", "message": "Relance-la depuis la page de création."})
        conn.execute(update(db.jobs).where(db.jobs.c.id == job_id).values(
            status="queued", attempts=0, error="", step="En attente du serveur", progress=0))
    await wake_worker()
    return {"ok": True}


@router.delete("/jobs/{job_id}")
async def delete_job(job_id: str, user: CurrentUser):
    with db.get_engine().begin() as conn:
        row = _own(conn, job_id, user.sub)
        if row["status"] in {"queued", "running"}:
            raise HTTPException(409, detail={"code": "running", "message": "Annule d'abord la tâche."})
        conn.execute(delete(db.jobs).where(db.jobs.c.id == job_id))
    return {"ok": True}


class PushIn(BaseModel):
    endpoint: str = Field(min_length=20, max_length=600)
    p256dh: str = Field(min_length=20, max_length=200)
    auth: str = Field(min_length=8, max_length=100)


@router.post("/push/subscribe")
async def push_subscribe(body: PushIn, user: CurrentUser):
    if not body.endpoint.startswith("https://"):
        raise HTTPException(422, detail={"code": "invalid", "message": "Abonnement invalide."})
    with db.get_engine().begin() as conn:
        conn.execute(delete(db.push_subscriptions).where(db.push_subscriptions.c.endpoint == body.endpoint))
        conn.execute(insert(db.push_subscriptions).values(endpoint=body.endpoint, sub=user.sub, p256dh=body.p256dh,
                                                          auth=body.auth, created_at=db.now()))
    return {"ok": True}


@router.post("/push/unsubscribe")
async def push_unsubscribe(body: PushIn, user: CurrentUser):
    with db.get_engine().begin() as conn:
        conn.execute(delete(db.push_subscriptions).where(db.push_subscriptions.c.endpoint == body.endpoint,
                                                         db.push_subscriptions.c.sub == user.sub))
    return {"ok": True}
