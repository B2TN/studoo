"""Protection contre la SSRF (audit de sécurité, itération 7).

Les robots d'emploi du temps ouvrent des adresses venues de l'élève ou d'établissements tiers, et suivent leurs
redirections. Chaque requête — redirections comprises — doit viser une adresse publique en HTTP(S) : jamais le
serveur lui-même, un réseau interne, l'adresse des métadonnées du cloud (169.254.169.254)…
Limite connue : entre la vérification DNS et la connexion, un nom peut changer d'adresse (« DNS rebinding ») ;
le risque est faible ici (aucune réponse brute n'est renvoyée à l'élève) et accepté.
"""
import httpx
from fastapi import HTTPException

from .ics import _check_host


def check_host(host: str) -> None:
    """Lève une erreur claire si l'hôte n'est pas une adresse publique (remplaçable dans les tests)."""
    _check_host(host)


def _check(request: httpx.Request) -> None:
    """Refus = erreur réseau ordinaire (httpx), traitée partout comme « service injoignable » : la détection passe
    à l'adresse suivante, les robots affichent leur message habituel, et la requête n'est jamais envoyée."""
    if request.url.scheme not in ("https", "http"):
        raise httpx.UnsupportedProtocol("Adresse non autorisée.", request=request)
    try:
        check_host(request.url.host or "")
    except HTTPException:
        raise httpx.ConnectError("Adresse non autorisée ou introuvable.", request=request) from None


def hooks() -> dict:
    """Pour httpx.Client(event_hooks=…) : vérifie chaque requête, y compris chaque redirection."""
    return {"request": [_check]}


def async_hooks() -> dict:
    async def check(request: httpx.Request) -> None:
        _check(request)
    return {"request": [check]}


def get(url: str, **kw) -> httpx.Response:
    """httpx.get protégé (mêmes vérifications)."""
    with httpx.Client(event_hooks=hooks(), **kw) as client:
        return client.get(url)
