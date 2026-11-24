"""Réglages du worker (variables d'environnement du serveur de tâches)."""
import os
from pathlib import Path

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./studoo-dev.db")
JOB_SECRET = os.environ.get("JOB_SECRET", "dev-job-secret-change-me-dev-job-secret")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
APP_URL = os.environ.get("APP_URL", "https://studoo-app.vercel.app").rstrip("/")

# Notifications
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")  # format PEM ou base64url
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "https://studoo-app.vercel.app/contact")
BREVO_API_KEY = os.environ.get("BREVO_API_KEY", "")  # e-mail de secours (facultatif)
MAIL_FROM = os.environ.get("MAIL_FROM", "")

# Modèles open source (téléchargés au premier usage, gardés dans MODELS_DIR)
MODELS_DIR = Path(os.environ.get("MODELS_DIR", "/models"))
LLAMA_SERVER = os.environ.get("LLAMA_SERVER", "llama-server")
LLM_REPO = os.environ.get("LLM_REPO", "unsloth/Qwen3-4B-Instruct-2507-GGUF")
LLM_FILE = os.environ.get("LLM_FILE", "Qwen3-4B-Instruct-2507-Q4_K_M.gguf")
LLM_CONTEXT = int(os.environ.get("LLM_CONTEXT", "16384"))
OCR_MODEL = os.environ.get("OCR_MODEL", "Qwen/Qwen3-VL-2B-Instruct")
THREADS = int(os.environ.get("THREADS", str(os.cpu_count() or 2)))

# File d'attente
MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "3"))
LOCK_MINUTES = int(os.environ.get("LOCK_MINUTES", "30"))
KEEP_FAILED_HOURS = int(os.environ.get("KEEP_FAILED_HOURS", "24"))
