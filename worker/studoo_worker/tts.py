"""Voix de synthèse françaises open source, sur le processeur.

- « naturelle » : Kokoro (82 M de paramètres, Apache 2.0), voix féminine ff_siwis ≈ 1,5 × temps réel.
- « rapide »    : Piper (MIT/GPL), voix siwis (féminine) et tom (masculine) ≈ 15 × temps réel.
Dans un podcast à deux voix, l'animateur B parle toujours avec la voix masculine de Piper.
"""
import urllib.request
import wave
from functools import lru_cache
from io import BytesIO

import numpy as np

from . import settings

RATE = 24000
PIPER_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR"
KOKORO_BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"


def _fetch(url: str, name: str):
    path = settings.MODELS_DIR / name
    if not path.exists():
        settings.MODELS_DIR.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        urllib.request.urlretrieve(url, tmp)
        tmp.rename(path)
    return path


@lru_cache(maxsize=4)
def _piper(voice: str):
    from piper import PiperVoice
    speaker, quality = voice.split("-")
    model = _fetch(f"{PIPER_BASE}/{speaker}/{quality}/fr_FR-{voice}.onnx", f"fr_FR-{voice}.onnx")
    _fetch(f"{PIPER_BASE}/{speaker}/{quality}/fr_FR-{voice}.onnx.json", f"fr_FR-{voice}.onnx.json")
    return PiperVoice.load(str(model))


@lru_cache(maxsize=1)
def _kokoro():
    from kokoro_onnx import Kokoro
    return Kokoro(str(_fetch(f"{KOKORO_BASE}/kokoro-v1.0.onnx", "kokoro-v1.0.onnx")),
                  str(_fetch(f"{KOKORO_BASE}/voices-v1.0.bin", "voices-v1.0.bin")))


def _resample(audio: np.ndarray, src: int) -> np.ndarray:
    if src == RATE:
        return audio
    x = np.linspace(0, len(audio), int(len(audio) * RATE / src), endpoint=False)
    return np.interp(x, np.arange(len(audio)), audio).astype(np.float32)


def _piper_say(voice: str, text: str) -> np.ndarray:
    buf = BytesIO()
    with wave.open(buf, "wb") as w:
        _piper(voice).synthesize_wav(text, w)
    buf.seek(0)
    with wave.open(buf, "rb") as w:
        src = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
    return _resample(pcm, src)


def say(text: str, speaker: str = "A", mode: str = "naturelle") -> np.ndarray:
    """Une réplique → son (float32, 24 kHz)."""
    text = " ".join(text.split())
    if not text:
        return np.zeros(0, dtype=np.float32)
    if speaker == "B":
        return _piper_say("tom-medium", text)
    if mode == "naturelle":
        samples, rate = _kokoro().create(text, voice="ff_siwis", speed=1.0, lang="fr-fr")
        return _resample(np.asarray(samples, dtype=np.float32), rate)
    return _piper_say("siwis-medium", text)


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(RATE * seconds), dtype=np.float32)


def to_wav_bytes(audio: np.ndarray) -> bytes:
    buf = BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()
