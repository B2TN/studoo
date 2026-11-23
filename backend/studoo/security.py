"""Chiffrement des cookies de session et petits jetons signés.

- Le cookie de session contient le *refresh token* Google : il est donc
  chiffré (Fernet = AES + signature), pas seulement signé.
- Les « jetons de service » permettent à la fonction Node (Pronote) de
  savoir quel utilisateur l'appelle, sans partager le cookie.
"""
import base64
import hashlib
import hmac
import json
import time

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


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def sign_service_token(sub: str, ttl: int = 300) -> str:
    payload = _b64(json.dumps({"sub": sub, "exp": int(time.time()) + ttl}).encode())
    sig = _b64(hmac.new(_derive("service-token"), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{sig}"


def verify_service_token(token: str) -> str | None:
    try:
        payload, sig = token.split(".", 1)
    except ValueError:
        return None
    expected = _b64(hmac.new(_derive("service-token"), payload.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expected):
        return None
    data = json.loads(_unb64(payload))
    if data.get("exp", 0) < time.time():
        return None
    return data.get("sub")


def daily_visitor_hash(ip: str, user_agent: str, day: str) -> str:
    """Empreinte anonyme d'un visiteur, qui change chaque jour.

    Le « sel » dépend du jour : impossible de suivre quelqu'un d'un jour à
    l'autre, et l'adresse IP n'est jamais enregistrée.
    """
    salt = _derive(f"visitor-{day}")
    return hashlib.sha256(salt + ip.encode() + b"|" + user_agent.encode()).hexdigest()[:32]
