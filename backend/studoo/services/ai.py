"""Choix du moteur d'IA pour chaque demande.

Par défaut : les outils de Studoo sur Azure (Azure OpenAI GPT-4.1 mini, ressource « studoo-ecriture »,
payée par le crédit Azure for Students). Aucune donnée ne part chez Google.
Seulement si l'élève a enregistré SA clé Gemini ET coché cette fonctionnalité : Gemini avec sa clé.
"""
import asyncio
import base64
import json
import logging
from typing import TypeVar

import httpx
from fastapi import HTTPException
from pydantic import BaseModel

from ..config import get_settings
from ..limits import consume
from . import fake, gemini, user_keys

log = logging.getLogger("studoo.ai")
T = TypeVar("T", bound=BaseModel)

GROUNDING_RULE = (
    "Règle absolue : tu utilises UNIQUEMENT les informations présentes dans les documents "
    "de cours fournis. Tu n'ajoutes aucun fait, date, exemple ou chiffre qui n'y figure pas. "
    "Si une information manque, tu ne l'inventes pas. "
    "Tu réponds dans la langue des documents (français par défaut)."
)

UNCONFIGURED = HTTPException(503, detail={"code": "ai_unconfigured", "message":
                             "L'IA de Studoo n'est pas encore configurée sur ce site. Réessaie plus tard."})


def engine_for(sub: str, feature: str) -> str:
    """« gemini » si l'élève l'a choisi pour cette fonctionnalité (et a une clé valable), sinon « studoo »."""
    return "gemini" if user_keys.key_for(sub, feature) else "studoo"


async def _azure(schema: type[T], prompt: str, system: str, media: list[tuple[bytes, str]], temperature: float) -> T:
    s = get_settings()
    content: str | list = prompt
    if media:
        content = [{"type": "text", "text": prompt}] + [
            {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(data).decode()}", "detail": "high"}}
            for data, mime in media]
    body = {
        "model": s.azure_openai_model, "temperature": temperature, "max_completion_tokens": 6000,
        "messages": ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": content}],
        "response_format": {"type": "json_schema", "json_schema": {"name": "reponse", "schema": schema.model_json_schema(), "strict": False}},
    }
    try:
        async with httpx.AsyncClient(timeout=110) as client:
            for attempt in range(3):
                res = await client.post(s.azure_openai_url, json=body, headers={"api-key": s.azure_openai_key})
                if res.status_code != 429 or attempt == 2:
                    break
                await asyncio.sleep(min(8.0, float(res.headers.get("retry-after", 3) or 3)))
    except httpx.HTTPError:
        raise HTTPException(502, detail={"code": "ai_unreachable", "message": "L'IA de Studoo ne répond pas. Réessaie dans un instant."})
    if res.status_code == 429:
        raise HTTPException(429, detail={"code": "ai_busy", "message": "L'IA de Studoo est très demandée. Réessaie dans une minute."})
    if res.status_code != 200:
        log.warning("Azure OpenAI : réponse HTTP %s", res.status_code)
        raise HTTPException(502, detail={"code": "ai_error", "message": "L'IA n'a pas pu répondre. Réessaie."})
    try:
        return schema.model_validate(json.loads(res.json()["choices"][0]["message"]["content"]))
    except (KeyError, IndexError, ValueError) as exc:
        raise HTTPException(502, detail={"code": "ai_bad_output", "message": "Réponse de l'IA illisible. Réessaie."}) from exc


async def generate_json(*, feature: str, tier: str, sub: str, schema: type[T], prompt: str, system: str = "",
                        media: list[tuple[bytes, str]] | None = None, fake_key: str = "", temperature: float = 0.4) -> T:
    """Réponse JSON conforme à `schema`, par le moteur choisi pour `feature` (voir user_keys.FEATURES)."""
    key = user_keys.key_for(sub, feature)
    if key:  # choix explicite de l'élève : sa clé, son quota Google
        return await gemini.generate_json(key=key, schema=schema, prompt=prompt, system=system, media=media,
                                          temperature=temperature)
    s = get_settings()
    consume(tier, sub)
    if s.ai_fake_enabled:
        return schema.model_validate(fake.answer(fake_key or schema.__name__, prompt))
    if not (s.azure_openai_key and s.azure_openai_url):
        raise UNCONFIGURED
    return await _azure(schema, prompt, system, media or [], temperature)
