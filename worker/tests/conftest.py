import os
from pathlib import Path

os.environ.setdefault("MODELS_DIR", str(Path(__file__).parent / ".models"))  # polices téléchargées une fois

import pytest


@pytest.fixture(autouse=True)
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_URL", "http://localhost:5173")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'w.db'}")
    from studoo import db
    from studoo.config import get_settings
    get_settings.cache_clear()
    db.reset_engine()
    yield
    db.reset_engine()
