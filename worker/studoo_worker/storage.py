"""Place sur le disque : sur Azure Container Apps, une machine n'a que 8 Go de disque temporaire.

Le modèle d'écriture (≈ 2,5 Go) et celui de lecture des copies (≈ 4,5 Go) ne tiennent pas toujours ensemble :
avant d'en télécharger un, on efface les autres gros fichiers de modèles si la place manque.
"""
import logging
import shutil
from pathlib import Path

from . import settings

log = logging.getLogger("studoo.storage")
BIG = 300 * 1024 * 1024  # au-delà, c'est un « gros » modèle (les voix et polices restent)


def _size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


def make_room(needed_gb: float, keep: str) -> None:
    """Libère de la place pour ``needed_gb`` Go en effaçant les gros modèles autres que ``keep``."""
    root = settings.MODELS_DIR
    root.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(root).free >= needed_gb * 1e9:
        return
    for entry in root.iterdir():
        if entry.name == keep or _size(entry) < BIG:
            continue
        log.info("Place disque : effacement de %s", entry.name)
        shutil.rmtree(entry, ignore_errors=True) if entry.is_dir() else entry.unlink(missing_ok=True)
