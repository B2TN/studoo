"""Lecture des emplois du temps au format iCalendar (.ics).

On télécharge le lien côté serveur car les ENT n'autorisent pas les
navigateurs à le lire directement (règle CORS). Pour éviter qu'un pirate
utilise ce service pour sonder notre réseau interne (attaque « SSRF »),
on refuse toute adresse privée ou locale.
"""
import ipaddress
import re
import socket
from datetime import date, datetime, time, timedelta
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

import httpx
from fastapi import HTTPException

MAX_BYTES = 3 * 1024 * 1024
MAX_EVENTS = 3000


def _bad(message: str, code: str = "bad_ics") -> HTTPException:
    return HTTPException(422, detail={"code": code, "message": message})


def normalize_url(url: str) -> str:
    url = url.strip()
    if url.startswith("webcal://"):
        url = "https://" + url[len("webcal://"):]
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise _bad("Le lien doit commencer par https:// ou webcal://", "bad_url")
    return roll_ade_dates(url)


def roll_ade_dates(url: str, today: date | None = None) -> str:
    """Les liens d'export ADE contiennent des dates fixes : on les fait « glisser »
    pour couvrir toujours les semaines à venir (synchro en continu)."""
    parsed = urlparse(url)
    params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    if "firstDate" in params and "lastDate" in params:
        today = today or date.today()
        params["firstDate"] = (today - timedelta(days=14)).isoformat()
        params["lastDate"] = (today + timedelta(days=180)).isoformat()
        return urlunparse(parsed._replace(query=urlencode(params)))
    return url


def _check_host(host: str) -> None:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise _bad("Adresse introuvable. Vérifie le lien.", "bad_url")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise _bad("Cette adresse n'est pas autorisée.", "bad_url")


async def fetch_ics(url: str) -> str:
    url = normalize_url(url)
    async with httpx.AsyncClient(timeout=15, follow_redirects=False,
                                 headers={"User-Agent": "Studoo-calendar/1.0"}) as client:
        for _ in range(4):  # on suit les redirections nous-mêmes, en vérifiant chaque hôte
            _check_host(urlparse(url).hostname or "")
            async with client.stream("GET", url) as res:
                if res.status_code in {301, 302, 303, 307, 308}:
                    url = urljoin(url, res.headers.get("location", ""))
                    continue
                if res.status_code != 200:
                    raise _bad(f"Le service d'emploi du temps a répondu {res.status_code}. Le lien est peut-être expiré.")
                chunks, size = [], 0
                async for chunk in res.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise _bad("Fichier d'emploi du temps trop gros.")
                    chunks.append(chunk)
                return b"".join(chunks).decode("utf-8", errors="replace")
    raise _bad("Trop de redirections.")


PREFIX_RE = re.compile(r"^(CM|TD|TP|Cours|DS|Exam(en)?|Partiel|Soutien)\s*[:\-–]?\s*", re.I)


def clean_subject(summary: str) -> str:
    """« MATHEMATIQUES - M. DUPONT - 101 » → « Mathématiques »."""
    s = summary.strip()
    s = re.split(r"\s+[-–|/]\s+", s)[0]
    s = PREFIX_RE.sub("", s).strip(" -–:")
    s = re.sub(r"\s+(LV\d|LVA|LVB|SPE|SPÉ|OPT)\b.*$", "", s, flags=re.I).strip()
    if s.isupper():
        # « HISTOIRE-GÉOGRAPHIE » → « Histoire-Géographie » (majuscule à chaque partie)
        s = "-".join(part.capitalize() for part in s.split("-"))
    fixes = {"Mathematiques": "Mathématiques", "Francais": "Français", "Histoire-geographie": "Histoire-Géographie", "Histoire-Geographie": "Histoire-Géographie",
             "Physique-chimie": "Physique-Chimie", "Sciences-Physiques": "Physique-Chimie", "Sciences economiques et sociales": "SES",
             "Education physique et sportive": "EPS", "Svt": "SVT", "Ses": "SES", "Eps": "EPS", "Nsi": "NSI",
             "Snt": "SNT", "Hggsp": "HGGSP", "Llcer": "LLCER"}
    return fixes.get(s, s)[:80] or "Cours"


def _iso(value) -> str:
    """Date ISO. Les heures « flottantes » (sans fuseau) restent sans fuseau :
    le navigateur les interprète alors à l'heure locale de l'élève."""
    if isinstance(value, datetime):
        return value.isoformat()
    return datetime.combine(value, time(0)).isoformat()


def parse_ics(text: str, start: date, end: date) -> dict:
    # Import tardif : la lecture iCal ne sert qu'aux pages d'emploi du temps.
    import recurring_ical_events
    from icalendar import Calendar

    try:
        cal = Calendar.from_ical(text)
    except ValueError:
        raise _bad("Ce fichier n'est pas un emploi du temps .ics valide.")
    events = []
    for ev in recurring_ical_events.of(cal).between(start, end):
        if len(events) >= MAX_EVENTS:
            break
        summary = str(ev.get("SUMMARY", "")).strip()
        if not summary:
            continue
        dtstart = ev.get("DTSTART").dt
        dtend = ev.get("DTEND").dt if ev.get("DTEND") else dtstart
        events.append({
            "uid": str(ev.get("UID", ""))[:200],
            "title": summary[:200],
            "subject": clean_subject(summary),
            "start": _iso(dtstart),
            "end": _iso(dtend),
            "location": str(ev.get("LOCATION", ""))[:120],
            "description": str(ev.get("DESCRIPTION", ""))[:400],
            "cancelled": str(ev.get("STATUS", "")).upper() == "CANCELLED",
        })
    events.sort(key=lambda e: e["start"])
    subjects = sorted({e["subject"] for e in events})
    return {"events": events, "subjects": subjects}


def url_variants(url: str) -> list[str]:
    """Formes à essayer pour un lien d'emploi du temps (« teste tout ») :
    le lien tel quel (dates ADE prolongées), puis, pour ADE, le format iCal forcé
    et la version « N semaines » qui n'a jamais besoin d'être mise à jour."""
    base = normalize_url(url)
    variants = [base]
    parsed = urlparse(base)
    params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    if "anonymous_cal.jsp" in parsed.path or "resources" in params:
        forced = {**params, "calType": "ical"}
        variants.append(urlunparse(parsed._replace(query=urlencode(forced))))
        weeks = {k: v for k, v in forced.items() if k not in {"firstDate", "lastDate"}}
        weeks["nbWeeks"] = "26"
        variants.append(urlunparse(parsed._replace(query=urlencode(weeks))))
    if parsed.scheme == "http":
        variants += [v.replace("http://", "https://", 1) for v in list(variants)]
    seen, out = set(), []
    for v in variants:
        if v not in seen:
            seen.add(v)
            out.append(v)
    return out


async def fetch_working(url: str, start: date, end: date) -> tuple[str, dict]:
    """Essaie chaque variante et renvoie la première qui donne un vrai calendrier."""
    last_error: HTTPException | None = None
    for candidate in url_variants(url):
        try:
            text = await fetch_ics(candidate)
            if "BEGIN:VCALENDAR" not in text[:2000]:
                raise _bad("Ce lien renvoie une page web, pas un calendrier. As-tu bien copié le lien « Exporter / iCal » ?")
            return candidate, parse_ics(text, start, end)
        except HTTPException as exc:
            last_error = exc
    raise last_error or _bad("Lien d'emploi du temps inutilisable.")
