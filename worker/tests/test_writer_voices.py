"""Écriture (Azure OpenAI / Groq → Gemini de l'élève → modèle local) et voix (Azure → Gemini de l'élève → voix locales)."""
import base64
import json

import httpx
import pytest

from studoo_worker import media, pipelines, settings, voices, writer

SCHEMA = {"type": "object", "properties": {"ok": {"type": "boolean"}}}


def mock_http(monkeypatch, handler):
    real = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))


def test_groq_writes_first(monkeypatch):
    monkeypatch.setattr(settings, "GROQ_API_KEY", "gk")
    seen = []

    def handler(req):
        seen.append(req.url.host)
        body = json.loads(req.content)
        assert req.headers["authorization"] == "Bearer gk" and body["response_format"]["type"] == "json_schema"
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"ok": true}'}}], "usage": {}})

    mock_http(monkeypatch, handler)
    assert writer.write("cours", SCHEMA, gemini_key="cle-eleve") == {"ok": True}
    assert seen == ["api.groq.com"]  # la clé de l'élève n'est pas utilisée quand Groq répond


def test_student_gemini_key_is_the_fallback(monkeypatch):
    monkeypatch.setattr(settings, "GROQ_API_KEY", "gk")
    monkeypatch.setattr(writer.time, "sleep", lambda s: None)
    seen = []

    def handler(req):
        seen.append(req.url.host)
        if req.url.host == "api.groq.com":
            return httpx.Response(503)
        assert req.headers["x-goog-api-key"] == "cle-eleve"
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": '{"ok": false}'}]}}]})

    mock_http(monkeypatch, handler)
    assert writer.write("cours", SCHEMA, gemini_key="cle-eleve") == {"ok": False}
    assert seen == ["api.groq.com", "generativelanguage.googleapis.com"]


def test_azure_openai_first_then_groq(monkeypatch):
    monkeypatch.setattr(settings, "AZURE_OPENAI_KEY", "ak")
    monkeypatch.setattr(settings, "AZURE_OPENAI_URL", "https://studoo.openai.azure.com/openai/v1/chat/completions")
    monkeypatch.setattr(settings, "GROQ_API_KEY", "gk")
    seen = []

    def handler(req):
        seen.append(req.url.host)
        if req.url.host == "studoo.openai.azure.com":
            assert req.headers["api-key"] == "ak" and json.loads(req.content)["model"] == settings.AZURE_OPENAI_MODEL
            return httpx.Response(500)
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"ok": true}'}}]})

    mock_http(monkeypatch, handler)
    assert writer.write("cours", SCHEMA) == {"ok": True}
    assert seen == ["studoo.openai.azure.com", "api.groq.com"]


def test_schema_refused_falls_back_to_free_json(monkeypatch):
    monkeypatch.setattr(settings, "AZURE_OPENAI_KEY", "ak")
    monkeypatch.setattr(settings, "AZURE_OPENAI_URL", "https://studoo.openai.azure.com/openai/v1/chat/completions")
    formats = []

    def handler(req):
        body = json.loads(req.content)
        formats.append(body["response_format"]["type"])
        if body["response_format"]["type"] == "json_schema":
            return httpx.Response(400, json={"error": {"message": "Invalid schema"}})
        assert "schéma" in body["messages"][-1]["content"]
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"ok": true}'}}]})

    mock_http(monkeypatch, handler)
    assert writer.write("cours", SCHEMA) == {"ok": True} and formats == ["json_schema", "json_object"]


def test_local_model_when_nothing_else(monkeypatch):
    monkeypatch.setattr(settings, "GROQ_API_KEY", "")

    class FakeLLM:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            pass

        def json(self, prompt, schema, **kw):
            return {"ok": "local"}

    monkeypatch.setattr(writer, "LLM", FakeLLM)
    assert writer.write("cours", SCHEMA) == {"ok": "local"}


def test_groq_waits_when_rate_limited(monkeypatch):
    monkeypatch.setattr(settings, "GROQ_API_KEY", "gk")
    waits, calls = [], []
    monkeypatch.setattr(writer.time, "sleep", waits.append)

    def handler(req):
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(429, headers={"retry-after": "7"})
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"ok": true}'}}]})

    mock_http(monkeypatch, handler)
    assert writer.write("cours", SCHEMA) == {"ok": True} and waits == [7.0]


def test_vivienne_henri_then_denise_then_student_gemini_with_notice(monkeypatch):
    clip = media.silence_mp3(0.5)
    pcm = base64.b64encode(b"\0\0" * 12000).decode()  # 0,5 s de silence brut
    monkeypatch.setattr(settings, "SPEECH_KEY", "sk")
    state = {"refuse": set(), "ssml": []}

    def handler(req):
        if req.url.host.endswith("tts.speech.microsoft.com"):
            body = req.content.decode()
            if any(v in body for v in state["refuse"]):
                return httpx.Response(403)  # voix indisponible / quota gratuit du mois épuisé
            state["ssml"].append(body)
            return httpx.Response(200, content=clip)
        assert req.headers["x-goog-api-key"] == "cle-eleve"
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"inlineData": {"data": pcm}}]}}]})

    mock_http(monkeypatch, handler)
    lines = [("A", "Bonjour <tout> le monde. Ça va, toi ?"), ("B", "Salut & bienvenue")]
    audio, notice = voices.synthesize(lines, gemini_key="cle-eleve")
    ssml = state["ssml"][0]
    assert notice == "" and 0.4 < media.seconds(audio) < 0.7
    assert "fr-FR-VivienneMultilingualNeural" in ssml and "fr-FR-HenriNeural" in ssml
    assert "&lt;tout&gt;" in ssml and "&amp;" in ssml
    assert "<prosody rate='-5%'>" in ssml and ssml.count("<s>") == 3 and "Comma-exact" in ssml  # allure radio
    state["refuse"] = {"Vivienne"}
    audio, notice = voices.synthesize(lines, gemini_key="cle-eleve")
    assert "fr-FR-DeniseNeural" in state["ssml"][-1] and notice == voices.NOTICE_BACKUP
    state["refuse"] = {"Vivienne", "Denise"}
    audio, notice = voices.synthesize(lines, gemini_key="cle-eleve")
    assert 0.4 < media.seconds(audio) < 0.7 and notice == voices.NOTICE_OTHER


def test_azure_voice_request_that_hangs_is_sent_again(monkeypatch):
    clip = media.silence_mp3(0.5)
    monkeypatch.setattr(settings, "SPEECH_KEY", "sk")
    calls = []

    def handler(req):
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ReadTimeout("bloquée", request=req)
        return httpx.Response(200, content=clip)

    mock_http(monkeypatch, handler)
    audio, notice = voices.synthesize([("A", "Bonjour")])  # Azure doit réussir au 2e essai
    assert len(calls) == 2 and notice == "" and 0.4 < media.seconds(audio) < 0.7


def test_long_dialogue_is_split_in_order():
    lines = [("A" if i % 2 else "B", "mot " * 200) for i in range(30)]
    groups = voices._chunks(lines)
    assert len(groups) > 1 and [line for g in groups for line in g] == lines
    assert all(sum(len(t) for _, t in g) <= voices.CHUNK_CHARS + 1000 for g in groups)


def test_video_slides_are_timed_on_the_voice(monkeypatch):
    slides = [{"title": f"D{i}", "bullets": ["a"], "doodle": "idea", "narration": f"Texte {i}"} for i in range(6)]
    monkeypatch.setattr(pipelines.writer, "write", lambda *a, **k: {"title": "Photosynthèse", "slides": slides})
    clips = [media.silence_mp3(1 + i) for i in range(6)]
    monkeypatch.setattr(pipelines.voices, "synthesize_groups", lambda groups, **k: voices.Voiced(clips[:len(groups)]))
    data, name, mime, kind, props, audio = pipelines.video(
        {"sources": [{"title": "C", "text": "Cours"}], "options": {"format": "short"}}, lambda p, s: None)
    doc = json.loads(data)
    assert kind == "video-anim" and name == "Vidéo — Photosynthèse.json" and len(doc["slides"]) == 6
    gap = media.seconds(media.silence_mp3(0.7))
    assert doc["slides"][1]["start"] == pytest.approx(media.seconds(clips[0]) + gap, abs=0.02)
    assert doc["slides"][5]["end"] == pytest.approx(sum(media.seconds(c) for c in clips) + 5 * gap, abs=0.05)
    # Le fichier final dure bien ce que prévoit le calage (pas de décalage qui s'accumule).
    assert doc["duration"] == pytest.approx(media.seconds(audio), abs=0.15)
