import base64

from studoo import db

SOURCES = {"sources": [{"title": "Cours 1", "text": "Une suite géométrique de raison q vérifie u(n+1) = q u(n)."}],
           "course": "Maths", "chapter": "Suites"}


def test_ai_requires_login(client):
    assert client.post("/api/ai/fiche", json=SOURCES).status_code == 401


def test_transcribe_chunk(logged):
    res = logged.post("/api/ai/transcribe?index=0", content=b"\x1a\x45\xdf\xa3fake", headers={"Content-Type": "audio/webm"})
    assert res.status_code == 200
    assert res.json()["segments"][0]["speaker"] == "Professeur"
    assert db.read_count(db.generations, {"day": db.today(), "kind": "transcription"}) == 1


def test_transcribe_rejects_bad_type(logged):
    res = logged.post("/api/ai/transcribe", content=b"x", headers={"Content-Type": "text/plain"})
    assert res.status_code == 415


def test_fiche_podcast_video(logged):
    assert logged.post("/api/ai/fiche", json=SOURCES).json()["sections"]
    pod = logged.post("/api/ai/podcast", json={**SOURCES, "minutes": 20}).json()
    assert len(pod["lines"]) >= 20
    vid = logged.post("/api/ai/video", json={**SOURCES, "format": "medium"}).json()
    assert len(vid["slides"]) == 20


def test_invalid_duration_refused(logged):
    assert logged.post("/api/ai/podcast", json={**SOURCES, "minutes": 15}).status_code == 422


def test_tts_returns_pcm(logged):
    res = logged.post("/api/ai/tts", json={"lines": [{"speaker": "A", "text": "Bonjour à tous"}]})
    assert res.status_code == 200
    assert res.headers["x-sample-rate"] == "24000" and len(res.content) > 1000


def test_ocr_bad_base64(logged):
    res = logged.post("/api/ai/ocr", json={"images": [{"data": "%%%", "mime": "image/jpeg"}]})
    assert res.status_code == 422
    ok = logged.post("/api/ai/ocr", json={"images": [{"data": base64.b64encode(b"img").decode()}]})
    assert ok.status_code == 200


def test_site_quota_exhausted(logged, monkeypatch):
    monkeypatch.setenv("QUOTA_FLASH_PER_DAY", "0")
    monkeypatch.setenv("QUOTA_LITE_PER_DAY", "1")
    from studoo.config import get_settings
    get_settings.cache_clear()
    assert logged.post("/api/ai/fiche", json=SOURCES).status_code == 200  # bascule sur Flash-Lite
    res = logged.post("/api/ai/fiche", json=SOURCES)
    assert res.status_code == 429 and res.json()["detail"]["code"] == "site_quota"


def test_quota_status(logged):
    q = logged.get("/api/ai/quota").json()
    assert set(q) == {"lite", "flash", "tts", "user"}
