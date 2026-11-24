"""Messages de réveil (file Azure Storage « studoo-jobs »).

L'API dépose un petit message vide de contenu (« studoo ») à chaque nouvelle tâche ; Azure Container Apps
voit la file non vide et démarre une exécution du worker. Le worker vide la file en arrivant (sinon Azure
relancerait sans fin), puis lit les vraies tâches dans la base de données.

WORKER_QUEUE_URL = https://<compte>.queue.core.windows.net/studoo-jobs?<jeton SAS « p » (lire + effacer)>
"""
import logging
import re
from urllib.parse import quote, urlsplit

import httpx

from . import settings

log = logging.getLogger("studoo.wakeups")


def _endpoint(url: str, suffix: str = "") -> tuple[str, str]:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path.rstrip('/')}/messages{suffix}", parts.query


def drain(url: str | None = None, rounds: int = 20) -> int:
    """Efface les messages de réveil en attente ; renvoie leur nombre. Sans file configurée : 0."""
    url = url if url is not None else settings.WORKER_QUEUE_URL
    if not url:
        return 0
    base, sas = _endpoint(url)
    removed = 0
    try:
        with httpx.Client(timeout=15) as client:
            for _ in range(rounds):
                res = client.get(f"{base}?{sas}&numofmessages=32&visibilitytimeout=30")
                res.raise_for_status()
                found = re.findall(r"<MessageId>(.*?)</MessageId>.*?<PopReceipt>(.*?)</PopReceipt>", res.text, re.S)
                if not found:
                    break
                for message_id, receipt in found:
                    client.delete(f"{base}/{message_id}?{sas}&popreceipt={quote(receipt, safe='')}").raise_for_status()
                    removed += 1
    except httpx.HTTPError as exc:  # pas bloquant : les tâches sont de toute façon lues dans la base
        log.warning("File de réveil inaccessible : %s", type(exc).__name__)
    return removed
