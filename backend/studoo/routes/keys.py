"""Clé Gemini personnelle de l'élève : enregistrer (après vérification), voir, choisir ses usages, supprimer."""
import re
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..deps import User, current_user
from ..limits import rate_limit
from ..services import user_keys

router = APIRouter(prefix="/api/me", tags=["keys"])
CurrentUser = Annotated[User, Depends(current_user)]
KEY_RE = re.compile(r"^[A-Za-z0-9_\-]{30,60}$")


class KeyIn(BaseModel):
    key: str = Field(min_length=30, max_length=60)


class PrefsIn(BaseModel):
    prefs: dict[str, bool] = Field(max_length=20)


async def _check_with_google(key: str) -> None:
    """Demande à Google la liste des modèles avec cette clé : 200 = clé valable."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get("https://generativelanguage.googleapis.com/v1beta/models",
                                   params={"pageSize": 1}, headers={"x-goog-api-key": key})
    except httpx.HTTPError:
        raise HTTPException(502, detail={"code": "google_unreachable", "message": "Google ne répond pas : réessaie dans un instant."})
    if res.status_code != 200:
        raise HTTPException(400, detail={"code": "bad_key", "message": "Google refuse cette clé : vérifie que tu l'as copiée en entier."})


@router.get("/gemini-key")
async def get_key(user: CurrentUser):
    return user_keys.status(user.sub)


@router.put("/gemini-key")
async def put_key(body: KeyIn, user: CurrentUser):
    key = body.key.strip()
    if not KEY_RE.match(key):
        raise HTTPException(422, detail={"code": "bad_key", "message": "Ce n'est pas une clé Gemini (elle commence en général par « AIza »)."})
    rate_limit(f"gemini-key:{user.sub}", limit=10, window_seconds=3600)
    await _check_with_google(key)
    user_keys.save(user.sub, key)
    return user_keys.status(user.sub)


@router.put("/gemini-key/prefs")
async def put_prefs(body: PrefsIn, user: CurrentUser):
    """Fonctionnalités où l'élève veut Gemini (avec sa clé) au lieu des outils de Studoo."""
    if not user_keys.status(user.sub)["set"]:
        raise HTTPException(409, detail={"code": "no_key", "message": "Enregistre d'abord ta clé Gemini."})
    return user_keys.set_prefs(user.sub, body.prefs)


@router.delete("/gemini-key")
async def delete_key(user: CurrentUser):
    user_keys.remove(user.sub)
    return user_keys.status(user.sub)
