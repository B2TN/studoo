"""Jetons d'emploi du temps « scellés » (chiffrés).

Un lien iCal privé ou un jeton Pronote donne accès à l'emploi du temps de
l'élève : c'est un secret. On ne le confie donc jamais en clair au navigateur
ni au Drive : on le chiffre (Fernet = AES + signature) avec une clé que seul
le serveur connaît, et on y inclut l'identifiant de l'utilisateur pour qu'un
autre compte ne puisse pas le réutiliser. Supprimer la source = révoquer.
"""
import base64
import hashlib
import hmac
import json

from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException

from ..config import get_settings


def _fernet() -> Fernet:
    key = hmac.new(get_settings().session_secret.encode(), b"timetable-token", hashlib.sha256).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def seal(sub: str, data: dict) -> str:
    return _fernet().encrypt(json.dumps({"sub": sub, **data}, separators=(",", ":")).encode()).decode()


def unseal(sub: str, token: str) -> dict:
    try:
        data = json.loads(_fernet().decrypt(token.encode()))
    except (InvalidToken, ValueError):
        raise HTTPException(422, detail={"code": "bad_token", "message": "Connexion à refaire : ce jeton n'est plus valable."})
    if data.pop("sub", None) != sub:
        raise HTTPException(403, detail={"code": "bad_token", "message": "Ce jeton appartient à un autre compte."})
    return data
