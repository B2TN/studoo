"""Itération 6 (C2) : par défaut, rien ne part chez Google ; Gemini seulement avec la clé de l'élève et là où il l'a choisi."""
import json

import httpx
import pytest
from sqlalchemy import select

KEY = "AIzaSyD-exemple_de_cle_gemini_1234567890"
SOURCES = {"sources": [{"title": "Cours 1", "text": "Une suite géométrique de raison q vérifie u(n+1) = q u(n)."}],
           "course": "Maths", "chapter": "Suites"}
FICHE = {"title": "Suites", "subtitle": "", "sections": [], "key_points": [], "mnemonic": "", "quiz": []}
AUDIO = b"\x1a\x45\xdf\xa3" + b"\x00" * 2000


@pytest.fixture
def real_ai(monkeypatch):
    """Comme en ligne : pas d'IA factice, Azure OpenAI configuré ; on enregistre chaque hôte appelé."""
    monkeypatch.setenv("AI_FAKE", "0")
    monkeypatch.setenv("AZURE_OPENAI_KEY", "cle-azure")
    monkeypatch.setenv("AZURE_OPENAI_URL", "https://studoo.openai.azure.com/openai/v1/chat/completions")
    from studoo.config import get_settings
    get_settings.cache_clear()
    calls = []

    async def fake_post(self, url, json=None, headers=None, **kw):
        host = httpx.URL(url).host
        calls.append({"host": host, "url": str(url), "headers": headers or {}, "json": json})
        if host == "generativelanguage.googleapis.com":
            body = {"candidates": [{"content": {"parts": [{"text": _json(FICHE if "sections" in str(json) else {})}]}}]}
        else:
            body = {"choices": [{"message": {"content": _json(FICHE)}}]}
        return httpx.Response(200, json=body, request=httpx.Request("POST", url))

    async def fake_get(self, url, params=None, headers=None):  # vérification de la clé par Google
        return httpx.Response(200, json={}, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    return calls


def _json(obj):
    return json.dumps(obj)


def test_by_default_the_fiche_is_written_on_azure_never_google(logged, real_ai):
    res = logged.post("/api/ai/fiche", json=SOURCES)
    assert res.status_code == 200, res.text
    assert [c["host"] for c in real_ai] == ["studoo.openai.azure.com"]
    assert real_ai[0]["headers"]["api-key"] == "cle-azure"


def test_a_saved_key_alone_changes_nothing(logged, real_ai):
    assert logged.put("/api/me/gemini-key", json={"key": KEY}).json()["prefs"] == {
        "transcription": False, "classement": False, "fiche": False, "exercices": False,
        "photos": False, "podcast": False, "video": False}
    logged.post("/api/ai/fiche", json=SOURCES)
    assert all(c["host"] != "generativelanguage.googleapis.com" for c in real_ai)


def test_chosen_feature_uses_the_student_key_only_for_it(logged, real_ai):
    logged.put("/api/me/gemini-key", json={"key": KEY})
    logged.put("/api/me/gemini-key/prefs", json={"prefs": {"fiche": True}})
    assert logged.post("/api/ai/fiche", json=SOURCES).status_code == 200
    google = [c for c in real_ai if c["host"] == "generativelanguage.googleapis.com"]
    assert len(google) == 1 and google[0]["headers"]["x-goog-api-key"] == KEY and KEY not in google[0]["url"]
    real_ai.clear()
    logged.post("/api/ai/ocr", json={"images": [{"data": "aW1n"}]})  # « photos » non coché : Azure
    assert [c["host"] for c in real_ai] == ["studoo.openai.azure.com"]


def test_back_to_default_at_any_time(logged, real_ai):
    logged.put("/api/me/gemini-key", json={"key": KEY})
    logged.put("/api/me/gemini-key/prefs", json={"prefs": {"fiche": True}})
    logged.put("/api/me/gemini-key/prefs", json={"prefs": {"fiche": False}})
    logged.post("/api/ai/fiche", json=SOURCES)
    assert [c["host"] for c in real_ai] == ["studoo.openai.azure.com"]
    logged.put("/api/me/gemini-key/prefs", json={"prefs": {"fiche": True}})
    assert logged.delete("/api/me/gemini-key").json()["set"] is False  # suppression en un clic
    real_ai.clear()
    logged.post("/api/ai/fiche", json=SOURCES)
    assert [c["host"] for c in real_ai] == ["studoo.openai.azure.com"]


def test_prefs_need_a_key_and_unknown_features_are_ignored(logged, real_ai):
    assert logged.put("/api/me/gemini-key/prefs", json={"prefs": {"fiche": True}}).status_code == 409
    logged.put("/api/me/gemini-key", json={"key": KEY})
    prefs = logged.put("/api/me/gemini-key/prefs", json={"prefs": {"fiche": True, "pirate": True}}).json()["prefs"]
    assert "pirate" not in prefs and prefs["fiche"] is True


def test_transcription_with_gemini_only_when_chosen(logged, real_ai, monkeypatch):
    from studoo.services import speech
    used = []

    async def fake_transcribe(audio, mime, **kw):
        used.append("azure")
        return {"language": "fr", "segments": [], "duration": 1.0}

    monkeypatch.setattr(speech, "transcribe", fake_transcribe)
    monkeypatch.setenv("SPEECH_KEY", "cle-speech")
    from studoo.config import get_settings
    get_settings.cache_clear()
    logged.put("/api/me/gemini-key", json={"key": KEY})
    logged.post("/api/ai/transcribe", content=AUDIO, headers={"Content-Type": "audio/webm"})
    assert used == ["azure"] and not real_ai
    logged.put("/api/me/gemini-key/prefs", json={"prefs": {"transcription": True}})
    logged.post("/api/ai/transcribe", content=AUDIO, headers={"Content-Type": "audio/webm"})
    assert used == ["azure"] and real_ai[0]["host"] == "generativelanguage.googleapis.com"


def test_no_site_ai_configured_is_said_clearly(logged, monkeypatch):
    monkeypatch.setenv("AI_FAKE", "0")
    monkeypatch.setenv("AZURE_OPENAI_KEY", "")
    monkeypatch.setenv("APP_URL", "https://studoo-app.vercel.app")
    from studoo.config import get_settings
    get_settings.cache_clear()
    from studoo.services import ai
    import asyncio
    from studoo.services.schemas import Fiche
    with pytest.raises(Exception) as exc:
        asyncio.run(ai.generate_json(feature="fiche", tier="flash", sub="dev-user", schema=Fiche, prompt="x"))
    assert exc.value.status_code == 503


def test_key_never_logged(logged, real_ai, caplog):
    logged.put("/api/me/gemini-key", json={"key": KEY})
    logged.put("/api/me/gemini-key/prefs", json={"prefs": {"fiche": True}})
    logged.post("/api/ai/fiche", json=SOURCES)
    assert KEY not in caplog.text
    from studoo import db
    with db.get_engine().connect() as conn:
        assert KEY not in str(conn.execute(select(db.user_keys)).first())
