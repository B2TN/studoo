"""Anti-spam (limitation de débit) et quotas IA quotidiens."""
import hashlib
import hmac
import time

from fastapi import HTTPException, Request

from . import db
from .config import get_settings

TIERS = ("lite", "flash")

# Limites de débit par élève : (nombre de demandes, fenêtre en secondes). SEULE source de ces valeurs :
# les routes les appliquent avec `rate()`, et la page RGPD / l'interface les lisent via /api/limits.
RATES = {
    "transcribe": (30, 600),   # morceaux de 5 min d'enregistrement
    "classify": (30, 600),     # deviner le cours d'un document
    "gen": (10, 600),          # fiches
    "ocr": (15, 600),          # lecture de PDF scannés
    "jobs": (30, 3600),        # générations envoyées au serveur de tâches
}
RESET_TEXT = "chaque jour à minuit (heure de Paris)"


def rate(name: str, sub: str) -> None:
    limit, window = RATES[name]
    rate_limit(f"{name}:{sub}", limit=limit, window_seconds=window)


def client_ip(request: Request) -> str:
    # Derrière Vercel, la vraie IP est dans x-forwarded-for (premier élément).
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "0.0.0.0"


def _anon(key: str) -> str:
    """Empreinte du compteur : la base ne contient jamais l'adresse IP ni l'identifiant en clair."""
    secret = get_settings().session_secret.encode()
    return hmac.new(secret, b"rate-limit|" + key.encode(), hashlib.sha256).hexdigest()[:48]


def rate_limit(key: str, limit: int, window_seconds: int) -> None:
    """Refuse la requête si `key` a dépassé `limit` appels dans la fenêtre."""
    window = int(time.time() // window_seconds) * window_seconds  # début de la fenêtre (horodatage)
    count = db.increment(db.rate_limits, {"key": _anon(key), "window": window})
    if count > limit:
        raise HTTPException(
            status_code=429,
            detail={"code": "rate_limited", "message": "Trop de requêtes, réessaie dans un instant."},
        )


def tier_limit(tier: str) -> int:
    s = get_settings()
    return {"lite": s.quota_lite_per_day, "flash": s.quota_flash_per_day}[tier]


def quota_status(sub: str | None = None) -> dict:
    day = db.today()
    status = {}
    for tier in TIERS:
        used = db.read_count(db.ai_usage, {"day": day, "tier": tier})
        status[tier] = {"used": used, "limit": tier_limit(tier), "remaining": max(0, tier_limit(tier) - used)}
    if sub:
        used = db.read_count(db.user_ai_usage, {"day": day, "sub": sub})
        limit = get_settings().quota_user_per_day
        status["user"] = {"used": used, "limit": limit, "remaining": max(0, limit - used)}
        jobs = db.read_count(db.user_job_usage, {"day": day, "sub": sub})
        jlimit = get_settings().quota_jobs_per_day
        status["jobs"] = {"used": jobs, "limit": jlimit, "remaining": max(0, jlimit - jobs)}
        status["reset"] = RESET_TEXT
    return status


def has_quota(tier: str) -> bool:
    return db.read_count(db.ai_usage, {"day": db.today(), "tier": tier}) < tier_limit(tier)


def consume(tier: str, sub: str) -> None:
    """Réserve une requête IA ; lève 429 si le quota du jour est épuisé."""
    day = db.today()
    user_used = db.read_count(db.user_ai_usage, {"day": day, "sub": sub})
    if user_used >= get_settings().quota_user_per_day:
        raise HTTPException(429, detail={
            "code": "user_quota",
            "message": "Tu as atteint ta limite d'IA pour aujourd'hui. Reviens demain !",
        })
    if not has_quota(tier):
        raise HTTPException(429, detail={
            "code": "site_quota",
            "message": "Le quota gratuit d'IA du site est épuisé pour aujourd'hui. Réessaie demain.",
        })
    db.increment(db.ai_usage, {"day": day, "tier": tier})
    db.increment(db.user_ai_usage, {"day": day, "sub": sub})


def consume_job(sub: str) -> None:
    """Une génération de plus sur le serveur de tâches aujourd'hui ; 429 si la limite quotidienne est atteinte."""
    day = db.today()
    s = get_settings()
    limit = s.quota_jobs_per_day
    if db.read_count(db.ai_usage, {"day": day, "tier": "jobs"}) >= s.quota_site_jobs_per_day:
        raise HTTPException(429, detail={
            "code": "site_jobs_quota",
            "message": "Le serveur de Studoo a fabriqué toutes ses générations pour aujourd'hui. Réessaie demain.",
        })
    if db.read_count(db.user_job_usage, {"day": day, "sub": sub}) >= limit:
        raise HTTPException(429, detail={
            "code": "jobs_quota",
            "message": f"Tu as lancé tes {limit} générations du jour (podcasts, vidéos, exercices…). Reviens demain !",
        })
    db.increment(db.user_job_usage, {"day": day, "sub": sub})
    db.increment(db.ai_usage, {"day": day, "tier": "jobs"})


def public_limits() -> dict:
    """Limites réelles, lues dans la configuration : affichées telles quelles par la page RGPD et l'interface."""
    s = get_settings()
    return {
        "perUser": {"ai": s.quota_user_per_day, "jobs": s.quota_jobs_per_day, "pendingJobs": s.max_pending_jobs},
        "rates": {k: {"count": n, "minutes": w // 60} for k, (n, w) in RATES.items()},
        "site": {"lite": s.quota_lite_per_day, "flash": s.quota_flash_per_day, "jobs": s.quota_site_jobs_per_day},
        "reset": RESET_TEXT,
    }


def count_generation(kind: str) -> None:
    db.increment(db.generations, {"day": db.today(), "kind": kind})
