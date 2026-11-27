"""Lancement du worker.

    python -m studoo_worker loop   # tourne en continu (service toujours allumé)
    python -m studoo_worker once   # traite les tâches en attente puis s'arrête (exécution Azure)
"""
import logging
import sys
import threading
import time
import traceback

from . import notify, pipelines, queue, wakeups

log = logging.getLogger("studoo.worker")
KEEP_ALIVE_SECONDS = 300
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
# httpx écrit chaque adresse appelée, clés d'accès comprises (file Azure, Google) : jamais dans les journaux.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


def _keep_alive(job_id: str, stop: threading.Event) -> None:
    """Toutes les 5 min, tant que la tâche tourne (un seul appel au modèle peut durer plus que le verrou)."""
    while not stop.wait(KEEP_ALIVE_SECONDS):
        try:
            queue.keep_alive(job_id)
        except Exception:  # noqa: BLE001 - coupure réseau passagère : on réessaiera au tour suivant
            log.warning("Verrou de la tâche %s non prolongé", job_id)


def process_one() -> bool:
    claimed = queue.claim()
    if not claimed:
        return False
    job, payload = claimed
    log.info("Tâche %s (%s), essai %s", job["id"], job["kind"], job["attempts"])  # jamais le contenu ni le jeton

    def report(percent, step):
        if queue.is_cancelled(job["id"]):
            raise pipelines.Cancelled()
        queue.progress(job["id"], percent, step)

    stop = threading.Event()
    threading.Thread(target=_keep_alive, args=(job["id"], stop), daemon=True).start()
    try:
        file_id, name, note = pipelines.run(job, payload, report)
    except pipelines.Cancelled:
        log.info("Tâche %s annulée par l'élève", job["id"])
        return True
    except Exception as exc:  # noqa: BLE001 - une tâche ratée ne doit jamais arrêter le worker
        log.error("Tâche %s en échec : %s", job["id"], type(exc).__name__)
        log.debug(traceback.format_exc())
        final = job["attempts"] >= queue.settings.MAX_ATTEMPTS
        queue.fail(job["id"], str(exc) or type(exc).__name__, final=final, attempts=job["attempts"])
        if final:
            notify.job_finished(job, payload.get("email", ""), ok=False)
        return True
    finally:
        stop.set()
    queue.finish(job["id"], file_id, name, note)
    notify.job_finished(job, payload.get("email", ""), ok=True, file_id=file_id)
    log.info("Tâche %s terminée", job["id"])
    return True


def main() -> None:
    from studoo import monitoring  # suivi des erreurs facultatif (SENTRY_DSN), sans aucune donnée personnelle
    from . import settings
    monitoring.setup(settings.SENTRY_DSN, component="worker")
    mode = sys.argv[1] if len(sys.argv) > 1 else "loop"
    queue.purge()
    if mode == "once":
        # Exécution Azure : on vide la file de réveil, on traite tout, puis on revide la file et on
        # refait un tour (une tâche arrivée pendant le travail ne doit pas attendre).
        for _ in range(2):
            wakeups.drain()
            while process_one():
                pass
        return
    idle = 0
    while True:
        if process_one():
            idle = 0
            continue
        idle += 1
        if idle % 60 == 0:
            queue.purge()
        time.sleep(5)


if __name__ == "__main__":
    main()
