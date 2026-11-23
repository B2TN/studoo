from studoo import db


def test_config_has_no_secret(client):
    data = client.get("/api/config").json()
    assert data["googleClientId"].endswith("googleusercontent.com")
    assert "secret" not in str(data).lower()


def test_page_views_are_counted_without_cookie(client):
    for path in ["/", "/", "/cours/1AbCdEfGhIjKlMnOpQrStUvWx"]:
        assert client.post("/api/events", json={"path": path}).status_code == 204
    assert db.read_count(db.page_views, {"day": db.today(), "path": "/"}) == 2
    assert db.read_count(db.page_views, {"day": db.today(), "path": "/cours/:id"}) == 1
    client.post("/api/events", json={"path": "javascript:alert(1)"})
    assert "set-cookie" not in client.post("/api/events", json={"path": "/"}).headers


def _contact(**over):
    data = {"email": "a@example.com", "subject": "Bonjour", "message": "Un message assez long.", "website": "", "elapsed_ms": 8000}
    data.update(over)
    return data


def _count_messages():
    from sqlalchemy import func, select
    with db.get_engine().connect() as conn:
        return conn.execute(select(func.count()).select_from(db.messages)).scalar_one()


def test_contact_saves_and_blocks_bots(client):
    assert client.post("/api/contact", json=_contact()).status_code == 200
    assert client.post("/api/contact", json=_contact(website="http://spam")).status_code == 200
    assert client.post("/api/contact", json=_contact(elapsed_ms=500)).status_code == 200
    assert _count_messages() == 1


def test_contact_validation_in_french(client):
    res = client.post("/api/contact", json=_contact(email="pas-un-email"))
    assert res.status_code == 422
    assert res.json()["detail"]["errors"][0]["field"] == "email"


def test_contact_rate_limited(client):
    codes = [client.post("/api/contact", json=_contact()).status_code for _ in range(5)]
    assert codes[:3] == [200, 200, 200] and 429 in codes


def test_admin_forbidden_for_normal_user(client, monkeypatch):
    from studoo.deps import write_session
    from fastapi import Response
    resp = Response()
    write_session(resp, {"sub": "u1", "email": "eleve@example.com", "name": "x", "rt": "r"})
    client.cookies.set("studoo_session", resp.headers["set-cookie"].split("=", 1)[1].split(";")[0])
    assert client.get("/api/admin/overview").status_code == 403


def test_admin_overview_and_analytics(client):
    from studoo.deps import write_session
    from fastapi import Response
    resp = Response()
    write_session(resp, {"sub": "a1", "email": "admin@example.com", "name": "Admin", "rt": "r"})
    client.cookies.set("studoo_session", resp.headers["set-cookie"].split("=", 1)[1].split(";")[0])
    client.post("/api/events", json={"path": "/"})
    ov = client.get("/api/admin/overview").json()
    assert "quota" in ov and ov["unreadMessages"] == 0
    an = client.get("/api/admin/analytics?days=7").json()
    assert len(an["series"]) == 7 and an["series"][-1]["views"] == 1


def test_security_headers(client):
    res = client.get("/api/health")
    assert res.headers["x-content-type-options"] == "nosniff"


def test_purge_old_data(client):
    from datetime import timedelta
    from sqlalchemy import func, insert, select
    from studoo.routes.site import purge_old_data
    with db.get_engine().begin() as conn:
        conn.execute(insert(db.visitors).values(day=db.today() - timedelta(days=5), hash="old"))
        conn.execute(insert(db.visitors).values(day=db.today(), hash="new"))
        conn.execute(insert(db.rate_limits).values(key="k", window=1, count=1))
    purge_old_data()
    with db.get_engine().connect() as conn:
        assert conn.execute(select(func.count()).select_from(db.visitors)).scalar_one() == 1
        assert conn.execute(select(func.count()).select_from(db.rate_limits)).scalar_one() == 0
