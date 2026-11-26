"""Voix des podcasts et des vidéos.

Voix choisies (itération 4) : podcasts = dialogue Vivienne (A) + Henri (B) ; vidéos = Vivienne seule.
Allure « radio » : un peu plus lent (−5 %, réglé dans le moteur de voix : pas d'étirement du son), phrases
découpées, pauses aux virgules et entre les phrases, volume égalisé (−16 LUFS).

Ordre d'essai :
1. Azure AI Speech, Vivienne + Henri (offre gratuite F0 : 500 000 caractères par mois) ;
2. Azure AI Speech, Denise + Henri (mêmes réglages) si Vivienne ne répond pas — signalé à l'élève ;
3. Gemini TTS avec la clé PERSONNELLE de l'élève, s'il en a enregistré une — signalé ;
4. les voix open source locales (Kokoro / Piper) — signalé.
Tout sort en MP3 24 kHz mono 96 kbit/s (voir media.MP3_ARGS).
"""
import base64
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor
from xml.sax.saxutils import escape

import httpx

from . import media, settings, tts

log = logging.getLogger(__name__)

# Voix (A, B). La vidéo n'utilise que la voix A.
MAIN = ("fr-FR-VivienneMultilingualNeural", "fr-FR-HenriNeural")
BACKUP = ("fr-FR-DeniseNeural", "fr-FR-HenriNeural")
GEMINI_VOICES = {"A": "Kore", "B": "Puck"}
CHUNK_CHARS = 2500  # par demande : bien sous la limite d'Azure (10 min de son)
RATE = "-5%"         # un peu plus lent qu'une conversation : allure radio
SENTENCE_PAUSE = "250ms"
COMMA_PAUSE = "120ms"
TURN_PAUSE = "300ms"  # entre deux répliques

NOTICE_BACKUP = "La voix de Vivienne n'était pas disponible : ce fichier est lu par Denise et Henri."
NOTICE_OTHER = "Les voix Vivienne et Henri n'étaient pas disponibles : ce fichier est lu par des voix de secours."


class Voiced(list):
    """Liste de MP3 (un par groupe), avec `notice` : message pour l'élève si des voix de secours ont servi."""
    notice = ""


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
def _sentences(text: str) -> list[str]:
    return [s for s in re.split(r"(?<=[.!?…])\s+", text.strip()) if s]


def ssml(lines: list[tuple[str, str]], voices: tuple[str, str]) -> str:
    """SSML « radio » : une phrase par <s>, pauses réglées, vitesse réglée par le moteur (prosody)."""
    parts = []
    for who, text in lines:
        body = f"<break time='{SENTENCE_PAUSE}'/>".join(f"<s>{escape(s)}</s>" for s in _sentences(text))
        parts.append(f"<voice name='{voices[0] if who == 'A' else voices[1]}'>"
                     f"<mstts:silence type='Comma-exact' value='{COMMA_PAUSE}'/>"
                     f"<prosody rate='{RATE}'>{body}</prosody><break time='{TURN_PAUSE}'/></voice>")
    return ("<speak version='1.0' xml:lang='fr-FR' xmlns:mstts='http://www.w3.org/2001/mstts'>"
            + "".join(parts) + "</speak>")


def _azure_one(lines: list[tuple[str, str]], voices: tuple[str, str], client: httpx.Client) -> bytes:
    body = ssml(lines, voices)
    url = f"https://{settings.SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1"
    headers = {"Ocp-Apim-Subscription-Key": settings.SPEECH_KEY, "Content-Type": "application/ssml+xml",
               "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3", "User-Agent": "studoo-worker"}
    hangs = 0
    for attempt in range(8):
        try:
            res = client.post(url, content=body.encode(), headers=headers)
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


def _try(label: str, fn) -> list[bytes] | None:
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 - quota épuisé, panne… : on passe au secours suivant
        log.warning("%s indisponible (%s) : secours", label,
                    getattr(getattr(exc, "response", None), "status_code", None) or type(exc).__name__)
        return None


def synthesize_groups(groups: list[list[tuple[str, str]]], *, gemini_key: str = "", **_old) -> Voiced:
    """Une liste de groupes de répliques (orateur « A »/« B », texte) → un MP3 par groupe, dans le même ordre.

    Chaque MP3 a son volume égalisé ; `.notice` dit à l'élève si des voix de secours ont servi.
    """
    chars = sum(len(t) for g in groups for _, t in g)
    out, notice = None, ""
    if settings.SPEECH_KEY:
        out = _try("Voix Azure (Vivienne + Henri)", lambda: _azure(groups, MAIN))
        if out is None:
            out, notice = _try("Voix Azure (Denise + Henri)", lambda: _azure(groups, BACKUP)), NOTICE_BACKUP
        if out is not None:
            log.info("Voix Azure : %d morceaux, %d caractères", len(groups), chars)
    if out is None and gemini_key:
        out, notice = _try("Gemini TTS (clé de l'élève)", lambda: _gemini(groups, gemini_key)), NOTICE_OTHER
    if out is None:
        out, notice = _local(groups), NOTICE_OTHER
    result = Voiced(media.normalize_mp3(clip) for clip in out)
    result.notice = notice
    return result


def synthesize(lines: list[tuple[str, str]], *, gemini_key: str = "", **_old) -> tuple[bytes, str]:
    """Un dialogue entier → (un seul MP3, message pour l'élève ou "")."""
    lines = [(who, " ".join(text.split())) for who, text in lines if text.strip()]
    if not lines:
        return media.silence_mp3(1), ""
    clips = synthesize_groups(_chunks(lines), gemini_key=gemini_key)
    return media.join_mp3(clips), clips.notice
