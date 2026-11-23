"""Réglages de l'application, lus depuis les variables d'environnement.

Aucune clé n'est écrite dans le code : tout passe par l'environnement
(fichier `.env` en local, variables Vercel en production).
"""
from functools import lru_cache
from urllib.parse import urlparse

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "Studoo"
    app_url: str = "http://localhost:5173"

    # Connexion Google (OAuth 2.0)
    google_client_id: str = ""
    google_client_secret: str = ""

    # IA Gemini (clé du propriétaire du site, jamais envoyée au navigateur)
    gemini_api_key: str = ""
    gemini_model_lite: str = "gemini-flash-lite-latest"
    gemini_model_flash: str = "gemini-flash-latest"
    gemini_model_tts: str = "gemini-2.5-flash-preview-tts"

    # Quotas quotidiens (niveau gratuit, partagés entre tous les utilisateurs)
    quota_lite_per_day: int = 450
    quota_flash_per_day: int = 18
    quota_tts_per_day: int = 12
    quota_user_per_day: int = 60

    # Sécurité
    session_secret: str = Field(default="dev-secret-change-me-dev-secret-change-me", min_length=32)  # voir DEFAULT_SECRET
    admin_emails: str = ""

    # Base de données (SQLite en local, Postgres Neon en production)
    database_url: str = "sqlite:///./studoo-dev.db"

    # Modes de développement (refusés automatiquement hors localhost)
    ai_fake: bool = False
    dev_login: bool = False

    @property
    def is_local(self) -> bool:
        host = urlparse(self.app_url).hostname or ""
        return host in {"localhost", "127.0.0.1"} or host.endswith(".localhost")

    @property
    def secure_cookies(self) -> bool:
        return self.app_url.startswith("https://")

    @property
    def admin_list(self) -> set[str]:
        return {e.strip().lower() for e in self.admin_emails.split(",") if e.strip()}

    @property
    def dev_login_enabled(self) -> bool:
        return self.dev_login and self.is_local

    @property
    def ai_fake_enabled(self) -> bool:
        # Le mode « IA factice » sert aux tests et aux démos locales uniquement.
        return self.is_local and (self.ai_fake or not self.gemini_api_key)


DEFAULT_SECRET = "dev-secret-change-me-dev-secret-change-me"


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    if not s.is_local and s.session_secret == DEFAULT_SECRET:
        # Sécurité : on refuse de démarrer en ligne avec la clé de développement.
        raise RuntimeError("SESSION_SECRET doit être défini en production.")
    return s
