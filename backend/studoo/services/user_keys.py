"""Clé Gemini personnelle de l'élève (facultative).

Elle ne sert qu'en SECOURS pour les podcasts et vidéos (quand l'IA ou les voix du site sont indisponibles
ou épuisées). Elle est chiffrée (Fernet) avec une clé dérivée de SESSION_SECRET et liée au compte :
la base seule ne permet pas de la lire, et elle n'est jamais renvoyée au navigateur.
"""
import base64
import hashlib
import hmac

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import delete, insert, select

from .. import db
from ..config import get_settings


def _fernet() -> Fernet:
    key = hmac.new(get_settings().session_secret.encode(), b"gemini-user-key", hashlib.sha256).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def save(sub: str, key: str) -> str:
    hint = key[-4:]
    token = _fernet().encrypt(f"{sub}\n{key}".encode()).decode()
    with db.get_engine().begin() as conn:
        conn.execute(delete(db.user_keys).where(db.user_keys.c.sub == sub))
        conn.execute(insert(db.user_keys).values(sub=sub, gemini_key=token, hint=hint, updated_at=db.now()))
    return hint


def status(sub: str) -> dict:
    with db.get_engine().connect() as conn:
        row = conn.execute(select(db.user_keys.c.hint, db.user_keys.c.updated_at).where(db.user_keys.c.sub == sub)).first()
    return {"set": bool(row), "hint": row.hint if row else "", "updated_at": row.updated_at.isoformat() if row else None}


def load(sub: str) -> str:
    """La clé en clair (pour le serveur de tâches uniquement), ou "" si aucune / illisible."""
    with db.get_engine().connect() as conn:
        token = conn.execute(select(db.user_keys.c.gemini_key).where(db.user_keys.c.sub == sub)).scalar()
    if not token:
        return ""
    try:
        owner, key = _fernet().decrypt(token.encode()).decode().split("\n", 1)
    except (InvalidToken, ValueError):
        return ""
    return key if owner == sub else ""


def remove(sub: str) -> None:
    with db.get_engine().begin() as conn:
        conn.execute(delete(db.user_keys).where(db.user_keys.c.sub == sub))
