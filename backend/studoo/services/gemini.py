"""Accès à Gemini (Google AI), avec un mode « factice » pour les tests.

Toutes les générations reçoivent la même consigne de base : n'utiliser
QUE le contenu des cours fournis, jamais de connaissances extérieures.
"""
import logging
from typing import TypeVar

from fastapi import HTTPException
from pydantic import BaseModel

from ..config import get_settings
from ..limits import consume, has_quota
from . import fake

log = logging.getLogger("studoo.ai")
T = TypeVar("T", bound=BaseModel)

GROUNDING_RULE = (
    "Règle absolue : tu utilises UNIQUEMENT les informations présentes dans les documents "
    "de cours fournis. Tu n'ajoutes aucun fait, date, exemple ou chiffre qui n'y figure pas. "
    "Si une information manque, tu ne l'inventes pas. "
    "Tu réponds dans la langue des documents (français par défaut)."
)

_client = None


def _get_client():
    global _client
    if _client is None:
        from google import genai
        _client = genai.Client(api_key=get_settings().gemini_api_key)
    return _client


def _model(tier: str) -> str:
    s = get_settings()
    return {"lite": s.gemini_model_lite, "flash": s.gemini_model_flash, "tts": s.gemini_model_tts}[tier]


def _google_error(exc: Exception) -> HTTPException:
    text = str(exc)
    if "RESOURCE_EXHAUSTED" in text or "429" in text:
        return HTTPException(429, detail={
            "code": "google_quota",
            "message": "Google limite le nombre de requêtes IA gratuites. Réessaie dans une minute ou demain.",
        })
    log.exception("Erreur Gemini")
    return HTTPException(502, detail={"code": "ai_error", "message": "L'IA n'a pas pu répondre. Réessaie."})


def pick_text_tier(prefer: str = "flash") -> str:
    """Utilise Flash si son quota le permet, sinon bascule sur Flash-Lite."""
    if prefer == "flash" and has_quota("flash"):
        return "flash"
    return "lite"


async def generate_json(
    *, tier: str, sub: str, schema: type[T], prompt: str, system: str = "",
    media: list[tuple[bytes, str]] | None = None, fake_key: str = "",
    temperature: float = 0.4,
) -> T:
    """Demande à Gemini une réponse JSON conforme à `schema`."""
    consume(tier, sub)
    if get_settings().ai_fake_enabled:
        return schema.model_validate(fake.answer(fake_key or schema.__name__, prompt))

    from google.genai import types
    parts: list = [types.Part.from_bytes(data=data, mime_type=mime) for data, mime in (media or [])]
    parts.append(prompt)
    try:
        resp = await _get_client().aio.models.generate_content(
            model=_model(tier),
            contents=parts,
            config=types.GenerateContentConfig(
                system_instruction=system or None,
                response_mime_type="application/json",
                response_schema=schema,
                temperature=temperature,
            ),
        )
    except Exception as exc:  # noqa: BLE001 - toute erreur Google est traduite
        raise _google_error(exc) from exc
    if resp.parsed is not None:
        return resp.parsed if isinstance(resp.parsed, schema) else schema.model_validate(resp.parsed)
    try:
        return schema.model_validate_json(resp.text or "")
    except ValueError as exc:
        raise HTTPException(502, detail={"code": "ai_bad_output", "message": "Réponse de l'IA illisible. Réessaie."}) from exc


async def synthesize(*, sub: str, lines: list[tuple[str, str]], voices: dict[str, str]) -> tuple[bytes, int]:
    """Voix de synthèse Gemini (une ou deux voix). Renvoie du PCM 16 bits mono + fréquence."""
    consume("tts", sub)
    if get_settings().ai_fake_enabled:
        return fake.silence_pcm(seconds=min(60, 2 + sum(len(t) for _, t in lines) // 15)), 24000

    from google.genai import types
    speakers = sorted({s for s, _ in lines})
    transcript = "\n".join(f"{s}: {t}" for s, t in lines)
    if len(speakers) >= 2:
        speech = types.SpeechConfig(multi_speaker_voice_config=types.MultiSpeakerVoiceConfig(
            speaker_voice_configs=[
                types.SpeakerVoiceConfig(speaker=s, voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voices.get(s, "Kore"))))
                for s in speakers[:2]
            ]))
        prompt = "Lis ce dialogue de podcast éducatif sur un ton vivant et naturel :\n" + transcript
    else:
        speech = types.SpeechConfig(voice_config=types.VoiceConfig(
            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voices.get(speakers[0], "Kore"))))
        prompt = "Lis ce texte de vidéo explicative, de façon claire et dynamique :\n" + " ".join(t for _, t in lines)
    try:
        resp = await _get_client().aio.models.generate_content(
            model=_model("tts"), contents=prompt,
            config=types.GenerateContentConfig(response_modalities=["AUDIO"], speech_config=speech),
        )
        data = resp.candidates[0].content.parts[0].inline_data.data
    except Exception as exc:  # noqa: BLE001
        raise _google_error(exc) from exc
    return data, 24000
