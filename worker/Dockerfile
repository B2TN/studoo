# Serveur de tâches Studoo (podcasts, vidéos, lecture de copies) — tout tourne sur processeur.
# Construit depuis la racine du dépôt :  docker build -f worker/Dockerfile .

# 1) llama.cpp (modèle de langage), compilé ici sur la même base que l'image finale.
#    (Les images officielles ghcr.io/ggml-org/llama.cpp sont faites pour Ubuntu 26.04 / glibc 2.43 :
#     leur programme ne démarre pas sur Debian 12.)
FROM python:3.12-slim AS llama
ARG LLAMA_TAG=b12679
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${LLAMA_TAG} https://github.com/ggml-org/llama.cpp /src
# Une version du calcul par famille de processeur (choisie au démarrage) : Azure ne garantit pas le modèle de CPU.
RUN cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON \
        -DGGML_NATIVE=OFF -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON \
        -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
    && cmake --build /build --config Release -j "$(nproc)" \
    && /build/bin/llama-server --version

# 2) Image du worker
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgomp1 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=llama /build/bin /opt/llama
ENV PATH="/opt/llama:${PATH}" LD_LIBRARY_PATH="/opt/llama" LLAMA_SERVER="/opt/llama/llama-server"
# Vérification à la construction : le programme démarre bien dans cette image.
RUN llama-server --version

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
