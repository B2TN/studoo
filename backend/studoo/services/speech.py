"""Transcription des cours par Azure AI Speech (« fast transcription », offre gratuite F0 : 5 h d'audio par mois).

Pourquoi : la transcription passait par Gemini, mais le site en ligne n'avait pas de clé Gemini → chaque tranche
échouait. Azure AI Speech (service « studoo-voix », Italie) comprend le français, reconnaît les différentes voix
(diarisation) et accepte les formats des navigateurs : WebM/Opus (Chrome), MP4/AAC (Safari), Ogg/Opus (Firefox).
Testé le 26/11/2026 : 15 s de dialogue en ≈ 1,3 s, texte exact, 2 voix séparées.

L'audio est envoyé en mémoire puis oublié : rien n'est écrit sur disque ni conservé.
"""
import asyncio
import json
import logging

import httpx
from fastapi import HTTPException

log = logging.getLogger("studoo.speech")
API_VERSION = "2024-11-15"
ROLES = ["Professeur", "Élève", "Élève 2", "Élève 3"]


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def to_segments(phrases: list[dict]) -> list[dict]:
    """Phrases Azure (voix 1, 2…) → segments « Professeur / Élève » ; phrases consécutives d'une même voix regroupées.

    Le rôle est déduit du temps de parole : la voix qui parle le plus est le professeur.
    """
    talk: dict[int, int] = {}
    for p in phrases:
        talk[p.get("speaker", 0)] = talk.get(p.get("speaker", 0), 0) + int(p.get("durationMilliseconds") or len(p.get("text", "")))
    order = sorted(talk, key=lambda s: -talk[s])
    role = {s: ROLES[min(i, len(ROLES) - 1)] for i, s in enumerate(order)}
    segments: list[dict] = []
    for p in sorted(phrases, key=lambda x: x.get("offsetMilliseconds", 0)):
        text = (p.get("text") or "").strip()
        if not text:
            continue
        who = role.get(p.get("speaker", 0), "Intervenant")
        if segments and segments[-1]["speaker"] == who:
            segments[-1]["text"] += " " + text
        else:
            segments.append({"speaker": who, "text": text})
    return segments


async def transcribe(audio: bytes, mime: str, *, key: str, region: str, locale: str = "fr-FR") -> dict:
    """Renvoie {"language", "segments", "duration"} ; lève une HTTPException au message clair sinon."""
    url = f"https://{region}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version={API_VERSION}"
    definition = {"locales": [locale], "diarization": {"enabled": True, "maxSpeakers": 4}, "profanityFilterMode": "None"}
    async with httpx.AsyncClient(timeout=90) as client:
        for attempt in range(4):
            try:
                res = await client.post(url, headers={"Ocp-Apim-Subscription-Key": key}, files={
                    "audio": ("audio", audio, mime), "definition": (None, json.dumps(definition), "application/json")})
            except httpx.HTTPError:
                if attempt < 3:
                    await asyncio.sleep(2)
                    continue
                raise _error(502, "stt_unreachable", "Le service de transcription ne répond pas. Réessaie dans un instant.") from None
            if res.status_code == 429 and attempt < 3:  # offre gratuite : peu de demandes à la fois
                try:
                    wait = float(res.headers.get("retry-after", 0)) or 3 * (attempt + 1)
                except ValueError:
                    wait = 3 * (attempt + 1)
                await asyncio.sleep(min(wait, 10))
                continue
            break
    if res.status_code == 200:
        data = res.json()
        duration = (data.get("durationMilliseconds") or 0) / 1000
        return {"language": locale[:2], "segments": to_segments(data.get("phrases") or []), "duration": duration}
    log.warning("Transcription Azure : HTTP %s", res.status_code)  # jamais le contenu
    if res.status_code == 429:
        raise _error(429, "stt_busy", "Le service de transcription est très demandé en ce moment : réessaie dans une minute.")
    if res.status_code in (401, 403):
        raise _error(503, "stt_unconfigured", "Le service de transcription du site est mal configuré (clé refusée).")
    if res.status_code in (400, 415, 422):
        raise _error(422, "bad_audio", "Le son envoyé est illisible (enregistrement vide, trop court ou format non reconnu).")
    raise _error(502, "stt_error", "Le service de transcription a rencontré une erreur. Réessaie.")
