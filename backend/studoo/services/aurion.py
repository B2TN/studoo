"""Robot Aurion (Sigma Informatique, « webAurion ») — EXPÉRIMENTAL.

⚠️ Construit sans compte de test, d'après le fonctionnement public de webAurion (application JSF/PrimeFaces)
et deux projets open source lus pour comprendre les échanges (aucun code recopié) : ISENpy (MIT,
github.com/CorentinMre/ISENpy) et Python-Planning-Aurion (Apache 2.0, github.com/Balth-D/Python-Planning-Aurion).
Testé uniquement sur des pages d'exemple (backend/tests/fixtures/aurion). Il peut échouer sur un vrai
établissement : l'interface le dit, et propose le dernier recours (.ics) + le signalement.

Parcours :
1. Connexion : formulaire d'Aurion (`/faces/Login.xhtml`, champs username/password) ou page de l'université
   (CAS/Shibboleth, même code que pour ADE).
2. Menu principal (`MainMenuPage.xhtml`) → entrée « Planning » (paramètres `form:sidebar_menuid` lus dans la page).
3. `Planning.xhtml` : demande « ajax » PrimeFaces du calendrier entre deux dates (millisecondes) ; la réponse est
   un XML dont la partie `<update id="form:…">` contient `{"events": [...]}`.
Aurion ne fournit pas de lien iCal : Studoo garde une copie des cours (rappel de reconnexion toutes les 2 semaines).
"""
import html
import json
import re
import time
from datetime import date, datetime, timedelta
from urllib.parse import urljoin, urlparse

import httpx

from . import ade, robot_errors
from .ics import clean_subject

SERVICE = "Aurion"
TIME_RE = re.compile(r"^\d{1,2}[:h]\d{2}(\s*(à|-|–)\s*\d{1,2}[:h]\d{2})?$")
ROOM_RE = re.compile(r"(?i)^(salle|amphi|amphithéâtre|bât|bat|bâtiment|labo|room|[A-Z]{0,3}\s?-?\d{2,4}[A-Z]?)\b")
KINDS = {"CM", "TD", "TP", "DS", "EXAMEN", "EXAM", "PROJET", "COURS", "CONFÉRENCE", "CONFERENCE", "TUTORAT", "SOUTENANCE"}


def inputs(page: str) -> dict:
    """Tous les champs <input> d'une page (dont javax.faces.ViewState), comme le navigateur les enverrait."""
    out = {}
    for m in re.finditer(r"<input\b[^>]*>", page, re.I):
        tag = m.group(0)
        name = re.search(r'\bname="([^"]*)"', tag)
        if not name:
            continue
        value = re.search(r'\bvalue="([^"]*)"', tag)
        out[html.unescape(name.group(1))] = html.unescape(value.group(1)) if value else ""
    return out


def _is_login_page(res: httpx.Response) -> bool:
    return "login.xhtml" in res.url.path.lower() or bool(re.search(r'type="password"', res.text, re.I))


def login(base: str, username: str, password: str) -> tuple[httpx.Client, httpx.Response]:
    """Connexion à Aurion ; renvoie (client connecté, page du menu principal)."""
    start = f"{base}/faces/Login.xhtml"
    try:
        probe = httpx.get(start, follow_redirects=True, timeout=ade.TIMEOUT, headers={"User-Agent": ade.UA})
    except httpx.HTTPError as exc:
        raise robot_errors.from_http(exc, SERVICE) from None
    if robot_errors.is_blocked(probe):
        raise robot_errors.blocked(SERVICE)
    if urlparse(str(probe.url)).hostname != urlparse(base).hostname:
        # Aurion renvoie vers la page de l'université (CAS/Shibboleth) : même connexion que pour ADE.
        return ade.sso_login(start, username, password,
                             back=lambda r: "/faces/" in r.url.path and not _is_login_page(r))
    client = httpx.Client(follow_redirects=True, timeout=ade.TIMEOUT, headers={"User-Agent": ade.UA})
    try:
        page = client.get(start)
        form = next((f for f in ade._parse(page.text).forms if any(i["type"] == "password" for i in f["inputs"])), None)
        if form is None:
            raise robot_errors.page_changed(SERVICE)
        data = {i["name"]: i["value"] for i in form["inputs"] if i["name"] and i["type"] == "hidden"}
        for i in form["inputs"]:
            if i["type"] == "password":
                data[i["name"]] = password
            elif i["type"] in ("text", "email") and i["name"]:
                data[i["name"]] = username
        res = client.post(urljoin(str(page.url), html.unescape(form["action"]) or str(page.url)), data=data)
        if robot_errors.is_blocked(res):
            raise robot_errors.blocked(SERVICE)
        if _is_login_page(res):
            low = res.text.lower()
            if any(w in low for w in ade.MFA_WORDS) and not any(w in low for w in ade.BAD_WORDS):
                raise robot_errors.two_factor(SERVICE)
            raise robot_errors.bad_credentials(SERVICE)
        return client, res
    except httpx.HTTPError as exc:
        client.close()
        raise robot_errors.from_http(exc, SERVICE) from None
    except Exception:
        client.close()
        raise


MENU_RE = re.compile(r"""\{\s*'?form:sidebar'?\s*:\s*'form:sidebar'\s*,\s*'?form:sidebar_menuid'?\s*:\s*'([^']+)'\s*\}""")


def planning_menu(page: str) -> str | None:
    """Identifiant de l'entrée « Planning » du menu (ex. « 1_0 »), lu dans les liens du menu principal."""
    for m in re.finditer(r"<a\b[^>]*onclick=\"([^\"]*)\"[^>]*>(.*?)</a>", page, re.I | re.S):
        label = re.sub(r"<[^>]+>", " ", m.group(2)).lower()
        if "planning" in label:
            found = MENU_RE.search(html.unescape(m.group(1)))
            if found:
                return found.group(1)
    for m in re.finditer(r"<li\b[^>]*class=\"[^\"]*menuitem[^\"]*\"[^>]*>.*?</li>", page, re.I | re.S):
        if "planning" in m.group(0).lower():
            found = MENU_RE.search(html.unescape(m.group(0)))
            if found:
                return found.group(1)
    return None


def open_planning(client: httpx.Client, base: str, main: httpx.Response) -> httpx.Response:
    """Du menu principal à la page Planning.xhtml."""
    planning_url = f"{base}/faces/Planning.xhtml"
    menu = planning_menu(main.text)
    if menu:
        data = inputs(main.text)
        data.update({"form": "form", "form:sidebar": "form:sidebar", "form:sidebar_menuid": menu})
        res = client.post(urljoin(str(main.url), f"{base}/faces/MainMenuPage.xhtml"), data=data)
        if "Planning.xhtml" in res.url.path or "schedule" in res.text:
            return res
    res = client.get(planning_url)
    if _is_login_page(res) or "schedule" not in res.text:
        raise robot_errors.page_changed(SERVICE)
    return res


def schedule_id(page: str) -> str:
    """Identifiant du calendrier PrimeFaces (ex. « form:j_idt118 »)."""
    fields = inputs(page)
    for name, value in fields.items():
        if name.endswith("_view") and value in ("agendaWeek", "agendaDay", "month", "week", "day", "timeGridWeek"):
            return name[: -len("_view")]
    m = re.search(r'<div[^>]+id="([^"]+)"[^>]+class="[^"]*\bschedule\b', page) or \
        re.search(r'class="[^"]*\bschedule\b[^"]*"[^>]+id="([^"]+)"', page)
    if m:
        return m.group(1)
    raise robot_errors.page_changed(SERVICE)


def _ms(d: date) -> int:
    return int(datetime(d.year, d.month, d.day).timestamp() * 1000)


def fetch_events(client: httpx.Client, base: str, planning: httpx.Response, start: date, end: date) -> list[dict]:
    """Demande « ajax » du calendrier entre deux dates ; renvoie les cours au format de Studoo."""
    sid = schedule_id(planning.text)
    data = inputs(planning.text)
    data.update({
        "javax.faces.partial.ajax": "true", "javax.faces.source": sid, "javax.faces.partial.execute": sid,
        "javax.faces.partial.render": sid, sid: sid, f"{sid}_start": str(_ms(start)), f"{sid}_end": str(_ms(end)),
    })
    res = client.post(f"{base}/faces/Planning.xhtml", data=data, headers={
        "Faces-Request": "partial/ajax", "X-Requested-With": "XMLHttpRequest", "Accept": "application/xml, text/xml, */*; q=0.01"})
    if robot_errors.is_blocked(res):
        raise robot_errors.blocked(SERVICE)
    return parse_partial(res.text, sid)


def parse_partial(xml: str, sid: str = "") -> list[dict]:
    """Réponse XML PrimeFaces → cours. Cherche la partie <update> qui contient {"events": [...]}."""
    blocks = re.findall(r'<update id="([^"]*)"><!\[CDATA\[(.*?)\]\]></update>', xml, re.S)
    for update_id, content in sorted(blocks, key=lambda b: b[0] != sid):
        try:
            payload = json.loads(content)
        except ValueError:
            continue
        if isinstance(payload, dict) and isinstance(payload.get("events"), list):
            return [e for e in (to_event(x) for x in payload["events"]) if e]
    raise robot_errors.page_changed(SERVICE)


def _iso(value: str) -> str:
    """« 2026-11-26T08:00:00+0100 » → « 2026-11-26T08:00:00+01:00 » (lisible par tous les navigateurs)."""
    value = str(value).strip()
    return re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", value)


def split_title(title: str) -> dict:
    """Titre d'un cours Aurion (« 08:00 à 10:00 - B204 - TD - Mathématiques - M. X - Groupe 1 » ou sur plusieurs
    lignes) → matière, salle, type. Les établissements n'écrivent pas tous la même chose : on devine prudemment."""
    parts = [p.strip() for p in (title.split("\n") if "\n" in title else title.split(" - ")) if p.strip()]
    parts = [p for p in parts if not TIME_RE.match(p)]
    room = next((p for p in parts if ROOM_RE.match(p)), "")
    kind = next((p for p in parts if p.upper() in KINDS), "")
    rest = [p for p in parts if p not in (room, kind)]
    subject = rest[0] if rest else (title.strip() or "Cours")
    return {"subject": subject, "room": room, "kind": kind}


def to_event(raw: dict) -> dict | None:
    if not isinstance(raw, dict) or not raw.get("start"):
        return None
    title = str(raw.get("title") or "")
    info = split_title(title)
    subject = clean_subject(info["subject"])
    return {
        "uid": f"aurion-{raw.get('id', '')}"[:200], "title": title.replace("\n", " · ")[:200],
        "subject": subject[:80],  # sans « TD »/« CM » : une seule matière, un seul dossier de cours
        "start": _iso(raw["start"]), "end": _iso(raw.get("end") or raw["start"]), "location": info["room"][:120],
        "description": "", "cancelled": "annul" in str(raw.get("className", "")).lower() or "annulé" in title.lower(),
    }


def robot(base: str, username: str, password: str, weeks_before: int = 1, weeks_after: int = 5) -> list[dict]:
    """Tout le parcours : connexion → planning → cours. Le mot de passe ne sert qu'à la première étape."""
    started = time.monotonic()
    client, main = login(base, username, password)
    try:
        planning = open_planning(client, base, main)
        today = date.today()
        events = fetch_events(client, base, planning, today - timedelta(weeks=weeks_before), today + timedelta(weeks=weeks_after))
    except httpx.HTTPError as exc:
        raise robot_errors.from_http(exc, SERVICE) from None
    finally:
        client.close()
    if time.monotonic() - started > 100:
        raise robot_errors.timeout(SERVICE)
    return sorted(events, key=lambda e: e["start"])
