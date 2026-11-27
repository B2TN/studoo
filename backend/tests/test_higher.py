"""Supérieur : recherche d'établissement, détection du logiciel d'emploi du temps, robot Celcat."""
import asyncio

import httpx
import pytest
from fastapi import HTTPException

from studoo.services import higher

CELCAT = "https://celcat.u-bordeaux.fr/Calendar"


def test_detect_recognises_ade_and_celcat(monkeypatch):
    def handler(req):
        url = str(req.url)
        if url == "https://adeconsult.app.example.fr/direct/":
            return httpx.Response(302, headers={"location": "https://cas.example.fr/cas/login?service=x"})
        if url == "https://celcat.example.fr/calendar/":
            return httpx.Response(200, text="<title>CELCAT Calendar</title>")
        if url.startswith("https://hp.example.fr/hp/"):
            return httpx.Response(200, text="<title>HYPERPLANNING</title>")
        if req.url.host in ("adeconsult.app.example.fr", "celcat.example.fr", "hp.example.fr"):
            return httpx.Response(404)  # l'hôte existe, pas ce chemin
        raise httpx.ConnectError("pas d'adresse", request=req)

    real = httpx.AsyncClient
    monkeypatch.setattr(higher.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    from studoo.services import netguard
    monkeypatch.setattr(netguard, "check_host", lambda host: None)  # faux domaine de test (aucune résolution DNS)
    found = asyncio.run(higher.detect("https://www.example.fr/"))
    assert [(x["software"], x["base"], x["login"]) for x in found] == [
        ("ade", "https://adeconsult.app.example.fr", True),
        ("celcat", "https://celcat.example.fr/calendar", False),
        ("hyperplanning", "https://hp.example.fr", False)]


def test_detect_refuses_garbage_and_uses_known_addresses():
    with pytest.raises(HTTPException):
        asyncio.run(higher.detect("localhost"))
    assert asyncio.run(higher.detect("u-pariscite.fr"))[0]["base"] == "https://adeconsult.app.u-pariscite.fr"


def test_celcat_events_skip_holidays_and_read_module_and_room():
    data = [
        {"id": "v", "start": "2026-10-26T08:00:00", "end": None, "allDay": True, "description": "Vacances", "eventCategory": "Vacances"},
        {"id": "c1", "start": "2026-12-01T08:00:00", "end": "2026-12-01T10:00:00", "allDay": False, "eventCategory": "CM",
         "description": "CM\r\n<br />\r\nAlgorithmique\r\n<br />\r\nAmphi A\r\n", "modules": ["4TIN101U Algorithmique"], "sites": ["Talence"]},
        {"id": "c2", "start": "2026-12-02T08:00:00", "end": "2026-12-02T10:00:00", "allDay": False, "eventCategory": "TD annulé",
         "description": "TD annulé<br />Maths", "modules": None, "sites": None},
    ]

    def handler(req):
        assert b"federationIds%5B%5D=L1+INFO" in req.content and b"resType=103" in req.content
        return httpx.Response(200, json=data)
    client = httpx.Client(transport=httpx.MockTransport(handler))
    events = higher.celcat_events(client, CELCAT, "L1 INFO")
    assert len(events) == 2
    assert events[0]["title"] == "CM - 4TIN101U Algorithmique" and events[0]["location"] == "Talence" and not events[0]["cancelled"]
    assert events[1]["title"] == "TD annulé - Maths" and events[1]["cancelled"]


def test_celcat_group_search_needs_login_when_protected():
    client = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(302, headers={"location": "/calendar/Login"})))
    with pytest.raises(HTTPException) as err:
        higher.celcat_groups(client, CELCAT, "info")
    assert err.value.detail["code"] == "login_required"


def test_celcat_public_group_is_kept_sealed_and_synced(logged, monkeypatch):
    from studoo.routes import timetable
    monkeypatch.setattr(timetable, "_public_https", lambda url: url.rstrip("/"))  # pas de résolution DNS dans les tests
    ev = [{"uid": "1", "title": "CM - Algo", "subject": "Algo", "start": "2026-12-01T08:00:00", "end": "2026-12-01T10:00:00",
           "location": "", "description": "", "cancelled": False}]
    monkeypatch.setattr(higher, "celcat_events", lambda client, base, fid: ev)
    res = logged.post("/api/timetable/celcat/choose", json={"base": CELCAT, "group": "L1 INFO", "label": "L1 INFO"}).json()
    assert res["method"] == "celcat" and res["sealed"] and "L1 INFO" not in res["sealed"]
    synced = logged.post("/api/timetable/sync", json={"sealed": res["sealed"]}).json()
    assert synced["method"] == "celcat" and synced["events"][0]["title"] == "CM - Algo"


def test_robot_addresses_must_be_public_https(logged):
    res = logged.post("/api/timetable/ade/login", json={"base": "http://127.0.0.1:8080", "username": "a", "password": "b"})
    assert res.status_code == 422
    res = logged.post("/api/timetable/celcat/groups", json={"base": "https://localhost/calendar", "q": "x"})
    assert res.status_code in (400, 422)


def test_detect_never_probes_internal_addresses(monkeypatch):
    """Audit de sécurité : un domaine qui pointe vers le réseau interne n'est jamais interrogé."""
    asked = []

    def handler(req):
        asked.append(req.url.host)
        return httpx.Response(200, text="<title>CELCAT Calendar</title>")

    real = httpx.AsyncClient
    monkeypatch.setattr(higher.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    from studoo.services import netguard
    from fastapi import HTTPException as E

    def internal(host):
        raise E(422, detail={"code": "bad_url", "message": "interne"})
    monkeypatch.setattr(netguard, "check_host", internal)
    assert asyncio.run(higher.detect("interne-exemple.fr")) == [] and asked == []
