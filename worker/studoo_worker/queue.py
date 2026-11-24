"""File d'attente dans la base Postgres (Neon) partagée avec l'API.

Une tâche passe par : queued → running → done (ou failed / cancelled).
Le « verrou » (locked_until) permet de reprendre une tâche si le worker
s'arrête en plein milieu (redémarrage, panne).
"""
from datetime import timedelta

from sqlalchemy import or_, select, update

from studoo import db
from studoo.jobcrypto import open_payload

from . import settings


def claim():
    """Prend la plus ancienne tâche disponible ; renvoie (ligne, contenu déchiffré) ou None."""
    now = db.now()
    with db.get_engine().begin() as conn:
        query = (select(db.jobs)
                 .where(or_(db.jobs.c.status == "queued",
                            (db.jobs.c.status == "running") & (db.jobs.c.locked_until < now)))
                 .order_by(db.jobs.c.created_at).limit(1))
        if conn.dialect.name == "postgresql":
            query = query.with_for_update(skip_locked=True)  # deux workers ne prennent jamais la même tâche
        row = conn.execute(query).mappings().first()
        if not row:
            return None
        attempts = row["attempts"] + 1
        if attempts > settings.MAX_ATTEMPTS or not row["payload"]:
            conn.execute(update(db.jobs).where(db.jobs.c.id == row["id"]).values(
                status="failed", payload=None, error="Abandon après plusieurs essais.", finished_at=now))
            return None
        conn.execute(update(db.jobs).where(db.jobs.c.id == row["id"]).values(
            status="running", attempts=attempts, started_at=now, step="Démarrage",
            locked_until=now + timedelta(minutes=settings.LOCK_MINUTES)))
    payload = open_payload(settings.JOB_SECRET, row["payload"])
    if payload is None:
        fail(row["id"], "Contenu illisible (clé JOB_SECRET différente ?)", final=True)
        return None
    return dict(row, attempts=attempts), payload


def progress(job_id: str, percent: int, step: str) -> None:
    with db.get_engine().begin() as conn:
        conn.execute(update(db.jobs).where(db.jobs.c.id == job_id, db.jobs.c.status == "running").values(
            progress=max(0, min(99, int(percent))), step=step[:160],
            locked_until=db.now() + timedelta(minutes=settings.LOCK_MINUTES)))


def keep_alive(job_id: str) -> None:
    """Prolonge le verrou pendant une longue étape (sinon une autre machine reprendrait la tâche en double)."""
    with db.get_engine().begin() as conn:
        conn.execute(update(db.jobs).where(db.jobs.c.id == job_id, db.jobs.c.status == "running").values(
            locked_until=db.now() + timedelta(minutes=settings.LOCK_MINUTES)))


def is_cancelled(job_id: str) -> bool:
    with db.get_engine().connect() as conn:
        return conn.execute(select(db.jobs.c.status).where(db.jobs.c.id == job_id)).scalar() == "cancelled"


def finish(job_id: str, file_id: str, name: str) -> None:
    with db.get_engine().begin() as conn:
        conn.execute(update(db.jobs).where(db.jobs.c.id == job_id).values(
            status="done", progress=100, step="Terminé", payload=None,  # contenu et jeton effacés
            result_file_id=file_id, result_name=name[:200], finished_at=db.now(), locked_until=None))


def fail(job_id: str, error: str, *, final: bool = False, attempts: int = 0) -> None:
    """Échec : nouvel essai automatique si possible, sinon « failed » (contenu gardé 24 h pour « Relancer »)."""
    retry = not final and attempts < settings.MAX_ATTEMPTS
    with db.get_engine().begin() as conn:
        conn.execute(update(db.jobs).where(db.jobs.c.id == job_id).values(
            status="queued" if retry else "failed", error=error[:300], locked_until=None,
            step="Nouvel essai bientôt" if retry else "Échec", finished_at=None if retry else db.now()))


def purge() -> None:
    """Efface le contenu des tâches échouées depuis plus de 24 h (minimum de données gardées)."""
    limit = db.now() - timedelta(hours=settings.KEEP_FAILED_HOURS)
    with db.get_engine().begin() as conn:
        conn.execute(update(db.jobs).where(db.jobs.c.status.in_(["failed", "cancelled"]),
                                           db.jobs.c.finished_at < limit,
                                           db.jobs.c.payload.is_not(None)).values(payload=None))
