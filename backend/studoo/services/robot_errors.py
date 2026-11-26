"""Erreurs communes aux robots d'emploi du temps : un code et un message clair pour chaque cas.

Le navigateur s'en sert pour proposer, à chaque échec, le dernier recours (.ics) et le signalement
de l'établissement (itération 6, C4). Aucun message ne contient d'identifiant, de mot de passe ni de cours.
"""
import httpx
from fastapi import HTTPException


def err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def bad_credentials(service: str) -> HTTPException:
    return err(401, "bad_credentials", f"Identifiant ou mot de passe refusé par {service}. Vérifie-les et réessaie.")


def two_factor(service: str) -> HTTPException:
    return err(401, "two_factor", f"{service} demande une double authentification (code reçu par SMS, application…) : "
                                  "le robot ne peut pas la faire à ta place. Utilise le dernier recours (.ics).")


def page_changed(service: str) -> HTTPException:
    return err(502, "page_changed", f"La page de {service} ne ressemble pas à ce que le robot connaît (elle a peut-être changé). "
                                    "Utilise le dernier recours (.ics) et signale-nous ton établissement.")


def timeout(service: str) -> HTTPException:
    return err(504, "timeout", f"{service} met trop de temps à répondre. Réessaie dans quelques minutes.")


def blocked(service: str) -> HTTPException:
    return err(403, "blocked", f"{service} refuse les connexions venant du serveur de Studoo (adresse bloquée ou protection anti-robot). "
                               "Utilise le dernier recours (.ics).")


def unavailable(service: str) -> HTTPException:
    return err(503, "unavailable", f"{service} ne répond pas (maintenance ?). Réessaie plus tard.")


def from_http(exc: Exception, service: str) -> HTTPException:
    """Erreur réseau httpx → message clair."""
    if isinstance(exc, httpx.TimeoutException):
        return timeout(service)
    return unavailable(service)


BLOCK_MARKERS = ("access denied", "accès refusé", "acces refuse", "cf-chl", "captcha", "request blocked", "you have been blocked")


def is_blocked(res: httpx.Response) -> bool:
    """Le service a bloqué l'adresse du serveur (pare-feu, anti-robot) plutôt que refusé les identifiants."""
    if res.status_code in (403, 429):
        return True
    return res.status_code >= 400 and any(m in res.text[:5000].lower() for m in BLOCK_MARKERS)
