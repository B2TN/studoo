import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_URL", "http://localhost:5173")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'test.db'}")
    monkeypatch.setenv("AI_FAKE", "1")
    monkeypatch.setenv("DEV_LOGIN", "1")
    monkeypatch.setenv("ADMIN_EMAILS", "admin@example.com")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "client-id.apps.googleusercontent.com")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "secret")
    monkeypatch.setenv("SESSION_SECRET", "x" * 40)
    from studoo import db
    from studoo.config import get_settings
    get_settings.cache_clear()
    db.reset_engine()
    from studoo.services import accounts
    accounts.forget_cache()
    yield
    db.reset_engine()
    get_settings.cache_clear()


@pytest.fixture
def client():
    from studoo.main import app
    with TestClient(app, headers={"X-Studoo": "1"}) as c:
        yield c


@pytest.fixture
def logged(client):
    res = client.post("/api/auth/dev-login")
    assert res.status_code == 200
    return client


def add_user(sub: str, email: str, name: str = "x") -> None:
    """Crée la ligne du compte (une session n'est valable que si le compte existe en base)."""
    from studoo import db
    with db.get_engine().begin() as conn:
        conn.execute(db.users.insert().values(sub=sub, email=email, name=name, created_at=db.now(), last_seen_at=db.now()))
