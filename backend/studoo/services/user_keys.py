"""Clé Gemini personnelle de l'élève (facultative) et ses préférences d'usage.

Par défaut, rien ne part chez Google. Une fois la clé enregistrée, l'élève coche les fonctionnalités pour
lesquelles il veut Gemini (toutes décochées au départ) ; il peut tout décocher ou supprimer la clé à tout moment.

La clé est chiffrée (Fernet) avec une clé dérivée de SESSION_SECRET et liée au compte : la base seule ne permet
pas de la lire. Elle n'est jamais renvoyée au navigateur (seulement ses 4 derniers caractères) ni écrite dans
un journal ; elle ne sert que côté serveur, pour cet élève.
"""
import base64
import hashlib
import hmac
import json

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import delete, insert, select, update

from .. import db
from ..config import get_settings

# Fonctionnalités où l'élève peut choisir Gemini à la place des outils de Studoo.
FEATURES = {
    "transcription": "Transcription des enregistrements",
    "classement": "Deviner le cours d'un document",
    "fiche": "Fiches de révision",
    "exercices": "Feuilles d'exercices et corrections de copies",
    "photos": "Lecture des photos et des PDF scannés",
    "podcast": "Podcasts (script et, en secours, voix)",
    "video": "Vidéos (script et, en secours, voix)",
}
# Type de tâche du serveur de tâches → fonctionnalité correspondante.
JOB_FEATURE = {"podcast": "podcast", "video": "video", "fiche": "fiche", "exercices": "exercices",
               "correction": "exercices", "ocr": "photos"}


def _fernet() -> Fernet:
    key = hmac.new(get_settings().session_secret.encode(), b"gemini-user-key", hashlib.sha256).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def _clean(prefs: dict) -> dict:
    return {f: bool(prefs.get(f)) for f in FEATURES}


def save(sub: str, key: str) -> str:
    """Enregistre (ou remplace) la clé. Les préférences déjà choisies sont gardées ; sinon tout est décoché."""
    hint = key[-4:]
    token = _fernet().encrypt(f"{sub}\n{key}".encode()).decode()
    old = status(sub)["prefs"]
    with db.get_engine().begin() as conn:
        conn.execute(delete(db.user_keys).where(db.user_keys.c.sub == sub))
        conn.execute(insert(db.user_keys).values(sub=sub, gemini_key=token, hint=hint, updated_at=db.now(),
                                                 prefs=json.dumps(_clean(old))))
    return hint


def status(sub: str) -> dict:
    with db.get_engine().connect() as conn:
        row = conn.execute(select(db.user_keys.c.hint, db.user_keys.c.updated_at, db.user_keys.c.prefs)
                           .where(db.user_keys.c.sub == sub)).first()
    try:
        prefs = _clean(json.loads(row.prefs or "{}")) if row else _clean({})
    except ValueError:
        prefs = _clean({})
    return {"set": bool(row), "hint": row.hint if row else "", "updated_at": row.updated_at.isoformat() if row else None,
            "prefs": prefs, "features": FEATURES}


def set_prefs(sub: str, prefs: dict) -> dict:
    with db.get_engine().begin() as conn:
        conn.execute(update(db.user_keys).where(db.user_keys.c.sub == sub).values(prefs=json.dumps(_clean(prefs))))
    return status(sub)


def load(sub: str) -> str:
    """La clé en clair (côté serveur uniquement), ou "" si aucune / illisible."""
    with db.get_engine().connect() as conn:
        token = conn.execute(select(db.user_keys.c.gemini_key).where(db.user_keys.c.sub == sub)).scalar()
    if not token:
        return ""
    try:
        owner, key = _fernet().decrypt(token.encode()).decode().split("\n", 1)
    except (InvalidToken, ValueError):
        return ""
    return key if owner == sub else ""


def key_for(sub: str, feature: str) -> str:
    """La clé de l'élève s'il a choisi Gemini pour cette fonctionnalité, sinon "" (= outils de Studoo)."""
    if feature not in FEATURES or not status(sub)["prefs"].get(feature):
        return ""
    return load(sub)


def remove(sub: str) -> None:
    with db.get_engine().begin() as conn:
        conn.execute(delete(db.user_keys).where(db.user_keys.c.sub == sub))
