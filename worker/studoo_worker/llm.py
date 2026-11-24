"""Modèle de langage open source (Qwen3-4B, licence Apache 2.0) exécuté sur le processeur.

On lance le programme officiel `llama-server` (llama.cpp) en arrière-plan, puis on lui
pose des questions en HTTP. La réponse est forcée au format JSON demandé (« grammaire »),
ce qui évite les réponses mal formées.
"""
import json
import logging
import subprocess
import tempfile
import time
import urllib.request

import httpx

from . import settings
from .storage import make_room

log = logging.getLogger(__name__)

GROUNDING = (
    "Tu es un professeur bienveillant qui écrit en français. Règle absolue : tu utilises UNIQUEMENT "
    "les informations des documents de cours fournis. Tu n'ajoutes aucun fait, date, exemple ou chiffre "
    "absent des documents. Si une information manque, tu ne l'inventes pas."
)
MAX_SOURCE_CHARS = 24_000  # ≈ 6 000 jetons : ce que le modèle peut lire en une fois avec la réponse


def model_path():
    path = settings.MODELS_DIR / settings.LLM_FILE
    if not path.exists():
        make_room(3.5, keep=settings.LLM_FILE)
        url = f"https://huggingface.co/{settings.LLM_REPO}/resolve/main/{settings.LLM_FILE}"
        tmp = path.with_suffix(".part")
        urllib.request.urlretrieve(url, tmp)  # téléchargé une seule fois, puis gardé
        tmp.rename(path)
    return path


class LLM:
    """Démarre llama-server à la demande et l'arrête à la fin de la tâche (libère la mémoire)."""

    def __init__(self, port: int = 8090):
        self.port = port
        self.proc = None

    def __enter__(self):
        # Le journal de llama-server (technique, sans contenu de cours) sert à expliquer un échec de démarrage.
        self.log = tempfile.TemporaryFile()
        self.proc = subprocess.Popen([
            settings.LLAMA_SERVER, "-m", str(model_path()), "--port", str(self.port), "--host", "127.0.0.1",
            "-c", str(settings.LLM_CONTEXT), "-t", str(settings.THREADS), "--no-webui",
        ], stdout=subprocess.DEVNULL, stderr=self.log)
        deadline = time.time() + 300
        while time.time() < deadline:
            try:
                if httpx.get(f"http://127.0.0.1:{self.port}/health", timeout=2).status_code == 200:
                    return self
            except httpx.HTTPError:
                pass
            if self.proc.poll() is not None:
                raise RuntimeError(f"Le modèle de langage n'a pas pu démarrer ({self._last_log_line()}).")
            time.sleep(1)
        raise RuntimeError("Le modèle de langage met trop de temps à démarrer.")

    def _last_log_line(self) -> str:
        self.log.seek(0)
        lines = [l.strip() for l in self.log.read().decode("utf-8", "replace").splitlines() if l.strip()]
        line = lines[-1] if lines else f"code {self.proc.returncode}"
        log.error("llama-server s'est arrêté : %s", "\n".join(lines[-20:]))
        return line[:200]

    def __exit__(self, *exc):
        self.log.close()
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    def json(self, prompt: str, schema: dict, *, max_tokens: int = 4096, temperature: float = 0.5) -> dict:
        res = httpx.post(f"http://127.0.0.1:{self.port}/v1/chat/completions", json={
            "messages": [{"role": "system", "content": GROUNDING}, {"role": "user", "content": prompt}],
            "temperature": temperature, "max_tokens": max_tokens,
            "response_format": {"type": "json_schema", "json_schema": {"name": "reponse", "schema": schema}},
        }, timeout=None)
        res.raise_for_status()
        return json.loads(res.json()["choices"][0]["message"]["content"])


def sources_prompt(sources: list[dict]) -> str:
    """Assemble les cours ; coupe si c'est trop long pour le modèle (en le signalant)."""
    parts, total = [], 0
    for i, s in enumerate(sources, 1):
        room = MAX_SOURCE_CHARS - total
        if room <= 200:
            break
        text = s["text"][:room]
        total += len(text)
        parts.append(f"### Document {i} : {s['title']}\n{text}")
    return "DOCUMENTS DE COURS (seule source autorisée) :\n\n" + "\n\n".join(parts)
