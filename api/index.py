"""Fonction Vercel : expose l'API FastAPI sous /api/*."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from studoo.main import app  # noqa: E402,F401
