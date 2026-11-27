"""Itération 6 (C3) : robots EXPÉRIMENTAUX HyperPlanning, Aurion et ADE (identifiants propres à ADE).

Aucun compte réel : on rejoue des pages d'exemple (tests/fixtures) avec un faux serveur, et on vérifie les
cas d'erreur demandés : mauvais identifiants, double authentification, page modifiée, délai dépassé, blocage.
"""
import logging
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest
from fastapi import HTTPException

from studoo.services import ade, aurion, hyperplanning

FIX = Path(__file__).parent / "fixtures"
AURION = "https://aurion.ecole-exemple.fr"
HP = "https://hp.univ-exemple.fr"
REAL_CLIENT = httpx.Client


def page(name: str) -> str:
    return (FIX / name).read_text(encoding="utf-8")


def fake_server(monkeypatch, handler):
    """Toutes les requêtes httpx (clients et httpx.get) passent par `handler(request) → Response`."""
    from studoo.services import netguard
    # Faux serveurs de test (noms qui n'existent pas) : seuls ceux-là sont acceptés sans résolution DNS.
    real_check = netguard.check_host
    monkeypatch.setattr(netguard, "check_host", lambda host: None if host.endswith(("exemple.fr", "univ-x.fr")) else real_check(host))
    transport = httpx.MockTransport(handler)
    real = REAL_CLIENT
    monkeypatch.setattr(httpx, "Client", lambda **kw: real(transport=transport, **kw))

    def get(url, **kw):
        with real(transport=transport, follow_redirects=kw.get("follow_redirects", False)) as c:
            return c.get(url)
    monkeypatch.setattr(httpx, "get", get)


def code(exc_info) -> str:
    return exc_info.value.detail["code"]


# ---------------------------------------------------------------- Aurion
def aurion_handler(seen, *, password="bon-mot-de-passe", planning_ok=True):
    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path
        form = parse_qs(req.content.decode()) if req.method == "POST" else {}
        seen.append((req.method, path, form))
        if path == "/faces/Login.xhtml":
            return httpx.Response(200, text=page("aurion/login.html"))
        if path == "/login":
            if form.get("password") == [password] and form.get("username") == ["marie.dupont"]:
                return httpx.Response(302, headers={"location": f"{AURION}/faces/MainMenuPage.xhtml"})
            return httpx.Response(200, text=page("aurion/login_error.html"))
        if path == "/faces/MainMenuPage.xhtml" and req.method == "GET":
            return httpx.Response(200, text=page("aurion/main_menu.html"))
        if path == "/faces/MainMenuPage.xhtml":
            assert form["form:sidebar_menuid"] == ["1_3"]  # l'entrée « Mon planning » lue dans le menu
            assert form["javax.faces.ViewState"] == ["-1234567890123456789:987654321"]
            return httpx.Response(302, headers={"location": f"{AURION}/faces/Planning.xhtml"})
        if path == "/faces/Planning.xhtml" and req.method == "GET":
            return httpx.Response(200, text=page("aurion/planning.html") if planning_ok else "<html>Nouvelle interface</html>")
        if path == "/faces/Planning.xhtml":
            assert req.headers["faces-request"] == "partial/ajax"
            assert form["javax.faces.source"] == ["form:j_idt118"] and "form:j_idt118_start" in form
            return httpx.Response(200, text=page("aurion/planning_partial.xml"))
        return httpx.Response(404)
    return handler


def test_aurion_full_path_from_example_pages(monkeypatch):
    seen = []
    fake_server(monkeypatch, aurion_handler(seen))
    events = aurion.robot(AURION, "marie.dupont", "bon-mot-de-passe")
    assert [(e["subject"], e["start"], e["location"]) for e in events] == [
        ("Mathématiques", "2026-11-24T08:00:00+01:00", "B204"),
        ("Physique", "2026-11-24T14:00:00+01:00", "Amphi A"),
        ("Électronique", "2026-11-26T13:45:00+01:00", "Labo 2"),
    ]
    assert events[2]["cancelled"] is True
    # le mot de passe n'est envoyé qu'au formulaire de connexion
    assert [p for m, p, f in seen if "bon-mot-de-passe" in str(f)] == ["/login"]


def test_aurion_bad_credentials(monkeypatch):
    fake_server(monkeypatch, aurion_handler([]))
    with pytest.raises(HTTPException) as e:
        aurion.robot(AURION, "marie.dupont", "faux")
    assert code(e) == "bad_credentials"


def test_aurion_page_changed(monkeypatch):
    fake_server(monkeypatch, aurion_handler([], planning_ok=False))
    with pytest.raises(HTTPException) as e:
        aurion.robot(AURION, "marie.dupont", "bon-mot-de-passe")
    assert code(e) == "page_changed"


def test_aurion_blocked_and_timeout(monkeypatch):
    fake_server(monkeypatch, lambda req: httpx.Response(403, text="Access denied"))
    with pytest.raises(HTTPException) as e:
        aurion.robot(AURION, "u", "p")
    assert code(e) == "blocked"

    def slow(req):
        raise httpx.ReadTimeout("trop long", request=req)
    fake_server(monkeypatch, slow)
    with pytest.raises(HTTPException) as e:
        aurion.robot(AURION, "u", "p")
    assert code(e) == "timeout"


def test_aurion_two_factor(monkeypatch):
    def handler(req):
        if req.url.path == "/login":
            return httpx.Response(200, text='<form action="/login"><p>Saisis le code de vérification reçu par SMS</p>'
                                            '<input type="password" name="otp"></form>')
        return aurion_handler([])(req)
    fake_server(monkeypatch, handler)
    with pytest.raises(HTTPException) as e:
        aurion.robot(AURION, "marie.dupont", "bon-mot-de-passe")
    assert code(e) == "two_factor"


def test_aurion_title_formats():
    assert aurion.split_title("10:00 à 12:00 - Salle 101 - CM - Gestion de projet - Mme X - G1")["subject"] == "Gestion de projet"
    assert aurion.split_title("Amphi B\nThermodynamique\nTD\nM. Y") == {"subject": "Thermodynamique", "room": "Amphi B", "kind": "TD"}
    assert aurion.split_title("Réunion de rentrée")["subject"] == "Réunion de rentrée"
    with pytest.raises(HTTPException):
        aurion.parse_partial("<partial-response></partial-response>")


# ---------------------------------------------------------------- HyperPlanning
ICS = page("hyperplanning/edt.ics")


def test_hyperplanning_link_found_in_page_and_checked(monkeypatch):
    calls = []

    def handler(req):
        calls.append(str(req.url))
        if req.url.path == "/hp/etudiant":
            return httpx.Response(200, text=page("hyperplanning/espace_with_ical.html"))
        if req.url.path.startswith("/hp/Telechargements/ical/"):
            assert parse_qs(req.url.query.decode())["idICal"] == ["8F1C2A9B7E"]
            return httpx.Response(200, text=ICS)
        return httpx.Response(404)
    fake_server(monkeypatch, handler)
    url = hyperplanning.robot(HP, "marie", "secret")
    assert url == f"{HP}/hp/Telechargements/ical/Edt_DUPONT_Marie.ics?version=2025.0.3.1&idICal=8F1C2A9B7E&param=643d36"


def test_hyperplanning_protocol_candidates_are_validated(monkeypatch):
    fake_server(monkeypatch, lambda req: httpx.Response(200, text=page("hyperplanning/espace.html")))
    monkeypatch.setattr(hyperplanning, "_protocol_ical", lambda url, u, p, cookies=None: (
        f"{HP}/hp", hyperplanning.ical_candidates(f"{HP}/hp", "2025.0", "ABC", "def")))
    tried = []

    def check(url):
        tried.append(url)
        return "/ical/Edt.ics" in url and "icalsecurise=ABC" in url  # seul le 2e format répond par un calendrier
    url = hyperplanning.robot(HP, "marie", "secret", check=check)
    assert url.endswith("/hp/ical/Edt.ics?icalsecurise=ABC&version=2025.0&param=def") and len(tried) == 2


def test_hyperplanning_no_real_calendar_is_page_changed(monkeypatch):
    fake_server(monkeypatch, lambda req: httpx.Response(200, text=page("hyperplanning/espace.html")))
    monkeypatch.setattr(hyperplanning, "_protocol_ical", lambda *a, **k: (HP, [f"{HP}/hp/Telechargements/ical/x.ics?idICal=1"]))
    with pytest.raises(HTTPException) as e:
        hyperplanning.robot(HP, "marie", "secret", check=lambda url: False)
    assert code(e) == "page_changed"


def test_hyperplanning_blocked(monkeypatch):
    fake_server(monkeypatch, lambda req: httpx.Response(429))
    with pytest.raises(HTTPException) as e:
        hyperplanning.robot(HP, "marie", "secret")
    assert code(e) == "blocked"


def test_hyperplanning_cas_two_factor(monkeypatch):
    def handler(req):
        if req.url.host == "hp.univ-exemple.fr":
            return httpx.Response(302, headers={"location": "https://cas.univ-exemple.fr/cas/login?service=x"})
        return httpx.Response(200, text='<form action="/cas/login"><p>Double authentification : saisis ton code esup-otp</p>'
                                        '<input type="text" name="token"></form>')
    fake_server(monkeypatch, handler)
    with pytest.raises(HTTPException) as e:
        hyperplanning.robot(HP, "marie", "secret")
    assert code(e) == "two_factor"


def test_espace_url():
    assert hyperplanning.espace_url("https://hp.univ-x.fr") == "https://hp.univ-x.fr/hp/etudiant"
    assert hyperplanning.espace_url("https://edt.univ-x.fr/hp/") == "https://edt.univ-x.fr/hp/etudiant"


# ---------------------------------------------------------------- ADE avec ses propres identifiants
def test_ade_native_tries_field_positions_until_projects(monkeypatch):
    bodies = []
    monkeypatch.setattr(ade, "discover", lambda client, base: {"module": "m/", "perm": "P", "names": {
        "DirectPlanningServiceProxy": "D", "WebClientServiceProxy": "W"}, "methods": [], "sigs": dict(ade.DEFAULT_SIGS), "cid": "x"})

    def rpc(client, gwt, service, body):
        bodies.append(body)
        if service == "WebClientServiceProxy":
            return '{"12""2026-2027"' if len([b for b in bodies if "login" in b]) >= 2 else ""
        return ""
    monkeypatch.setattr(ade, "_rpc", rpc)
    client, gwt, projects = ade.login_native("https://ade.univ-x.fr", "marie|d", "mot\\passe")
    client.close()
    assert projects == [{"id": 12, "name": "2026-2027"}]
    logins = [b for b in bodies if "login" in b]
    assert len(logins) == 2 and logins[1].endswith(ade.NATIVE_FIELDS[1])
    assert "marie\\!d|mot\\\\passe|" in logins[0]  # caractères spéciaux échappés au format GWT


def test_ade_native_refused(monkeypatch):
    monkeypatch.setattr(ade, "discover", lambda client, base: {"module": "m/", "perm": "P", "names": {
        "DirectPlanningServiceProxy": "D", "WebClientServiceProxy": "W"}, "methods": [], "sigs": dict(ade.DEFAULT_SIGS), "cid": "x"})
    monkeypatch.setattr(ade, "_rpc", lambda *a: (_ for _ in ()).throw(HTTPException(502, detail={"code": "ade_error"})))
    with pytest.raises(HTTPException) as e:
        ade.login_native("https://ade.univ-x.fr", "u", "p")
    assert code(e) == "ade_native_refused"


# ---------------------------------------------------------------- Routes : jamais de mot de passe nulle part
def test_routes_mark_experimental_and_never_log_password(logged, monkeypatch, caplog):
    from studoo.routes import timetable
    monkeypatch.setattr(timetable, "_check_host", lambda host: None)
    seen = []
    fake_server(monkeypatch, aurion_handler(seen))
    caplog.set_level(logging.DEBUG)
    res = logged.post("/api/timetable/aurion", json={"base": AURION, "username": "marie.dupont", "password": "bon-mot-de-passe"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["experimental"] is True and body["method"] == "snapshot" and len(body["events"]) == 3
    assert "bon-mot-de-passe" not in res.text and "bon-mot-de-passe" not in caplog.text

    bad = logged.post("/api/timetable/aurion", json={"base": AURION, "username": "marie.dupont", "password": "faux-secret"})
    assert bad.status_code == 401 and bad.json()["detail"]["code"] == "bad_credentials"
    assert "faux-secret" not in bad.text and "faux-secret" not in caplog.text


def test_hyperplanning_route_keeps_only_a_sealed_link(logged, monkeypatch):
    from studoo.routes import timetable
    from studoo.services import ics
    monkeypatch.setattr(timetable, "_check_host", lambda host: None)
    monkeypatch.setattr(hyperplanning, "robot", lambda base, u, p: f"{HP}/hp/Telechargements/ical/Edt.ics?idICal=1")

    async def fetch_working(url, start, end):
        return url, ics.parse_ics(ICS, start, end)
    monkeypatch.setattr(timetable, "fetch_working", fetch_working)
    res = logged.post("/api/timetable/hyperplanning", json={"base": HP, "username": "marie", "password": "secret"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["experimental"] is True and body["method"] == "ical" and body["sealed"]
    assert "idICal" not in res.text  # le lien personnel n'est jamais renvoyé en clair


# ---------------------------------------------------------------- SSRF (audit de sécurité, itération 7)
def test_redirect_to_an_internal_address_is_refused(monkeypatch):
    """Un faux établissement redirige le robot vers l'adresse des métadonnées du cloud : refusé avant la requête."""
    asked = []

    def handler(req):
        asked.append(req.url.host)
        if req.url.host == "aurion.ecole-exemple.fr":
            return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data/"})
        return httpx.Response(200, text="secret interne")
    fake_server(monkeypatch, handler)
    with pytest.raises(HTTPException) as e:
        aurion.robot(AURION, "u", "p")
    assert e.value.status_code in (422, 502, 503) and "169.254.169.254" not in asked


def test_guard_refuses_private_loopback_and_odd_schemes():
    from studoo.services import netguard
    for host in ("127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "localhost", "[::1]"):
        with pytest.raises(HTTPException):
            netguard.check_host(host.strip("[]"))
    with pytest.raises(httpx.UnsupportedProtocol):
        netguard._check(httpx.Request("GET", "file:///etc/passwd"))
