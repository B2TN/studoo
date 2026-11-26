"""Connecteur Pronote non officiel (bibliothèque pronotepy, licence MIT).

Itération 4 — le « robot » : l'élève choisit son lycée (annuaire officiel de l'Éducation nationale) et tape
son identifiant et son mot de passe ; Studoo trouve seul l'adresse Pronote (https://<UAI>.index-education.net),
reconnaît l'ENT régional à la redirection de connexion, se connecte et récupère l'emploi du temps.
Le mot de passe ne vit QUE dans la mémoire de la requête (≤ 2 min) : il n'est jamais écrit (ni base, ni journal,
ni fichier) et disparaît à la fin de la requête, qu'elle réussisse, échoue, expire ou plante.

Anciennes façons de se connecter (encore acceptées par l'API pour les sources déjà enregistrées) :
- QR code généré dans Pronote (aucun mot de passe) ;
- identifiant + mot de passe Pronote (comptes sans ENT) ;
- identifiant + mot de passe de l'ENT régional (Monlycée.net, Mon Bureau Numérique…).

Dans les deux derniers cas, le mot de passe ne sert QU'UNE fois, en mémoire,
pour ouvrir la session ; il n'est ni stocké ni journalisé. Ce que l'on garde
(chiffré) : de préférence le lien iCal officiel du compte, sinon le jeton de
reconnexion fourni par Pronote après une connexion par QR code.
"""
import functools
import logging
import re
from datetime import date, timedelta
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException

# pronotepy écrit des informations détaillées en mode « debug » : on les coupe
# pour qu'aucun identifiant ne puisse se retrouver dans les journaux.
logging.getLogger("pronotepy").setLevel(logging.WARNING)

# ENT régionaux pris en charge : identifiant → (nom affiché, fonction pronotepy)
ENTS = {
    "ile_de_france": "Monlycée.net (Île-de-France)",
    "monbureaunumerique": "Mon Bureau Numérique (Grand Est)",
    "ent_hdf": "ENT Hauts-de-France",
    "ac_rennes": "Toutatice (Bretagne)",
    "eclat_bfc": "Éclat-BFC (Bourgogne-Franche-Comté)",
    "atrium_sud": "Atrium (Provence-Alpes-Côte d'Azur)",
    "ent_auvergnerhonealpe": "ENT Auvergne-Rhône-Alpes",
    "lyceeconnecte_aquitaine": "Lycée connecté (Nouvelle-Aquitaine)",
    "l_normandie": "L'Educ de Normandie",
    "occitanie_montpellier": "ENT Occitanie (Montpellier)",
    "occitanie_toulouse_edu": "ENT Occitanie (Toulouse)",
    "ent_elyco": "e-lyco (Pays de la Loire)",
    "ac_orleans_tours": "ENT Centre-Val de Loire (Orléans-Tours)",
    "ac_reims": "ENT Reims",
    "ac_poitiers": "ENT Poitiers",
    "bordeaux": "ENT Bordeaux",
    "ent77": "ENT Seine-et-Marne",
    "ent_essonne": "ENT Essonne",
    "ent_ecollege78": "e-collège Yvelines",
    "val_doise": "ENT Val-d'Oise",
    "val_de_marne": "ENT Val-de-Marne",
    "paris_classe_numerique": "Paris Classe Numérique",
    "cas_seinesaintdenis_edu": "ENT Seine-Saint-Denis",
    "ent_somme": "ENT Somme",
    "ent_var": "ENT Var",
    "ac_reunion": "ENT La Réunion",
}

WEEKS = 5


def _pronotepy():
    import pronotepy  # import tardif : bibliothèque lourde, utile seulement ici
    return pronotepy


UAI = re.compile(r"^\d{7}[A-Z]$")
EDUCONNECT = "educonnect.education.gouv.fr"


def school_url(uai: str) -> str:
    """Adresse Pronote d'un établissement à partir de son code officiel (UAI), sans rien demander à l'élève."""
    uai = uai.strip().upper()
    if not UAI.match(uai):
        raise HTTPException(422, detail={"code": "bad_school", "message": "Établissement inconnu : choisis-le dans la liste."})
    return f"https://{uai.lower()}.index-education.net/pronote/"


@functools.cache
def _ent_hosts() -> dict[str, list[str]]:
    """Adresse de connexion → connecteurs ENT de pronotepy (lue dans la bibliothèque elle-même)."""
    import pronotepy.ent as ent  # sous-module à importer explicitement
    hosts: dict[str, list[str]] = {}
    for name in dir(ent):
        fn = getattr(ent, name)
        if not isinstance(fn, functools.partial):
            continue
        for arg in [*fn.args, *fn.keywords.values()]:
            if isinstance(arg, str) and arg.startswith("http"):
                host = urlparse(arg).hostname
                if host:
                    hosts.setdefault(host, []).append(name)
    for names in hosts.values():  # connecteurs « élève » d'abord, variantes EduConnect ensuite
        names.sort(key=lambda n: ("educonnect" in n or n.endswith("_edu"), n))
    return hosts


def detect_ent(base_url: str) -> list[str]:
    """[] si la page Pronote demande directement identifiant/mot de passe ; sinon les connecteurs ENT à essayer."""
    try:
        res = httpx.get(base_url, follow_redirects=False, timeout=15, headers={"User-Agent": "Mozilla/5.0 (Studoo)"})
    except httpx.HTTPError:
        raise _unavailable() from None
    if res.status_code >= 500:
        raise _unavailable()
    if res.status_code == 404:
        raise HTTPException(422, detail={"code": "no_pronote", "message": "Ce lycée n'a pas de Pronote hébergé chez Index Éducation : "
                                                                           "utilise le dernier recours (.ics)."})
    if res.status_code not in (301, 302, 303, 307, 308):
        return []
    host = urlparse(res.headers.get("location", "")).hostname or ""
    if host.endswith("index-education.net"):
        return []
    names = _ent_hosts().get(host)
    if not names:
        label = "EduConnect" if host == EDUCONNECT else host or "un service inconnu"
        raise HTTPException(422, detail={
            "code": "ent_unsupported",
            "message": f"Ton lycée se connecte par {label}, que le robot de Studoo ne sait pas encore ouvrir. "
                       "Utilise le dernier recours : dans Pronote, Emploi du temps → Exporter → iCal, puis colle le lien.",
        })
    return names[:2]  # au plus deux essais : on ne bloque pas le compte avec des tentatives répétées


def _unavailable() -> HTTPException:
    return HTTPException(503, detail={"code": "unavailable",
                                      "message": "Pronote ou ton ENT ne répond pas (maintenance ?). Réessaie un peu plus tard."})


def _explain(exc: Exception) -> HTTPException:
    name = type(exc).__name__
    text = str(exc).lower()
    if "mfa" in name.lower() or "2fa" in text or "double auth" in text or "doubleauth" in text:
        return HTTPException(401, detail={
            "code": "two_factor",
            "message": "Ton compte demande une double authentification (code ou appareil de confiance) : le robot ne peut pas "
                       "la faire à ta place. Utilise le dernier recours : dans Pronote, Emploi du temps → Exporter → iCal.",
        })
    if name in {"ConnectionError", "Timeout", "ReadTimeout", "ConnectTimeout", "SSLError"} or "maintenance" in text:
        return _unavailable()
    if name in {"CryptoError", "ENTLoginError"} or "credentials" in text:
        return HTTPException(401, detail={"code": "bad_credentials", "message": "Identifiants, code PIN ou QR code incorrects (ou expirés)."})
    if name == "QRCodeDecryptError":
        return HTTPException(401, detail={"code": "bad_qr", "message": "QR code ou code PIN incorrect. Génère un nouveau QR code dans Pronote."})
    return HTTPException(502, detail={
        "code": "pronote_error",
        "message": "Pronote n'a pas répondu comme prévu. Utilise plutôt la méthode « lien iCal » (aucun mot de passe).",
    })


def _events(client) -> list[dict]:
    start = date.today() - timedelta(days=7)
    end = date.today() + timedelta(weeks=WEEKS)
    events = []
    for lesson in client.lessons(start, end):
        subject = lesson.subject.name if lesson.subject else "Cours"
        events.append({
            "uid": f"pronote-{lesson.id}",
            "title": f"{subject} - {lesson.teacher_name}" if lesson.teacher_name else subject,
            "subject": pretty_subject(subject),
            "start": lesson.start.isoformat(),
            "end": lesson.end.isoformat(),
            "location": lesson.classroom or "",
            "description": lesson.status or "",
            "cancelled": bool(lesson.canceled),
        })
    events.sort(key=lambda e: e["start"])
    return events


def pretty_subject(name: str) -> str:
    from .ics import clean_subject
    return clean_subject(name)


def login(mode: str, *, url: str = "", username: str = "", password: str = "", ent: str = "",
          qr: dict | None = None, pin: str = "", uuid: str = "") -> tuple[list[dict], dict | None]:
    """Se connecte et renvoie (cours, ce qu'il faut garder) — jamais le mot de passe."""
    pronotepy = _pronotepy()
    try:
        if mode == "qr":
            client = pronotepy.Client.qrcode_login(qr, pin, uuid)
        elif mode == "password":
            client = pronotepy.Client(url, username=username, password=password)
        elif mode == "ent":
            import pronotepy.ent  # noqa: F401 - sous-module à importer explicitement
            ent_fn = getattr(pronotepy.ent, ent)
            client = pronotepy.Client(url, username=username, password=password, ent=ent_fn)
        elif mode == "token":
            client = pronotepy.Client.token_login(url, username, password, uuid)
        else:
            raise HTTPException(422, detail={"code": "invalid", "message": "Méthode inconnue."})
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - erreurs variées de la bibliothèque
        raise _explain(exc) from None  # « from None » : le détail (qui pourrait citer l'identifiant) n'est pas propagé

    if not client.logged_in:
        raise HTTPException(401, detail={"code": "bad_credentials", "message": "Connexion à Pronote refusée."})
    try:
        events = _events(client)
    except Exception as exc:  # noqa: BLE001
        raise _explain(exc) from None

    keep = None
    try:
        keep = {"kind": "ical", "url": client.export_ical()}
    except Exception:  # noqa: BLE001 - iCal désactivé sur cet établissement
        if mode in {"qr", "token"}:
            # Après un QR code, Pronote fournit un jeton de reconnexion (PAS le mot de passe).
            creds = client.export_credentials()
            keep = {"kind": "pronote-token", "url": creds["pronote_url"], "username": creds["username"],
                    "token": creds["password"], "uuid": creds["uuid"]}
    return events, keep


def robot_login(uai: str, username: str, password: str) -> tuple[list[dict], dict]:
    """Le robot : adresse Pronote (UAI) → ENT reconnu → connexion → cours + lien iCal durable si possible.

    Renvoie (cours, ce qu'il faut garder) : {"kind": "ical", "url"} (à jour pour toujours, sans mot de passe)
    ou {"kind": "snapshot"} (rien de secret : l'élève sera invité à se reconnecter toutes les 2 semaines).
    """
    url = school_url(uai) + "eleve.html"
    candidates = detect_ent(url)  # la page ÉLÈVE révèle l'ENT (la page d'accueil, pas toujours)
    last: HTTPException | None = None
    for ent in candidates or [""]:
        try:
            events, keep = login("ent" if ent else "password", url=url, username=username, password=password, ent=ent)
        except HTTPException as exc:
            last = exc
            if exc.status_code == 401 and exc.detail.get("code") == "bad_credentials":
                continue  # autre variante du même ENT (élève / EduConnect)
            raise
        return events, keep or {"kind": "snapshot"}
    raise last or _unavailable()


def subjects(events: list[dict]) -> list[str]:
    return sorted({e["subject"] for e in events})

