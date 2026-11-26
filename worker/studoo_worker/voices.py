"""Voix des podcasts et des vidéos.

Ordre d'essai :
1. Azure AI Speech : voix neuronales françaises très naturelles, quelques secondes pour 10 min de son
   (offre gratuite F0 du site : 500 000 caractères par mois) ;
2. Gemini TTS avec la clé PERSONNELLE de l'élève, seulement s'il en a enregistré une (secours) ;
3. les voix open source locales (Kokoro / Piper) : toujours disponibles, moins naturelles.
Tout sort en MP3 24 kHz mono 96 kbit/s (voir media.MP3_ARGS).
"""
import base64
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from xml.sax.saxutils import escape

import httpx

from . import media, settings, tts

log = logging.getLogger(__name__)

# Paires de voix (animateur A, animateur B). La vidéo n'utilise que la voix A.
PAIRS = {
    "vivienne-remy": ("fr-FR-VivienneMultilingualNeural", "fr-FR-RemyMultilingualNeural"),
    "denise-henri": ("fr-FR-DeniseNeural", "fr-FR-HenriNeural"),
}
DEFAULT = "vivienne-remy"
GEMINI_VOICES = {"A": "Kore", "B": "Puck"}
CHUNK_CHARS = 2500  # par demande : bien sous la limite d'Azure (10 min de son)


def pair(option: str) -> tuple[str, str]:
    return PAIRS.get(option, PAIRS[DEFAULT])  # anciennes valeurs (« naturelle », « rapide ») → paire par défaut


def _chunks(lines: list[tuple[str, str]]) -> list[list[tuple[str, str]]]:
    out, cur, size = [], [], 0
    for line in lines:
        if cur and size + len(line[1]) > CHUNK_CHARS:
            out.append(cur)
            cur, size = [], 0
        cur.append(line)
        size += len(line[1])
    return out + ([cur] if cur else [])


# ---------- 1. Azure AI Speech ----------
def _azure_one(lines: list[tuple[str, str]], voices: tuple[str, str], client: httpx.Client) -> bytes:
    ssml = "<speak version='1.0' xml:lang='fr-FR'>" + "".join(
        f"<voice name='{voices[0] if who == 'A' else voices[1]}'>{escape(text)}<break time='300ms'/></voice>"
        for who, text in lines) + "</speak>"
    url = f"https://{settings.SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1"
    headers = {"Ocp-Apim-Subscription-Key": settings.SPEECH_KEY, "Content-Type": "application/ssml+xml",
               "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3", "User-Agent": "studoo-worker"}
    hangs = 0
    for attempt in range(8):
        try:
            res = client.post(url, content=ssml.encode(), headers=headers)
        except httpx.TransportError:  # demande restée bloquée (vu le 26/11/2026) : on la renvoie
            hangs += 1
            if hangs > 3:
                raise
            log.info("Voix Azure : morceau sans réponse, nouvel essai")
            continue
        if res.status_code == 429 and attempt < 7:  # offre gratuite : 20 demandes par minute
            time.sleep(min(30.0, float(res.headers.get("retry-after", 5) or 5)))
            continue
        if res.status_code >= 500 and hangs < 3:
            hangs += 1
            time.sleep(2)
            continue
        res.raise_for_status()
        return res.content
    raise RuntimeError("Azure Speech : trop de demandes")


def _azure(groups: list[list[tuple[str, str]]], voices: tuple[str, str]) -> list[bytes]:
    # Un morceau de 2 500 caractères se fabrique en 10 à 15 s : au-delà de 60 s, la demande est bloquée.
    with httpx.Client(timeout=httpx.Timeout(60, connect=10)) as client, ThreadPoolExecutor(4) as pool:
        return list(pool.map(lambda g: _azure_one(g, voices, client), groups))


# ---------- 2. Gemini TTS (clé de l'élève) ----------
def _gemini_one(lines: list[tuple[str, str]], key: str, client: httpx.Client) -> bytes:
    speakers = sorted({who for who, _ in lines})
    if len(speakers) > 1:
        text = "Lis ce dialogue en français, sur un ton vivant et chaleureux :\n" + "\n".join(f"{w}: {t}" for w, t in lines)
        speech = {"multiSpeakerVoiceConfig": {"speakerVoiceConfigs": [
            {"speaker": s, "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": GEMINI_VOICES[s]}}} for s in speakers]}}
    else:
        text = "Lis ce texte en français, sur un ton clair et chaleureux :\n" + " ".join(t for _, t in lines)
        speech = {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": GEMINI_VOICES[speakers[0]]}}}
    res = client.post(f"{settings.GEMINI_URL}/{settings.GEMINI_TTS_MODEL}:generateContent", headers={"x-goog-api-key": key}, json={
        "contents": [{"parts": [{"text": text}]}],
        "generationConfig": {"responseModalities": ["AUDIO"], "speechConfig": speech}})
    res.raise_for_status()
    data = res.json()["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
    return media.pcm_to_mp3(base64.b64decode(data))


def _gemini(groups: list[list[tuple[str, str]]], key: str) -> list[bytes]:
    with httpx.Client(timeout=300) as client:
        return [_gemini_one(g, key, client) for g in groups]  # l'une après l'autre : petit quota gratuit


# ---------- 3. Voix open source locales ----------
def _local(groups: list[list[tuple[str, str]]]) -> list[bytes]:
    import numpy as np
    out = []
    for group in groups:
        parts = []
        for who, text in group:
            parts += [tts.say(text, who, "naturelle"), tts.silence(0.3)]
        out.append(media.mp3(np.concatenate(parts)))
    return out


def synthesize_groups(groups: list[list[tuple[str, str]]], *, option: str = DEFAULT, gemini_key: str = "") -> list[bytes]:
    """Une liste de groupes de répliques (orateur « A »/« B », texte) → un MP3 par groupe, dans le même ordre."""
    if settings.SPEECH_KEY:
        try:
            out = _azure(groups, pair(option))
            log.info("Voix Azure : %d morceaux, %d caractères", len(groups), sum(len(t) for g in groups for _, t in g))
            return out
        except Exception as exc:  # noqa: BLE001 - quota du mois épuisé, panne… : secours
            log.warning("Azure Speech indisponible (%s) : secours", getattr(getattr(exc, "response", None), "status_code", type(exc).__name__))
    if gemini_key:
        try:
            return _gemini(groups, gemini_key)
        except Exception as exc:  # noqa: BLE001
            log.warning("Gemini TTS indisponible (%s) : voix locales", getattr(getattr(exc, "response", None), "status_code", type(exc).__name__))
    return _local(groups)


def synthesize(lines: list[tuple[str, str]], *, option: str = DEFAULT, gemini_key: str = "") -> bytes:
    """Un dialogue entier → un seul MP3."""
    lines = [(who, " ".join(text.split())) for who, text in lines if text.strip()]
    if not lines:
        return media.silence_mp3(1)
    return media.join_mp3(synthesize_groups(_chunks(lines), option=option, gemini_key=gemini_key))
