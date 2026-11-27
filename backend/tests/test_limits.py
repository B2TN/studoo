"""Itération 7 (C4) : les limites affichées (page RGPD, interface) sont lues dans la configuration du code."""
from pathlib import Path

from studoo.config import get_settings
from studoo.limits import RATES

SOURCES = {"sources": [{"title": "C", "text": "Cours"}], "options": {"minutes": 10}, "folder_id": "dossier1"}


def test_public_limits_come_from_the_config(client, monkeypatch):
    monkeypatch.setenv("QUOTA_USER_PER_DAY", "42")
    monkeypatch.setenv("QUOTA_JOBS_PER_DAY", "7")
    get_settings.cache_clear()
    data = client.get("/api/limits").json()  # page publique : pas besoin d'être connecté
    assert data["perUser"] == {"ai": 42, "jobs": 7, "pendingJobs": get_settings().max_pending_jobs}
    assert data["rates"]["transcribe"] == {"count": RATES["transcribe"][0], "minutes": RATES["transcribe"][1] // 60}
    assert "minuit" in data["reset"] and "Paris" in data["reset"]


def test_rgpd_page_reads_the_limits_instead_of_copying_them():
    page = (Path(__file__).parents[2] / "frontend" / "rgpd.html").read_text(encoding="utf-8")
    assert 'id="limites-ia"' in page and "data-limit=" in page
    for number in ("60 demandes", "10 générations"):  # aucune valeur recopiée en dur
        assert number not in page


def test_daily_job_limit_is_enforced_server_side(logged, monkeypatch):
    monkeypatch.setenv("QUOTA_JOBS_PER_DAY", "2")
    monkeypatch.setenv("MAX_PENDING_JOBS", "50")
    get_settings.cache_clear()
    codes = [logged.post("/api/jobs", json={**SOURCES, "kind": "podcast", "sources": [{"title": "C", "text": f"Cours {i}"}]}).status_code
             for i in range(3)]
    assert codes == [201, 201, 429]
    res = logged.post("/api/jobs", json={**SOURCES, "kind": "video", "options": {"format": "short"}})
    assert res.status_code == 429 and res.json()["detail"]["code"] == "jobs_quota"
    q = logged.get("/api/ai/quota").json()
    assert q["jobs"] == {"used": 2, "limit": 2, "remaining": 0}


def test_double_click_does_not_count_twice(logged, monkeypatch):
    monkeypatch.setenv("QUOTA_JOBS_PER_DAY", "1")
    get_settings.cache_clear()
    first = logged.post("/api/jobs", json={**SOURCES, "kind": "podcast"})
    again = logged.post("/api/jobs", json={**SOURCES, "kind": "podcast"})
    assert first.status_code == 201 and again.status_code in (200, 201) and again.json().get("existing") is True


def test_site_wide_job_cap_against_mass_accounts(logged, monkeypatch):
    """Audit de sécurité : même avec beaucoup de comptes, le serveur de tâches a un plafond global par jour."""
    monkeypatch.setenv("QUOTA_SITE_JOBS_PER_DAY", "1")
    get_settings.cache_clear()
    assert logged.post("/api/jobs", json={**SOURCES, "kind": "podcast"}).status_code == 201
    res = logged.post("/api/jobs", json={**SOURCES, "kind": "podcast", "sources": [{"title": "C", "text": "Autre cours"}]})
    assert res.status_code == 429 and res.json()["detail"]["code"] == "site_jobs_quota"
