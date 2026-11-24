"""Chiffrement des cookies de session et petits jetons signés.

- Le cookie de session contient le *refresh token* Google : il est donc
  chiffré (Fernet = AES + signature), pas seulement signé.
"""
import base64
import hashlib
import hmac
import json

from cryptography.fernet import Fernet, InvalidToken

from .config import get_settings


def _derive(label: str) -> bytes:
    secret = get_settings().session_secret.encode()
    return hmac.new(secret, label.encode(), hashlib.sha256).digest()


def _fernet() -> Fernet:
    return Fernet(base64.urlsafe_b64encode(_derive("session-cookie")))


def encrypt_json(data: dict) -> str:
    return _fernet().encrypt(json.dumps(data, separators=(",", ":")).encode()).decode()


def decrypt_json(token: str, max_age: int | None = None) -> dict | None:
    try:
        raw = _fernet().decrypt(token.encode(), ttl=max_age)
        return json.loads(raw)
    except (InvalidToken, ValueError):
        return None


def daily_visitor_hash(ip: str, user_agent: str, day: str) -> str:
    """Empreinte anonyme d'un visiteur, qui change chaque jour.

    Le « sel » dépend du jour : impossible de suivre quelqu'un d'un jour à
    l'autre, et l'adresse IP n'est jamais enregistrée.
    """
    salt = _derive(f"visitor-{day}")
    return hashlib.sha256(salt + ip.encode() + b"|" + user_agent.encode()).hexdigest()[:32]
