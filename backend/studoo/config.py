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

    # IA de Studoo : Azure OpenAI (GPT-4.1 mini, ressource « studoo-ecriture », crédit Azure for Students).
    # Adresse du type https://<ressource>.openai.azure.com/openai/v1/chat/completions
    azure_openai_key: str = ""
    azure_openai_url: str = ""
    azure_openai_model: str = "gpt-4.1-mini"

    # Gemini : UNIQUEMENT avec la clé personnelle d'un élève qui l'a choisi (aucune clé du site).
    gemini_model_flash: str = "gemini-flash-latest"

    # Transcription des cours : Azure AI Speech (service « studoo-voix », offre gratuite F0)
    speech_key: str = ""
    speech_region: str = "italynorth"

    # Quotas quotidiens de l'IA du site (partagés entre tous les élèves, pour tenir dans le crédit Azure)
    quota_lite_per_day: int = 2000
    quota_flash_per_day: int = 300
    quota_user_per_day: int = 60   # demandes d'IA « en direct » par élève et par jour (transcription, rangement, fiches, PDF)
    quota_jobs_per_day: int = 10   # générations sur le serveur de tâches par élève et par jour (podcasts, vidéos, exercices…)
    quota_site_jobs_per_day: int = 150  # plafond global du serveur de tâches (contre la création de comptes en masse)

    # Sécurité
    session_secret: str = Field(default="dev-secret-change-me-dev-secret-change-me", min_length=32)  # voir DEFAULT_SECRET
    admin_emails: str = ""

    # Tâches de fond : clé de chiffrement du contenu des tâches (partagée avec le worker),
    # clé publique des notifications web, nombre max de tâches en attente par élève (anti-spam)
    job_secret: str = Field(default="dev-job-secret-change-me-dev-job-secret", min_length=32)
    vapid_public_key: str = ""
    worker_queue_url: str = ""  # file Azure « studoo-jobs » + jeton SAS d'ajout seul (réveil du serveur de tâches)
    max_pending_jobs: int = 5
    # E-mail « c'est prêt » de secours (Brevo, réglé sur le serveur de tâches) : à mettre à 1 seulement quand il est
    # vraiment configuré, pour que le site ne promette pas d'e-mail qui ne part pas.
    email_notifications: bool = False
    # Suivi des erreurs (Sentry) : adresse « DSN » publique du projet ; vide = désactivé.
    sentry_dsn: str = ""

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
        return self.is_local and (self.ai_fake or not self.azure_openai_key)


DEFAULT_SECRET = "dev-secret-change-me-dev-secret-change-me"


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    if not s.is_local and s.session_secret == DEFAULT_SECRET:
        # Sécurité : on refuse de démarrer en ligne avec la clé de développement.
        raise RuntimeError("SESSION_SECRET doit être défini en production.")
    return s
