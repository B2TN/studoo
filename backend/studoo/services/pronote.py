"""Connecteur Pronote non officiel (bibliothèque pronotepy, licence MIT).

Trois façons de se connecter :
- QR code généré dans Pronote (aucun mot de passe) ;
- identifiant + mot de passe Pronote (comptes sans ENT) ;
- identifiant + mot de passe de l'ENT régional (Monlycée.net, Mon Bureau Numérique…).

Dans les deux derniers cas, le mot de passe ne sert QU'UNE fois, en mémoire,
pour ouvrir la session ; il n'est ni stocké ni journalisé. Ce que l'on garde
(chiffré) : de préférence le lien iCal officiel du compte, sinon le jeton de
reconnexion fourni par Pronote après une connexion par QR code.
"""
import logging
from datetime import date, timedelta

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


def _explain(exc: Exception) -> HTTPException:
    name = type(exc).__name__
    if name in {"CryptoError", "ENTLoginError"} or "credentials" in str(exc).lower():
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


def subjects(events: list[dict]) -> list[str]:
    return sorted({e["subject"] for e in events})

