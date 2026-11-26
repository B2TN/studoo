"""Gemini (Google AI) avec la clé PERSONNELLE de l'élève — jamais avec une clé du site.

Par défaut, Studoo n'envoie rien à Google : ce module ne sert que si l'élève a enregistré sa propre clé
ET coché la fonctionnalité concernée dans ses préférences (voir services/user_keys.py et services/ai.py).
La clé passe dans un en-tête HTTP (jamais dans l'adresse) et n'apparaît dans aucun journal.
"""
import base64
import json
import logging
from typing import TypeVar

import httpx
from fastapi import HTTPException
from pydantic import BaseModel

from ..config import get_settings

log = logging.getLogger("studoo.ai")
T = TypeVar("T", bound=BaseModel)
URL = "https://generativelanguage.googleapis.com/v1beta/models"


def _error(res: httpx.Response | None) -> HTTPException:
    status = res.status_code if res is not None else 0
    if status == 429:
        return HTTPException(429, detail={"code": "gemini_quota", "message":
                             "Ta clé Gemini a atteint sa limite gratuite. Réessaie plus tard, ou repasse sur les outils de Studoo dans Réglages."})
    if status in (400, 401, 403):
        return HTTPException(502, detail={"code": "gemini_key", "message":
                             "Google refuse ta clé Gemini. Vérifie-la dans Réglages, ou repasse sur les outils de Studoo."})
    log.warning("Gemini (clé de l'élève) : réponse HTTP %s", status or "absente")
    return HTTPException(502, detail={"code": "ai_error", "message": "Gemini n'a pas pu répondre. Réessaie."})


async def generate_json(*, key: str, schema: type[T], prompt: str, system: str = "",
                        media: list[tuple[bytes, str]] | None = None, temperature: float = 0.4) -> T:
    """Demande à Gemini (clé de l'élève) une réponse JSON conforme à `schema`."""
    parts = [{"text": prompt}] + [
        {"inlineData": {"mimeType": mime, "data": base64.b64encode(data).decode()}} for data, mime in media or []]
    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"temperature": temperature, "responseMimeType": "application/json",
                             "responseJsonSchema": schema.model_json_schema()},
    }
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    try:
        async with httpx.AsyncClient(timeout=110) as client:
            res = await client.post(f"{URL}/{get_settings().gemini_model_flash}:generateContent",
                                    json=body, headers={"x-goog-api-key": key})
    except httpx.HTTPError:
        raise _error(None)
    if res.status_code != 200:
        raise _error(res)
    try:
        out = res.json()["candidates"][0]["content"]["parts"]
        return schema.model_validate(json.loads("".join(p.get("text", "") for p in out)))
    except (KeyError, IndexError, ValueError) as exc:
        raise HTTPException(502, detail={"code": "ai_bad_output", "message": "Réponse de Gemini illisible. Réessaie."}) from exc
