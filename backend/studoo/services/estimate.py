"""Temps d'attente estimé des générations : une fourchette honnête, pas une fausse précision.

Une tâche = attente du serveur (réveil de la machine Azure + file) + travail.
- Le travail dépend de la « taille » de la demande (minutes de podcast/vidéo, pages lues, longueur des cours) :
  on l'exprime en secondes fixes + secondes par unité.
- Les fourchettes viennent des VRAIES durées des dernières générations du même type (tous élèves confondus,
  sans aucun contenu : seulement des dates et une taille). Tant qu'il y en a trop peu, on part des mesures
  faites sur Azure le 26/11/2026.
- Pendant le travail, l'estimation est corrigée avec la progression réelle ; si c'est plus long que prévu,
  on le dit (« late ») et on recalcule à partir de la vitesse observée.
"""
from datetime import datetime

# (secondes fixes, secondes par unité) pour le bas et le haut de la fourchette.
# Mesures du 26/11/2026 : vidéo de 2 min ≈ 18 s de travail ; podcast de 10 min ≈ 50 s à 2 min.
PRIORS = {
    "podcast": ((20, 3), (40, 10)),      # unité : minute de podcast demandée
    "video": ((10, 3), (30, 8)),         # unité : minute de vidéo
    "fiche": ((10, 0.5), (30, 2)),       # unité : 1 000 caractères de cours
    "exercices": ((15, 0.5), (45, 2)),   # unité : 1 000 caractères de cours
    "correction": ((15, 5), (40, 15)),   # unité : photo de copie
    "ocr": ((20, 30), (60, 120)),        # unité : page (lecteur open source sur le processeur du serveur)
    "timetable": ((15, 0), (90, 0)),     # robot de connexion à l'emploi du temps
}
WAKE = (25, 90)       # réveil de la machine Azure + téléchargement de l'image, en secondes
MIN_HISTORY = 3


def _seconds(a: datetime | None, b: datetime | None) -> float | None:
    if not a or not b:
        return None
    if a.tzinfo is None and b.tzinfo is not None:
        a = a.replace(tzinfo=b.tzinfo)
    if b.tzinfo is None and a.tzinfo is not None:
        b = b.replace(tzinfo=a.tzinfo)
    return (b - a).total_seconds()


def _quantile(values: list[float], q: float) -> float:
    values = sorted(values)
    i = min(len(values) - 1, max(0, round(q * (len(values) - 1))))
    return values[i]


def model(kind: str, history: list[dict]) -> dict:
    """Fourchettes (réveil, travail par unité) d'un type de tâche, à partir des dernières tâches terminées."""
    (fix_lo, per_lo), (fix_hi, per_hi) = PRIORS.get(kind, ((30, 0), (120, 0)))
    wake_lo, wake_hi = WAKE
    waits = [w for h in history if (w := _seconds(h["created_at"], h["started_at"])) is not None and 0 <= w < 1800]
    works = []
    for h in history:
        w = _seconds(h["started_at"], h["finished_at"])
        if w is not None and 0 < w < 4 * 3600:
            works.append(w / max(1, h.get("size") or 1))
    if len(waits) >= MIN_HISTORY:
        wake_lo, wake_hi = _quantile(waits, 0.2), max(_quantile(waits, 0.85), _quantile(waits, 0.2) + 20)
    measured = None
    if len(works) >= MIN_HISTORY:
        measured = (_quantile(works, 0.2), max(_quantile(works, 0.85), _quantile(works, 0.2) * 1.3))
    return {"wake": (wake_lo, wake_hi), "fixed": (fix_lo, fix_hi), "per": (per_lo, per_hi), "measured": measured}


def work_range(m: dict, size: int) -> tuple[float, float]:
    size = max(1, size or 1)
    if m["measured"]:  # durée réelle par unité, mesurée sur les dernières tâches
        return m["measured"][0] * size, m["measured"][1] * size
    return m["fixed"][0] + m["per"][0] * size, m["fixed"][1] + m["per"][1] * size


def estimate(job: dict, m: dict, now: datetime, ahead: int = 0, parallel: int = 3) -> dict | None:
    """Temps restant estimé {low, high} en secondes, `ahead` tâches devant, `late` si plus long que prévu."""
    status = job["status"]
    if status not in {"queued", "running"}:
        return None
    lo, hi = work_range(m, job.get("size") or 1)
    if status == "queued":
        waited = max(0.0, _seconds(job["created_at"], now) or 0)
        wake_lo, wake_hi = m["wake"]
        queue_extra = (ahead // max(1, parallel)) * (lo + hi) / 2  # les tâches devant passent par groupes
        low = max(5.0, wake_lo - waited) + lo + queue_extra
        high = max(20.0, wake_hi - waited) + hi + queue_extra
        return {"low": round(low), "high": round(max(high, low + 30)), "ahead": ahead, "late": waited > wake_hi + 120}
    elapsed = max(0.0, _seconds(job.get("started_at") or job["created_at"], now) or 0)
    progress = max(0, min(99, job.get("progress") or 0))
    low, high = lo - elapsed, hi - elapsed
    late = elapsed > hi
    if progress >= 10:  # vitesse observée : le reste prend environ autant que ce qui est fait, au prorata
        by_speed = elapsed * (100 - progress) / progress
        low = min(max(low, by_speed * 0.7), by_speed) if not late else by_speed * 0.8
        high = max(high, by_speed * 1.3)
    low, high = max(5.0, low), max(20.0, high)
    return {"low": round(low), "high": round(max(high, low + 20)), "ahead": 0, "late": late}
