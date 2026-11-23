import respx
from httpx import Response

from studoo.routes import auth
from studoo.security import decrypt_json, encrypt_json, sign_service_token, verify_service_token

DRIVE = "https://www.googleapis.com/auth/drive.file"


def test_encrypt_roundtrip_and_tamper():
    token = encrypt_json({"sub": "1", "rt": "secret"})
    assert "secret" not in token
    assert decrypt_json(token) == {"sub": "1", "rt": "secret"}
    assert decrypt_json(token[:-4] + "AAAA") is None


def test_service_token():
    tok = sign_service_token("abc")
    assert verify_service_token(tok) == "abc"
    payload, sig = tok.split(".")
    assert verify_service_token(payload + "." + sig[::-1]) is None
    assert verify_service_token(sign_service_token("abc", ttl=-1)) is None


def test_me_requires_login(client):
    assert client.get("/api/auth/me").json() == {"user": None}


def test_csrf_header_required(client):
    res = client.post("/api/auth/dev-login", headers={"X-Studoo": ""})
    assert res.status_code == 403


def test_dev_login_me_logout(logged):
    me = logged.get("/api/auth/me").json()["user"]
    assert me["name"] == "Léa Démo" and me["isAdmin"]
    assert logged.cookies.get("studoo_in") == "1"
    logged.post("/api/auth/logout")
    assert logged.get("/api/auth/me").json()["user"] is None


def test_dev_login_disabled_outside_localhost(client, monkeypatch):
    from studoo.config import get_settings
    monkeypatch.setenv("APP_URL", "https://studoo-app.vercel.app")
    get_settings.cache_clear()
    assert client.post("/api/auth/dev-login").status_code == 404


def _mock_google(monkeypatch, scope=DRIVE, refresh="rt-123"):
    monkeypatch.setattr(auth, "_verify_id_token", lambda t: {"sub": "g-1", "email": "eleve@example.com", "name": "Élève"})
    body = {"access_token": "at", "expires_in": 3599, "id_token": "idt", "scope": f"openid email {scope}"}
    if refresh:
        body["refresh_token"] = refresh
    return respx.post(auth.TOKEN_URL).mock(return_value=Response(200, json=body))


@respx.mock
def test_google_login_sets_encrypted_session(client, monkeypatch):
    _mock_google(monkeypatch)
    res = client.post("/api/auth/google", json={"code": "4/abcdefghijkl"})
    assert res.status_code == 200
    assert res.json()["accessToken"] == "at"
    cookie = client.cookies.get("studoo_session")
    assert "rt-123" not in cookie
    assert decrypt_json(cookie)["rt"] == "rt-123"


@respx.mock
def test_google_login_requires_drive_scope(client, monkeypatch):
    _mock_google(monkeypatch, scope="")
    res = client.post("/api/auth/google", json={"code": "4/abcdefghijkl"})
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "drive_scope_missing"


@respx.mock
def test_google_login_without_refresh_asks_consent(client, monkeypatch):
    _mock_google(monkeypatch, refresh=None)
    res = client.post("/api/auth/google", json={"code": "4/abcdefghijkl"})
    assert res.status_code == 409


def test_delete_account(logged):
    assert logged.delete("/api/auth/account").status_code == 200
    assert logged.get("/api/auth/me").json()["user"] is None
