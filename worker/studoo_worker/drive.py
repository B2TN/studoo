"""Écriture du résultat dans le Google Drive de l'élève, pendant son absence.

On échange le jeton « hors ligne » (refresh token) contre un jeton d'accès
d'une heure. Avec l'autorisation drive.file, on ne voit que les fichiers Studoo.
"""
import json

import httpx

from . import settings

TOKEN_URL = "https://oauth2.googleapis.com/token"
UPLOAD = "https://www.googleapis.com/upload/drive/v3/files"
API = "https://www.googleapis.com/drive/v3/files"


class DriveError(Exception):
    pass


def access_token(refresh_token: str) -> str:
    res = httpx.post(TOKEN_URL, data={
        "client_id": settings.GOOGLE_CLIENT_ID, "client_secret": settings.GOOGLE_CLIENT_SECRET,
        "refresh_token": refresh_token, "grant_type": "refresh_token",
    }, timeout=20)
    if res.status_code != 200:
        raise DriveError("Accès à ton Drive refusé : reconnecte-toi sur Studoo puis relance la génération.")
    return res.json()["access_token"]


def upload(token: str, *, folder_id: str, name: str, mime: str, data: bytes, kind: str, props: dict | None = None) -> dict:
    metadata = {"name": name, "mimeType": mime, "parents": [folder_id],
                "appProperties": {"studoo": "file", "kind": kind, **(props or {})}}
    headers = {"Authorization": f"Bearer {token}"}
    with httpx.Client(timeout=120) as client:
        start = client.post(f"{UPLOAD}?uploadType=resumable&fields=id,name", headers={
            **headers, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": mime,
        }, content=json.dumps(metadata))
        if start.status_code != 200:
            raise DriveError(f"Google Drive a refusé l'envoi ({start.status_code}).")
        res = client.put(start.headers["Location"], content=data, headers={"Content-Type": mime})
        if res.status_code not in (200, 201):
            raise DriveError(f"Envoi vers Google Drive interrompu ({res.status_code}).")
        return res.json()


def set_props(token: str, file_id: str, props: dict) -> None:
    httpx.patch(f"{API}/{file_id}", headers={"Authorization": f"Bearer {token}"},
                json={"appProperties": props}, timeout=20).raise_for_status()
