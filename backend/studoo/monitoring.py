"""Suivi des erreurs (Sentry), facultatif : actif seulement si SENTRY_DSN est défini.

Règle : RIEN de personnel ne part chez Sentry. Pas de corps de requête (il peut contenir un mot de passe envoyé
au robot d'emploi du temps), pas de variables locales (elles peuvent contenir du texte de cours ou des jetons),
pas de cookies, pas d'en-têtes, pas d'adresse IP, pas d'identité. Seulement : le type d'erreur, la pile d'appels
(noms de fichiers et de fonctions), l'adresse de la page sans paramètres, et la version déployée.
"""
import os
import re

SECRETISH = re.compile(r"(?i)(password|mot.?de.?passe|token|secret|key|cookie|authorization|sealed|refresh)")


def _scrub(event: dict, _hint=None) -> dict:
    request = event.get("request") or {}
    for field in ("data", "cookies", "headers", "env", "query_string"):
        request.pop(field, None)
    if "url" in request:
        request["url"] = re.sub(r"/[A-Za-z0-9_-]{20,}", "/:id", str(request["url"]).split("?")[0])
    event["request"] = request
    event.pop("user", None)
    event.pop("server_name", None)
    for crumb in (event.get("breadcrumbs") or {}).get("values", []):
        if SECRETISH.search(str(crumb.get("message", ""))):
            crumb["message"] = "[masqué]"
        crumb.pop("data", None)
    return event


def setup(dsn: str, *, environment: str = "production", component: str = "api") -> bool:
    if not dsn:
        return False
    import sentry_sdk
    sentry_sdk.init(
        dsn=dsn,
        environment=environment,
        release=(os.environ.get("VERCEL_GIT_COMMIT_SHA") or os.environ.get("STUDOO_RELEASE") or "")[:12] or None,
        send_default_pii=False,          # ni IP, ni cookies, ni identité
        max_request_body_size="never",   # jamais le contenu des requêtes (mots de passe des robots, cours…)
        include_local_variables=False,   # jamais les variables du programme au moment de l'erreur
        include_source_context=False,
        traces_sample_rate=0.0,          # pas de mesure de performance : seulement les erreurs
        before_send=_scrub,
        before_send_transaction=lambda e, h: None,
    )
    sentry_sdk.set_tag("component", component)
    return True
