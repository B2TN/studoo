"""Écriture des scripts (podcasts, vidéos, fiches) par une IA, au format JSON demandé.

Ordre d'essai :
1. Azure OpenAI (GPT-4.1 mini, crédit Azure for Students) et/ou Groq, selon les clés présentes → quelques secondes ;
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


def _providers(images: bool = False) -> list[dict]:
    """Services compatibles avec l'API « chat/completions » d'OpenAI, dans l'ordre d'essai.

    Avec des photos, seuls ceux qui savent lire une image (GPT-4.1 mini) sont proposés.
    """
    found = []
    if settings.AZURE_OPENAI_KEY and settings.AZURE_OPENAI_URL:
        found.append({"name": "Azure OpenAI", "url": settings.AZURE_OPENAI_URL, "model": settings.AZURE_OPENAI_MODEL,
                      "headers": {"api-key": settings.AZURE_OPENAI_KEY}})
    if settings.GROQ_API_KEY and not images:  # gpt-oss ne lit pas les images
        found.append({"name": "Groq", "url": settings.GROQ_URL, "model": settings.GROQ_MODEL,
                      "headers": {"Authorization": f"Bearer {settings.GROQ_API_KEY}"}})
    return found


def _user_content(prompt: str, images: list[str] | None):
    if not images:
        return prompt
    return [{"type": "text", "text": prompt}] + [
        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img}", "detail": "high"}} for img in images]


def _chat(provider: dict, prompt: str, schema: dict, max_tokens: int, temperature: float,
          images: list[str] | None = None) -> dict:
    name = provider["name"]
    body = {
        "model": provider["model"], "temperature": temperature, "max_completion_tokens": max_tokens,
        "messages": [{"role": "system", "content": GROUNDING}, {"role": "user", "content": _user_content(prompt, images)}],
        "response_format": {"type": "json_schema", "json_schema": {"name": "reponse", "schema": schema, "strict": False}},
    }
    if provider["model"].startswith("openai/gpt-oss"):
        body["reasoning_effort"] = "low"  # le modèle réfléchit peu : plus rapide, et assez pour un script
    started = time.monotonic()
    with httpx.Client(timeout=240) as client:
        for attempt in range(4):
            res = client.post(provider["url"], json=body, headers=provider["headers"])
            if res.status_code == 429 and attempt < 3:  # quota par minute : on attend un peu
                time.sleep(_retry_after(res, 10))
                continue
            if res.status_code == 400 and body["response_format"]["type"] == "json_schema":
                # Réponse hors format (Groq) ou schéma refusé : on redemande un JSON libre, le schéma étant rappelé dans la consigne.
                body["response_format"] = {"type": "json_object"}
                body["messages"][-1]["content"] = _user_content(
                    prompt + "\n\nRéponds uniquement par un objet JSON conforme à ce schéma :\n"
                    + json.dumps(schema, ensure_ascii=False), images)
                continue
            res.raise_for_status()
            data = res.json()
            usage = data.get("usage") or {}
            log.info("%s : %s jetons lus, %s écrits, %.1f s", name, usage.get("prompt_tokens"),
                     usage.get("completion_tokens"), time.monotonic() - started)
            return json.loads(data["choices"][0]["message"]["content"])
    raise WriterError(f"{name} : trop de demandes en ce moment.")


def _gemini(key: str, prompt: str, schema: dict, max_tokens: int, temperature: float,
            images: list[str] | None = None) -> dict:
    url = f"{settings.GEMINI_URL}/{settings.GEMINI_TEXT_MODEL}:generateContent"
    parts = [{"text": prompt}] + [{"inlineData": {"mimeType": "image/jpeg", "data": img}} for img in images or []]
    body = {
        "systemInstruction": {"parts": [{"text": GROUNDING}]},
        "contents": [{"role": "user", "parts": parts}],
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


def write(prompt: str, schema: dict, *, gemini_key: str = "", max_tokens: int = 8000, temperature: float = 0.6,
          images: list[str] | None = None) -> dict:
    """Renvoie le JSON écrit par la première IA disponible.

    `images` (photos JPEG en base64) : seulement les IA qui lisent les images ; sinon WriterError (pas de modèle local).
    """
    for provider in _providers(images=bool(images)):
        try:
            return _chat(provider, prompt, schema, max_tokens, temperature, images)
        except Exception as exc:  # noqa: BLE001 - on passe au suivant
            log.warning("%s indisponible (%s) : secours", provider["name"], _why(exc))
    if gemini_key:
        try:
            return _gemini(gemini_key, prompt, schema, max_tokens, temperature, images)
        except Exception as exc:  # noqa: BLE001
            log.warning("Gemini (clé de l'élève) indisponible (%s) : modèle local", _why(exc))
    if images:
        raise WriterError("Aucune IA capable de lire les photos n'est disponible.")
    log.warning("Écriture par le modèle local du serveur (lent)")
    with LLM() as llm:
        return llm.json(prompt, schema, max_tokens=min(max_tokens, 6000), temperature=temperature)
