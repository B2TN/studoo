# Serveur de tâches Studoo (podcasts, vidéos, lecture de copies) — tout tourne sur processeur.
# Construit depuis la racine du dépôt :  docker build -f worker/Dockerfile .

# 1) Programme officiel llama.cpp (modèle de langage), déjà compilé
FROM ghcr.io/ggml-org/llama.cpp:server-b12679 AS llama

# 2) Image du worker
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgomp1 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=llama /app /opt/llama
ENV PATH="/opt/llama:${PATH}" LD_LIBRARY_PATH="/opt/llama" LLAMA_SERVER="/opt/llama/llama-server"

WORKDIR /app
# PyTorch « CPU » (beaucoup plus léger que la version GPU) pour la lecture des copies (Qwen3-VL)
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir "transformers>=5,<6" accelerate
COPY worker/requirements.txt worker/requirements.txt
RUN pip install --no-cache-dir -r worker/requirements.txt

# Code : le worker réutilise la base de données et les schémas de l'API
COPY backend/studoo backend/studoo
COPY worker/studoo_worker worker/studoo_worker
ENV PYTHONPATH="/app/backend:/app/worker" PYTHONUNBUFFERED=1 \
    MODELS_DIR=/tmp/models HF_HOME=/tmp/models/hf

# Les modèles (≈ 3 à 7 Go selon la tâche) sont téléchargés au premier besoin (sur Azure : disque temporaire de 8 Go, effacé à l'arrêt).
# « once » : vide la file de réveil, traite toutes les tâches en attente puis s'arrête (exécution Azure).
CMD ["python", "-m", "studoo_worker", "once"]
