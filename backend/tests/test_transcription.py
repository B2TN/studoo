"""Itération 5 (C1) : transcription par Azure AI Speech et cas d'erreur distincts."""
import httpx

from studoo.config import get_settings
from studoo.services import speech

AUDIO = b"\x1a\x45\xdf\xa3" + b"\x00" * 2000


def fake_client(answers, seen=None):
    answers = iter(answers)

    class FakeClient:
        def __init__(self, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None, files=None):
            if seen is not None:
                seen.append((url, files))
            return next(answers)
    return FakeClient


def test_empty_recording_has_its_own_message(logged):
    res = logged.post("/api/ai/transcribe", content=b"\x1a\x45\xdf\xa3", headers={"Content-Type": "audio/webm"})
    assert res.status_code == 422 and res.json()["detail"]["code"] == "empty_audio"


def test_azure_speech_with_retry_and_roles(logged, monkeypatch):
    monkeypatch.setattr(get_settings(), "speech_key", "cle-test")
    seen = []
    ok = httpx.Response(200, json={"durationMilliseconds": 15000, "phrases": [
        {"speaker": 1, "offsetMilliseconds": 0, "durationMilliseconds": 4000, "text": "Aujourd'hui, la photosynthèse."},
        {"speaker": 1, "offsetMilliseconds": 4000, "durationMilliseconds": 3000, "text": "C'est la nourriture des plantes."},
        {"speaker": 2, "offsetMilliseconds": 7000, "durationMilliseconds": 2000, "text": "Elles ne mangent pas ?"}]})
    monkeypatch.setattr(speech.httpx, "AsyncClient", fake_client([httpx.Response(429, headers={"retry-after": "0.01"}), ok], seen))
    res = logged.post("/api/ai/transcribe?index=0", content=AUDIO, headers={"Content-Type": "audio/webm;codecs=opus"})
    data = res.json()
    assert res.status_code == 200 and len(seen) == 2 and data["duration"] == 15  # 429 de l'offre gratuite : réessayé
    url, files = seen[0]
    assert "italynorth.api.cognitive.microsoft.com" in url and files["audio"][2] == "audio/webm"
    assert '"fr-FR"' in files["definition"][1] and '"diarization"' in files["definition"][1]
    assert data["segments"] == [
        {"speaker": "Professeur", "text": "Aujourd'hui, la photosynthèse. C'est la nourriture des plantes."},
        {"speaker": "Élève", "text": "Elles ne mangent pas ?"}]


def test_real_silence_and_service_errors_are_distinct(logged, monkeypatch):
    monkeypatch.setattr(get_settings(), "speech_key", "cle-test")
    monkeypatch.setattr(speech.httpx, "AsyncClient", fake_client([
        httpx.Response(200, json={"durationMilliseconds": 20000, "phrases": []}),
        httpx.Response(401), httpx.Response(400)]))
    silence = logged.post("/api/ai/transcribe", content=AUDIO, headers={"Content-Type": "audio/webm"}).json()
    assert silence["segments"] == [] and silence["duration"] == 20  # son bien reçu, vraiment aucune parole
    err = logged.post("/api/ai/transcribe", content=AUDIO, headers={"Content-Type": "audio/webm"})
    assert err.status_code == 503 and err.json()["detail"]["code"] == "stt_unconfigured"
    bad = logged.post("/api/ai/transcribe", content=AUDIO, headers={"Content-Type": "audio/webm"})
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "bad_audio"


def test_no_transcription_service_is_said_clearly(logged, monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "speech_key", "")
    monkeypatch.setattr(s, "gemini_api_key", "")
    monkeypatch.setattr(type(s), "ai_fake_enabled", property(lambda self: False))  # comme en ligne (pas de mode démo)
    res = logged.post("/api/ai/transcribe", content=AUDIO, headers={"Content-Type": "audio/webm"})
    assert res.status_code == 503 and res.json()["detail"]["code"] == "stt_unconfigured"


def test_main_speaker_is_the_teacher_even_if_second():
    segs = speech.to_segments([
        {"speaker": 2, "offsetMilliseconds": 0, "durationMilliseconds": 1000, "text": "Bonjour madame."},
        {"speaker": 1, "offsetMilliseconds": 1000, "durationMilliseconds": 9000, "text": "Bonjour, ouvrez vos cahiers."}])
    assert [s["speaker"] for s in segs] == ["Élève", "Professeur"]
