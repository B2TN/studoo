"""Clé Gemini personnelle de l'élève : vérifiée par Google, chiffrée, jamais renvoyée, transmise aux tâches."""
import httpx
from sqlalchemy import select

KEY = "AIzaSyD-exemple_de_cle_gemini_1234567890"


def _google(monkeypatch, status=200):
    seen = []

    async def fake_get(self, url, params=None, headers=None):
        seen.append(headers["x-goog-api-key"])
        return httpx.Response(status, json={}, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    return seen


def test_save_status_and_delete(logged, monkeypatch):
    seen = _google(monkeypatch)
    assert logged.get("/api/me/gemini-key").json()["set"] is False
    res = logged.put("/api/me/gemini-key", json={"key": KEY})
    assert res.status_code == 200 and res.json()["set"] and res.json()["hint"] == "7890"
    assert seen == [KEY]
    assert KEY not in logged.get("/api/me/gemini-key").text  # jamais renvoyée en clair
    from studoo import db
    with db.get_engine().connect() as conn:
        stored = conn.execute(select(db.user_keys.c.gemini_key)).scalar()
    assert KEY not in stored  # chiffrée dans la base
    assert logged.delete("/api/me/gemini-key").json()["set"] is False
    assert logged.get("/api/me/gemini-key").json()["set"] is False


def test_key_refused_by_google_or_malformed(logged, monkeypatch):
    _google(monkeypatch, status=400)
    res = logged.put("/api/me/gemini-key", json={"key": KEY})
    assert res.status_code == 400 and "refuse" in res.json()["detail"]["message"]
    res = logged.put("/api/me/gemini-key", json={"key": "pas une clé valable avec des espaces !!"})
    assert res.status_code == 422
    assert logged.get("/api/me/gemini-key").json()["set"] is False


def test_key_goes_into_the_sealed_job_payload(logged, monkeypatch):
    _google(monkeypatch)
    logged.put("/api/me/gemini-key", json={"key": KEY})
    res = logged.post("/api/jobs", json={"kind": "podcast", "sources": [{"title": "C", "text": "Cours"}],
                                         "options": {"minutes": 10, "voice": "vivienne-remy"}, "folder_id": "dossier1"})
    assert res.status_code == 201, res.text
    from studoo import db
    from studoo.config import get_settings
    from studoo.jobcrypto import open_payload
    with db.get_engine().connect() as conn:
        sealed = conn.execute(select(db.jobs.c.payload)).scalar()
    assert KEY not in sealed and open_payload(get_settings().job_secret, sealed)["gemini_key"] == KEY


def test_key_is_tied_to_its_owner(logged, monkeypatch):
    _google(monkeypatch)
    logged.put("/api/me/gemini-key", json={"key": KEY})
    from studoo import db
    from studoo.services import user_keys
    with db.get_engine().begin() as conn:  # on recopie la clé chiffrée sur un autre compte
        token = conn.execute(select(db.user_keys.c.gemini_key)).scalar()
        conn.execute(db.user_keys.insert().values(sub="autre", gemini_key=token, hint="x", updated_at=db.now()))
    assert user_keys.load("autre") == ""


def test_account_deletion_removes_the_key(logged, monkeypatch):
    _google(monkeypatch)
    logged.put("/api/me/gemini-key", json={"key": KEY})
    assert logged.delete("/api/auth/account").status_code == 200
    from studoo import db
    with db.get_engine().connect() as conn:
        assert conn.execute(select(db.user_keys)).first() is None
