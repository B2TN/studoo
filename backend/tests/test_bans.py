"""Itération 7 (C3) : corbeille de l'admin → supprimer le compte, ou le bannir (compte, e-mail, IP, appareil)."""
from datetime import timedelta

from fastapi import Response
from fastapi.testclient import TestClient
from sqlalchemy import select

from conftest import add_user
from studoo import db
from studoo.deps import write_session

DEVICE = "appareil-0123456789abcdef"


def client_for(sub, email, *, ip="203.0.113.7", device=DEVICE):
    """Navigateur d'un élève (session + adresse IP + identifiant d'appareil)."""
    from studoo.main import app
    c = TestClient(app, headers={"X-Studoo": "1", "X-Forwarded-For": ip, "X-Studoo-Device": device})
    resp = Response()
    write_session(resp, {"sub": sub, "email": email, "name": "x", "rt": "r"})
    c.cookies.set("studoo_session", resp.headers["set-cookie"].split("=", 1)[1].split(";")[0])
    return c


def as_admin(monkeypatch):
    from studoo.deps import admin_user
    from studoo.main import app
    from studoo.deps import User
    app.dependency_overrides[admin_user] = lambda: User("a1", "admin@example.com", "Admin", "", "r")
    return app


def student(monkeypatch, sub="s1", email="marie@exemple.fr", **kw):
    add_user(sub, email)
    c = client_for(sub, email, **kw)
    assert c.get("/api/auth/me").json()["user"]["email"] == email  # enregistre IP et appareil (empreintes)
    return c


def test_delete_erases_everything_and_ends_the_session(logged, monkeypatch):
    s = student(monkeypatch)
    with db.get_engine().begin() as conn:
        conn.execute(db.user_keys.insert().values(sub="s1", gemini_key="x", hint="abcd", updated_at=db.now(), prefs="{}"))
    app = as_admin(monkeypatch)
    try:
        res = logged.post("/api/admin/users/s1/remove", json={"mode": "delete", "reason": "demande de l'élève"})
    finally:
        app.dependency_overrides.clear()
    assert res.status_code == 200 and res.json()["blocked"] == []
    with db.get_engine().connect() as conn:
        assert conn.execute(select(db.users).where(db.users.c.sub == "s1")).first() is None
        assert conn.execute(select(db.user_keys).where(db.user_keys.c.sub == "s1")).first() is None
    assert s.get("/api/jobs").status_code == 401  # la session ne marche plus
    assert s.get("/api/auth/me").json()["user"] is None
    # mais il peut revenir : une simple suppression ne bannit pas
    assert client_for("s1", "marie@exemple.fr").post("/api/auth/dev-login").status_code == 200


def test_ban_blocks_account_email_ip_and_device_with_hashes_only(logged, monkeypatch):
    student(monkeypatch)
    app = as_admin(monkeypatch)
    try:
        res = logged.post("/api/admin/users/s1/remove", json={"mode": "ban", "days": 30, "reason": "spam"})
    finally:
        app.dependency_overrides.clear()
    assert sorted(res.json()["blocked"]) == ["account", "device", "email", "ip"]
    with db.get_engine().connect() as conn:
        bans = conn.execute(select(db.bans)).mappings().all()
    stored = " ".join(str(dict(b)) for b in bans)
    assert "marie@exemple.fr" not in stored and "203.0.113.7" not in stored and DEVICE not in stored  # empreintes seulement
    assert {b["label"] for b in bans} == {"m•••@exemple.fr"}
    import pytest
    from fastapi import HTTPException
    from starlette.requests import Request
    from studoo.services import accounts

    def req(ip, device):
        return Request({"type": "http", "headers": [(b"x-forwarded-for", ip.encode()), (b"x-studoo-device", device.encode())]})
    # même e-mail (nouveau compte Google), autre réseau, autre appareil : connexion refusée (réinscription)
    with pytest.raises(HTTPException) as exc:
        accounts.check_login(req("198.51.100.1", "autre-appareil-99999999"), "s2", "marie@exemple.fr")
    assert exc.value.status_code == 403 and exc.value.detail["code"] == "banned"
    assert accounts.active_ban(email="MARIE@exemple.fr")  # insensible à la casse
    assert accounts.active_ban(ip=accounts.fingerprints(req("203.0.113.7", "x" * 20))["ip"])  # même IP, autre compte
    assert accounts.active_ban(device=accounts.fingerprints(req("192.0.2.1", DEVICE))["device"])  # même appareil
    assert accounts.active_ban(email="innocent@exemple.fr", ip=accounts.fingerprints(req("192.0.2.1", "y" * 20))["ip"]) is None


def test_ip_ban_is_always_temporary(logged, monkeypatch):
    student(monkeypatch)
    app = as_admin(monkeypatch)
    try:
        logged.post("/api/admin/users/s1/remove", json={"mode": "ban", "days": None, "reason": "définitif"})
    finally:
        app.dependency_overrides.clear()
    with db.get_engine().connect() as conn:
        rows = {b["kind"]: b for b in conn.execute(select(db.bans)).mappings().all()}
    assert rows["account"]["expires_at"] is None and rows["email"]["expires_at"] is None  # définitif
    ip_end = rows["ip"]["expires_at"].replace(tzinfo=None)
    assert ip_end <= (db.now() + timedelta(days=30, minutes=1)).replace(tzinfo=None)  # IP partagée : 30 jours au plus


def test_banned_session_is_refused_and_lift_works(logged, monkeypatch):
    from studoo.services import accounts
    s = student(monkeypatch)
    other = student(monkeypatch, "s3", "camarade@exemple.fr")  # même IP et même appareil (ordinateur de la classe)
    app = as_admin(monkeypatch)
    try:
        logged.post("/api/admin/users/s1/remove", json={"mode": "ban", "days": 7})
        assert s.get("/api/jobs").status_code == 401  # compte supprimé
        refused = other.get("/api/jobs")
        assert refused.status_code == 403 and refused.json()["detail"]["code"] == "banned"  # IP/appareil bannis
        ban_id = logged.get("/api/admin/bans").json()["bans"][0]["id"]
        assert logged.post(f"/api/admin/bans/{ban_id}/lift", json={"reason": "erreur : ordinateur partagé"}).status_code == 200
        accounts.forget_cache()
        assert other.get("/api/jobs").status_code == 200  # levé : l'innocent retrouve l'accès
        log = logged.get("/api/admin/log").json()["log"]
    finally:
        app.dependency_overrides.clear()
    assert [e["action"] for e in log][:2] == ["unban", "ban"]
    assert log[0]["reason"] == "erreur : ordinateur partagé" and log[1]["admin"] == "admin@example.com"


def test_admin_only_and_never_an_admin(logged, monkeypatch):
    student(monkeypatch)
    s = student(monkeypatch, "s4", "curieux@exemple.fr", ip="192.0.2.50", device="z" * 20)
    assert s.post("/api/admin/users/s1/remove", json={"mode": "ban"}).status_code == 403  # protégé côté serveur
    assert s.get("/api/admin/bans").status_code == 403 and s.get("/api/admin/log").status_code == 403
    add_user("a1", "admin@example.com")
    app = as_admin(monkeypatch)
    try:
        res = logged.post("/api/admin/users/a1/remove", json={"mode": "ban"})
    finally:
        app.dependency_overrides.clear()
    assert res.status_code == 422 and res.json()["detail"]["code"] == "is_admin"


def test_purge_keeps_durations(logged):
    from studoo.services import accounts
    old = db.now() - timedelta(days=40)
    with db.get_engine().begin() as conn:
        conn.execute(db.bans.insert().values(created_at=old, expires_at=old + timedelta(days=1), kind="ip", value_hash="h", label="x"))
        conn.execute(db.bans.insert().values(created_at=old, expires_at=None, kind="email", value_hash="h2", label="x"))
        conn.execute(db.admin_log.insert().values(created_at=db.now() - timedelta(days=400), admin="a", action="ban"))
        accounts.purge(conn)
        kinds = [r.kind for r in conn.execute(select(db.bans))]
        assert kinds == ["email"]  # définitif : gardé ; terminé depuis plus de 30 jours : effacé
        assert conn.execute(select(db.admin_log)).first() is None
