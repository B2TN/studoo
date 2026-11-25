"""Écriture des scripts (podcasts, vidéos, fiches) par une IA, au format JSON demandé.

Ordre d'essai :
1. Groq : modèles open source hébergés sur des puces spécialisées → quelques secondes (clé du site) ;
2. Gemini avec la clé PERSONNELLE de l'élève, seulement s'il en a enregistré une (secours) ;
3. le modèle open source local du serveur (Qwen3-4B) : marche toujours, mais ≈ 1 h pour 10 min de podcast.
Les journaux ne contiennent jamais le texte des cours ni les clés.
"""
import json
import logging
import time

import httpx

from . import settings
from .llm import GROUNDING, LLM

log = logging.getLogger(__name__)


class WriterError(RuntimeError):
    pass


def _retry_after(res: httpx.Response, default: float) -> float:
    try:
        return min(60.0, float(res.headers.get("retry-after", default)))
    except ValueError:
        return default


def _groq(prompt: str, schema: dict, max_tokens: int, temperature: float) -> dict:
    body = {
        "model": settings.GROQ_MODEL, "temperature": temperature, "max_completion_tokens": max_tokens,
        "messages": [{"role": "system", "content": GROUNDING}, {"role": "user", "content": prompt}],
        "response_format": {"type": "json_schema", "json_schema": {"name": "reponse", "schema": schema, "strict": False}},
    }
    if settings.GROQ_MODEL.startswith("openai/gpt-oss"):
        body["reasoning_effort"] = "low"  # le modèle réfléchit peu : plus rapide, et assez pour un script
    headers = {"Authorization": f"Bearer {settings.GROQ_API_KEY}"}
    with httpx.Client(timeout=180) as client:
        for attempt in range(4):
            res = client.post(settings.GROQ_URL, json=body, headers=headers)
            if res.status_code == 429 and attempt < 3:  # quota par minute : on attend un peu
                time.sleep(_retry_after(res, 10))
                continue
            if res.status_code == 400 and "json_validate_failed" in res.text and body["response_format"]["type"] != "json_object":
                # Réponse légèrement hors format : on redemande un JSON libre, le schéma étant rappelé dans la consigne.
                body["response_format"] = {"type": "json_object"}
                body["messages"][-1]["content"] = (prompt + "\n\nRéponds uniquement par un objet JSON conforme à ce schéma :\n"
                                                   + json.dumps(schema, ensure_ascii=False))
                continue
            res.raise_for_status()
            data = res.json()
            usage = data.get("usage") or {}
            log.info("Groq : %s jetons lus, %s écrits, %.1f s", usage.get("prompt_tokens"), usage.get("completion_tokens"),
                     usage.get("total_time") or 0)
            return json.loads(data["choices"][0]["message"]["content"])
    raise WriterError("Groq : trop de demandes en ce moment.")


def _gemini(key: str, prompt: str, schema: dict, max_tokens: int, temperature: float) -> dict:
    url = f"{settings.GEMINI_URL}/{settings.GEMINI_TEXT_MODEL}:generateContent"
    body = {
        "systemInstruction": {"parts": [{"text": GROUNDING}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens,
                             "responseMimeType": "application/json", "responseJsonSchema": schema},
    }
    with httpx.Client(timeout=180) as client:
        res = client.post(url, json=body, headers={"x-goog-api-key": key})
    res.raise_for_status()
    parts = res.json()["candidates"][0]["content"]["parts"]
    log.info("Gemini (clé de l'élève) : réponse reçue")
    return json.loads("".join(p.get("text", "") for p in parts))


def _why(exc: Exception) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        return f"HTTP {exc.response.status_code}"
    return type(exc).__name__


def write(prompt: str, schema: dict, *, gemini_key: str = "", max_tokens: int = 8000, temperature: float = 0.6) -> dict:
    """Renvoie le JSON écrit par la première IA disponible."""
    if settings.GROQ_API_KEY:
        try:
            return _groq(prompt, schema, max_tokens, temperature)
        except Exception as exc:  # noqa: BLE001 - on passe au secours
            log.warning("Groq indisponible (%s) : secours", _why(exc))
    if gemini_key:
        try:
            return _gemini(gemini_key, prompt, schema, max_tokens, temperature)
        except Exception as exc:  # noqa: BLE001
            log.warning("Gemini (clé de l'élève) indisponible (%s) : modèle local", _why(exc))
    log.warning("Écriture par le modèle local du serveur (lent)")
    with LLM() as llm:
        return llm.json(prompt, schema, max_tokens=min(max_tokens, 6000), temperature=temperature)
