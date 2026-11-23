"""Anti-spam (limitation de débit) et quotas IA quotidiens."""
import time

from fastapi import HTTPException, Request

from . import db
from .config import get_settings

TIERS = ("lite", "flash", "tts")


def client_ip(request: Request) -> str:
    # Derrière Vercel, la vraie IP est dans x-forwarded-for (premier élément).
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "0.0.0.0"


def rate_limit(key: str, limit: int, window_seconds: int) -> None:
    """Refuse la requête si `key` a dépassé `limit` appels dans la fenêtre."""
    window = int(time.time() // window_seconds) * window_seconds  # début de la fenêtre (horodatage)
    count = db.increment(db.rate_limits, {"key": key[:128], "window": window})
    if count > limit:
        raise HTTPException(
            status_code=429,
            detail={"code": "rate_limited", "message": "Trop de requêtes, réessaie dans un instant."},
        )


def tier_limit(tier: str) -> int:
    s = get_settings()
    return {"lite": s.quota_lite_per_day, "flash": s.quota_flash_per_day, "tts": s.quota_tts_per_day}[tier]


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


def count_generation(kind: str) -> None:
    db.increment(db.generations, {"day": db.today(), "kind": kind})
