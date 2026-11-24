"""Lancement du worker.

    python -m studoo_worker loop   # tourne en continu (service toujours allumé)
    python -m studoo_worker once   # traite les tâches en attente puis s'arrête (tâche planifiée)
"""
import logging
import sys
import time
import traceback

from . import notify, pipelines, queue

log = logging.getLogger("studoo.worker")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


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

    try:
        file_id, name = pipelines.run(job, payload, report)
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
    queue.finish(job["id"], file_id, name)
    notify.job_finished(job, payload.get("email", ""), ok=True, file_id=file_id)
    log.info("Tâche %s terminée", job["id"])
    return True


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "loop"
    queue.purge()
    if mode == "once":
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
