"""Chiffrement du contenu des tâches de fond (partagé entre l'API et le worker).

Le contenu d'une tâche (texte des cours, jeton Google « hors ligne ») est chiffré
avec JOB_SECRET, une clé distincte de celle des sessions : le worker peut lire
les tâches sans pouvoir fabriquer de fausses sessions.
"""
import base64
import hashlib
import json

from cryptography.fernet import Fernet, InvalidToken


def _fernet(secret: str) -> Fernet:
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(("studoo-job:" + secret).encode()).digest()))


def seal_payload(secret: str, data: dict) -> str:
    return _fernet(secret).encrypt(json.dumps(data, separators=(",", ":")).encode()).decode()


def open_payload(secret: str, token: str) -> dict | None:
    try:
        return json.loads(_fernet(secret).decrypt(token.encode()))
    except (InvalidToken, ValueError):
        return None
