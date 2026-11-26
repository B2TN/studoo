"""Itération 6 (C4) : signaler un établissement (erreur du robot ou non reconnu), sans aucune donnée sensible."""
from sqlalchemy import select

from studoo import db

REPORT = {"establishment": "Université d'Exemple", "software": "hyperplanning", "error_code": "page_changed", "elapsed_ms": 4000}


def test_report_is_stored_without_sensitive_data(logged):
    res = logged.post("/api/timetable/report", json=REPORT)
    assert res.status_code == 200 and res.json() == {"ok": True, "duplicate": False}
    with db.get_engine().connect() as conn:
        row = conn.execute(select(db.school_reports)).mappings().one()
    assert row["establishment"] == "Université d'Exemple" and row["software"] == "hyperplanning"
    assert row["error_code"] == "page_changed"
    assert "dev" not in row["reporter"] and len(row["reporter"]) == 48  # empreinte, pas l'identifiant du compte
    assert set(row.keys()) == {"id", "created_at", "establishment", "software", "error_code", "reporter"}


def test_same_student_counted_once_per_day(logged):
    logged.post("/api/timetable/report", json=REPORT)
    again = logged.post("/api/timetable/report", json={**REPORT, "establishment": "  université d'EXEMPLE "})
    assert again.json()["duplicate"] is True
    with db.get_engine().connect() as conn:
        assert len(conn.execute(select(db.school_reports)).all()) == 1


def test_anti_spam_honeypot_too_fast_and_rate_limit(logged):
    assert logged.post("/api/timetable/report", json={**REPORT, "website": "http://spam"}).json()["ok"] is True
    assert logged.post("/api/timetable/report", json={**REPORT, "elapsed_ms": 200}).json()["ok"] is True
    with db.get_engine().connect() as conn:
        assert conn.execute(select(db.school_reports)).first() is None  # rien gardé
    codes = [logged.post("/api/timetable/report", json={**REPORT, "establishment": f"École {i}"}).status_code for i in range(8)]
    assert 429 in codes


def test_validation_and_unknown_values(logged):
    assert logged.post("/api/timetable/report", json={**REPORT, "establishment": " "}).status_code == 422
    assert logged.post("/api/timetable/report", json={**REPORT, "establishment": "x" * 300}).status_code == 422
    logged.post("/api/timetable/report", json={**REPORT, "software": "<script>", "error_code": "rm -rf"})
    with db.get_engine().connect() as conn:
        row = conn.execute(select(db.school_reports)).mappings().one()
    assert (row["software"], row["error_code"]) == ("autre", "other")


def test_requires_login(client):
    assert client.post("/api/timetable/report", json=REPORT).status_code == 401


def test_admin_list_groups_most_requested_first(logged, monkeypatch):
    from studoo.routes import timetable
    for who in ("a", "b", "c"):
        monkeypatch.setattr(timetable, "_reporter", lambda sub, who=who: who * 48)
        logged.post("/api/timetable/report", json={**REPORT, "error_code": "timeout" if who == "c" else "page_changed"})
    monkeypatch.setattr(timetable, "_reporter", lambda sub: "d" * 48)
    logged.post("/api/timetable/report", json={**REPORT, "establishment": "Autre école", "software": "aurion"})
    assert logged.get("/api/admin/school-reports").status_code == 403  # pas admin
    from studoo.deps import admin_user
    from studoo.main import app
    app.dependency_overrides[admin_user] = lambda: None
    try:
        reports = logged.get("/api/admin/school-reports").json()["reports"]
    finally:
        app.dependency_overrides.clear()
    assert reports[0] == {**reports[0], "establishment": "Université d'Exemple", "software": "hyperplanning", "count": 3,
                          "people": 3, "errors": {"page_changed": 2, "timeout": 1}}
    assert reports[1]["software"] == "aurion" and reports[1]["count"] == 1
