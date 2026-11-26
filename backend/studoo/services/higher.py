"""Emplois du temps du supérieur : trouver l'établissement, détecter son logiciel, lire Celcat.

1. L'étudiant tape le nom de son université ou école : recherche dans l'annuaire officiel du ministère
   (data.enseignementsup-recherche.gouv.fr, « Principaux établissements », champ `url`) + quelques composantes
   connues (IUT…).
2. Studoo essaie en parallèle les adresses habituelles des logiciels d'emploi du temps sur le domaine de
   l'établissement (ade., edt., planning., celcat., hp.…) et reconnaît le logiciel à sa réponse :
   - ADE Campus (`/direct/`, interface « Ade Web Direct Planning ») → robot ADE (services/ade.py) ;
   - Celcat Calendar (`/calendar/`, « CELCAT Calendar ») → recherche du groupe + cours (ce module) ;
   - HyperPlanning (Index Éducation) et Aurion → robots EXPÉRIMENTAUX (services/hyperplanning.py, aurion.py),
     construits sans compte de test ; le dernier recours guidé reste proposé.
3. Celcat : les groupes sont souvent consultables sans connexion (recherche + cours en JSON). Sinon, le robot
   se connecte par la page de l'université (même code que pour ADE) puis lit les cours de l'étudiant.
"""
import asyncio
import html
import re
from datetime import date, timedelta
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException

from .ics import clean_subject

UA = "Mozilla/5.0 (Studoo; robot d'emploi du temps)"
ANNUAIRE_SUP = ("https://data.enseignementsup-recherche.gouv.fr/api/explore/v2.1/catalog/datasets/"
                "fr-esr-principaux-etablissements-enseignement-superieur/records")

# Composantes et cas particuliers (adresses qui ne suivent pas le domaine de l'université).
EXTRA = [
    {"id": "iut-paris-rives-de-seine", "name": "IUT de Paris – Rives de Seine (Université Paris Cité)", "city": "Paris",
     "domain": "u-pariscite.fr", "known": [{"software": "ade", "base": "https://adeconsult.app.u-pariscite.fr", "login": True}]},
]
KNOWN = {  # domaine → logiciel déjà repéré (évite des essais inutiles ; vérifié le 26/11/2026)
    "u-pariscite.fr": [{"software": "ade", "base": "https://adeconsult.app.u-pariscite.fr", "login": True}],
    "univ-amu.fr": [{"software": "ade", "base": "https://agenda-web-consult.univ-amu.fr", "login": True}],
    "univ-lyon1.fr": [{"software": "ade", "base": "https://edt.univ-lyon1.fr", "login": True}],
    "univ-rennes.fr": [{"software": "ade", "base": "https://planning.univ-rennes.fr", "login": True}],
    "univ-tours.fr": [{"software": "ade", "base": "https://ade.univ-tours.fr", "login": True}],
    "u-bordeaux.fr": [{"software": "celcat", "base": "https://celcat.u-bordeaux.fr/Calendar", "login": False}],
    "univ-tlse3.fr": [{"software": "celcat", "base": "https://edt.univ-tlse3.fr/calendar", "login": True}],
    # ADE avec ses propres identifiants (pas la page de l'université) : reconnus, robot pas encore disponible.
    "univ-grenoble-alpes.fr": [{"software": "ade", "base": "https://ade-uga-ro-vs.grenet.fr", "login": True, "native": True}],
    "umontpellier.fr": [{"software": "ade", "base": "https://proseconsult.umontpellier.fr", "login": True, "native": True}],
}
PREFIXES = ["ade", "adeconsult", "ade-consult", "adeweb", "ade-web", "ade6", "adeconsult.app", "ade.app", "edt", "edt-ade",
            "planning", "plannings", "emploidutemps", "emplois-du-temps", "agenda-web-consult", "ade-web-consult",
            "celcat", "edt-celcat", "calendar", "hp", "hyperplanning", "edt-hp", "aurion", "webaurion",
            "proseconsult", "edtweb", "adecons"]
SOFTWARE_NAMES = {"ade": "ADE Campus", "celcat": "Celcat Calendar", "hyperplanning": "HyperPlanning", "aurion": "Aurion"}


def _domain(url: str) -> str:
    host = (urlparse(url if "//" in url else f"https://{url}").hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


async def search(q: str) -> list[dict]:
    """Universités et écoles dont le nom (ou la ville, le sigle) contient les mots tapés."""
    words = [w for w in "".join(c if c.isalnum() or c in " -'" else " " for c in q).split() if len(w) > 1][:5]
    if not words:
        return []
    where = " and ".join(f'(search(uo_lib, "{w}") or search(nom_court, "{w}") or search(sigle, "{w}") or search(com_nom, "{w}"))'
                         for w in words)
    params = {"select": "uai,uo_lib,com_nom,url,type_d_etablissement", "where": where, "limit": 12}
    async with httpx.AsyncClient(timeout=10, headers={"User-Agent": UA}) as client:
        res = await client.get(ANNUAIRE_SUP, params=params)
        res.raise_for_status()
    out = [{"id": r["uai"], "name": r["uo_lib"], "city": r.get("com_nom") or "", "domain": _domain(r.get("url") or "")}
           for r in res.json().get("results", []) if r.get("url")]
    low = q.lower()
    extra = [{k: e[k] for k in ("id", "name", "city", "domain")} for e in EXTRA
             if all(w.lower() in (e["name"] + " " + e["city"]).lower() for w in words) or low in e["name"].lower()]
    return extra + out


def _is_ade(res: httpx.Response) -> bool:
    loc = res.headers.get("location", "").lower()
    return (res.status_code == 200 and ("ade web direct planning" in res.text.lower() or "gwtdirectplanning" in res.text)) or \
        (res.status_code in (301, 302, 303, 307) and any(w in loc for w in ("cas", "idp", "sso", "login", "shibboleth", "wayf")))


def _is_celcat(res: httpx.Response) -> bool:
    loc = res.headers.get("location", "").lower()
    return (res.status_code == 200 and "celcat" in res.text.lower()) or (res.status_code in (301, 302) and "/calendar" in loc and "login" in loc)


async def _probe(client: httpx.AsyncClient, host: str) -> list[dict]:
    found = []
    checks = [("ade", f"https://{host}/direct/", _is_ade)]
    for path in ("/calendar", "/Calendar", "/calendar2"):
        checks.append(("celcat", f"https://{host}{path}/", _is_celcat))
    sso = lambda r: r.status_code in (301, 302, 303, 307) and any(  # noqa: E731 - renvoi vers la page de l'université
        w in r.headers.get("location", "").lower() for w in ("cas", "idp", "sso", "shibboleth", "wayf"))
    checks += [("hyperplanning", f"https://{host}/hp/", lambda r: (r.status_code < 400 and "hyperplanning" in r.text.lower())
                or ("hp" in host.split(".")[0] and sso(r))),
               ("aurion", f"https://{host}/faces/Login.xhtml", lambda r: (r.status_code < 400 and "aurion" in r.text.lower())
                or ("aurion" in host.split(".")[0] and sso(r))),
               ("aurion", f"https://{host}/webAurion/faces/Login.xhtml", lambda r: (r.status_code < 400 and "aurion" in r.text.lower())
                or ("aurion" in host.split(".")[0] and sso(r)))]
    for software, url, test in checks:
        try:
            res = await client.get(url)
        except httpx.HTTPError:
            if software == "ade":
                return found  # l'adresse n'existe pas : inutile d'essayer les autres chemins
            continue
        if test(res):
            base = url.rsplit("/", 2)[0] if software == "ade" else url.rstrip("/")
            if software == "hyperplanning":
                base = f"https://{host}"
            if software == "aurion":  # Aurion peut être installé à la racine ou sous /webAurion
                base = url.split("/faces/")[0]
            login = software == "ade" or res.status_code in (301, 302, 303, 307)
            item = {"software": software, "base": base, "login": login}
            if software == "ade" and res.status_code == 200:
                item["native"] = True  # ADE ouvert sans passer par l'université : identifiants propres à ADE
            found.append(item)
            break
    return found


async def detect(domain: str) -> list[dict]:
    """Logiciels d'emploi du temps trouvés pour ce domaine (ADE, Celcat, HyperPlanning, Aurion)."""
    domain = _domain(domain)
    if not re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", domain or ""):
        raise HTTPException(422, detail={"code": "invalid", "message": "Établissement inconnu."})
    if domain in KNOWN:
        return KNOWN[domain]
    sem = asyncio.Semaphore(12)
    async with httpx.AsyncClient(timeout=6, follow_redirects=False, headers={"User-Agent": UA}) as client:
        async def one(prefix):
            async with sem:
                return await _probe(client, f"{prefix}.{domain}")
        results = await asyncio.gather(*(one(p) for p in PREFIXES))
    seen, out = set(), []
    for item in [x for r in results for x in r]:
        key = (item["software"], item["base"])
        if key not in seen:
            seen.add(key)
            out.append(item)
    order = {"ade": 0, "celcat": 1, "hyperplanning": 2, "aurion": 3}
    return sorted(out, key=lambda x: order[x["software"]])


# ---------- Celcat Calendar ----------
def celcat_groups(client: httpx.Client, base: str, term: str) -> list[dict]:
    res = client.get(f"{base}/Home/ReadResourceListItems", params={
        "myResources": "false", "searchTerm": term, "pageSize": 30, "pageNumber": 1, "resType": 103})
    if res.status_code != 200 or not res.headers.get("content-type", "").startswith("application/json"):
        raise HTTPException(401, detail={"code": "login_required", "message": "Celcat demande une connexion pour chercher un groupe."})
    return [{"id": r["id"], "name": r["text"], "dept": r.get("dept") or ""} for r in res.json().get("results", [])]


def _lines(description: str) -> list[str]:
    text = re.sub(r"<br\s*/?>", "\n", description or "", flags=re.I)
    text = html.unescape(re.sub(r"<[^>]+>", "", text))
    return [line.strip() for line in text.splitlines() if line.strip()]


def celcat_events(client: httpx.Client, base: str, fid: str, res_type: int = 103, weeks: int = 5) -> list[dict]:
    start = date.today() - timedelta(days=7)
    end = date.today() + timedelta(weeks=weeks)
    res = client.post(f"{base}/Home/GetCalendarData", data={
        "start": start.isoformat(), "end": end.isoformat(), "resType": str(res_type), "calView": "month",
        "federationIds[]": fid, "colourScheme": "3"})
    if res.status_code != 200:
        raise HTTPException(502, detail={"code": "celcat_error", "message": "Celcat n'a pas répondu comme prévu."})
    events = []
    for e in res.json():
        if e.get("allDay") or not e.get("end"):
            continue  # vacances, jours fériés
        lines = _lines(e.get("description", ""))
        category = e.get("eventCategory") or ""
        module = (e.get("modules") or [None])[0] or next((x for x in lines if x != category and not x.isdigit()), category or "Cours")
        room = ", ".join(e.get("sites") or []) or next((x for x in lines[2:] if re.search(r"salle|amphi|bât|bat\.|room", x, re.I)), "")
        events.append({"uid": f"celcat-{e.get('id')}", "title": f"{category} - {module}" if category else module,
                       "subject": clean_subject(module), "start": e["start"], "end": e["end"], "location": room,
                       "description": " · ".join(lines)[:300], "cancelled": "annul" in (category + " ".join(lines)).lower()})
    events.sort(key=lambda x: x["start"])
    return events
