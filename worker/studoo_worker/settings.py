"""Réglages du worker (variables d'environnement du serveur de tâches)."""
import os
from pathlib import Path

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./studoo-dev.db")
JOB_SECRET = os.environ.get("JOB_SECRET", "dev-job-secret-change-me-dev-job-secret")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
APP_URL = os.environ.get("APP_URL", "https://studoo-app.vercel.app").rstrip("/")

# Réveil par file Azure Storage (adresse de la file + jeton SAS « p ») ; vide = pas de file
WORKER_QUEUE_URL = os.environ.get("WORKER_QUEUE_URL", "")

# Notifications
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")  # format PEM ou base64url
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "https://studoo-app.vercel.app/contact")
BREVO_API_KEY = os.environ.get("BREVO_API_KEY", "")  # e-mail de secours (facultatif)
MAIL_FROM = os.environ.get("MAIL_FROM", "")

# Écriture des scripts : Groq (modèles open source hébergés, offre gratuite, très rapide).
# Secours : Gemini avec la clé personnelle de l'élève (s'il en a mis une), puis le modèle local (lent).
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")
GROQ_URL = os.environ.get("GROQ_URL", "https://api.groq.com/openai/v1/chat/completions")
GEMINI_TEXT_MODEL = os.environ.get("GEMINI_TEXT_MODEL", "gemini-flash-latest")
GEMINI_TTS_MODEL = os.environ.get("GEMINI_TTS_MODEL", "gemini-2.5-flash-preview-tts")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models"

# Voix : Azure AI Speech (offre gratuite F0 : 500 000 caractères par mois), région du service « studoo-voix »
SPEECH_KEY = os.environ.get("SPEECH_KEY", "")
SPEECH_REGION = os.environ.get("SPEECH_REGION", "italynorth")

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
