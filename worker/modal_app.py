"""Serveur de tâches Studoo sur Modal (podcasts, vidéos, fiches, lectures de copies).

Déploiement (depuis la racine du dépôt) :  modal deploy worker/modal_app.py

Trois fonctions :
- ``process`` : la grosse machine (8 vCPU / 8 Go) qui fait le travail, puis s'éteint ;
- ``kick``    : petite adresse web appelée par l'API dès qu'une tâche est créée → démarrage immédiat ;
- ``watch``   : vérification toutes les 10 min (relances, tâches abandonnées, appel ``kick`` manqué).
Les deux petites fonctions ne démarrent la grosse machine QUE s'il y a du travail : rien n'est payé au repos.
"""
import hashlib
import hmac
import os
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent.parent
REGION = "eu"  # données traitées dans l'Espace économique européen (RGPD)

app = modal.App("studoo-worker")
secret = modal.Secret.from_name("studoo-worker")  # contenu de .env.worker
models = modal.Volume.from_name("studoo-models", create_if_missing=True)  # modèles gardés entre deux tâches

worker_image = (
    modal.Image.from_dockerfile(str(ROOT / "worker" / "Dockerfile"), context_dir=str(ROOT))
    .env({"MODELS_DIR": "/models", "HF_HOME": "/models/hf", "THREADS": "8"})
)
light_image = modal.Image.debian_slim(python_version="3.12").pip_install(
    "fastapi[standard]==0.165.0", "psycopg[binary]==3.3.9")


def kick_token(job_secret: str) -> str:
    """Même calcul que ``studoo.jobcrypto.kick_token`` côté API : pas de clé de plus à recopier."""
    return hmac.new(job_secret.encode(), b"studoo-kick", hashlib.sha256).hexdigest()


def _work_waiting() -> bool:
    import psycopg
    url = os.environ["DATABASE_URL"].replace("postgresql+psycopg://", "postgresql://", 1)
    with psycopg.connect(url, connect_timeout=10) as conn:
        (count,) = conn.execute(
            "select count(*) from jobs where status = 'queued' "
            "or (status = 'running' and locked_until < now())").fetchone()
    return count > 0


@app.function(image=worker_image, secrets=[secret], volumes={"/models": models},
              cpu=4.0, memory=8192, timeout=6 * 3600, max_containers=2, region=REGION)
def process() -> None:
    """Traite toutes les tâches en attente, puis s'arrête."""
    import sys

    from studoo_worker.__main__ import main
    sys.argv = ["studoo_worker", "once"]
    try:
        main()
    finally:
        models.commit()  # garde les modèles téléchargés pour la prochaine fois


@app.function(image=light_image, secrets=[secret], schedule=modal.Cron("*/10 * * * *"),
              cpu=0.25, memory=256, region=REGION)
def watch() -> None:
    if _work_waiting():
        process.spawn()


@app.function(image=light_image, secrets=[secret], cpu=0.25, memory=256, region=REGION)
@modal.fastapi_endpoint(method="POST")
def kick(body: dict) -> dict:
    from fastapi import HTTPException
    expected = kick_token(os.environ["JOB_SECRET"])
    if not hmac.compare_digest(str(body.get("token", "")), expected):
        raise HTTPException(status_code=401, detail="unauthorized")
    started = _work_waiting()
    if started:
        process.spawn()
    return {"ok": True, "started": started}
