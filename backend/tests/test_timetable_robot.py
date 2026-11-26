"""Itération 4 (C2) : le robot de connexion à l'emploi du temps des lycéens."""
import logging

import httpx
import pytest
from fastapi import HTTPException

from studoo.services import pronote

EVENTS = [{"uid": "1", "title": "Maths", "subject": "Mathématiques", "start": "2026-11-24T08:00:00",
           "end": "2026-11-24T09:00:00", "location": "", "description": "", "cancelled": False}]
BODY = {"uai": "0190701J", "username": "lea.martin", "password": "MotDePasse-Secret-42"}


def test_school_url_comes_from_the_official_code():
    assert pronote.school_url("0190701j") == "https://0190701j.index-education.net/pronote/"
    with pytest.raises(HTTPException):
        pronote.school_url("https://evil.example/pronote")


def test_ent_is_recognised_from_the_login_redirect(monkeypatch):
    def get(url, **kw):
        return httpx.Response(302, headers={"location": "https://mon.lyceeconnecte.fr/cas/login?service=x"})
    monkeypatch.setattr(pronote.httpx, "get", get)
    assert pronote.detect_ent("https://0190701j.index-education.net/pronote/eleve.html") == [
        "lyceeconnecte_aquitaine", "lyceeconnecte_edu"]
    monkeypatch.setattr(pronote.httpx, "get", lambda url, **kw: httpx.Response(200))
    assert pronote.detect_ent("https://x.index-education.net/pronote/eleve.html") == []  # Pronote direct


def test_unknown_ent_and_maintenance_have_clear_messages(monkeypatch):
    monkeypatch.setattr(pronote.httpx, "get", lambda url, **kw: httpx.Response(302, headers={"location": "https://educonnect.education.gouv.fr/x"}))
    with pytest.raises(HTTPException) as err:
        pronote.detect_ent("https://x.index-education.net/pronote/eleve.html")
    assert err.value.detail["code"] == "ent_unsupported" and "EduConnect" in err.value.detail["message"]

    def down(url, **kw):
        raise httpx.ConnectError("boom")
    monkeypatch.setattr(pronote.httpx, "get", down)
    with pytest.raises(HTTPException) as err:
        pronote.detect_ent("https://x.index-education.net/pronote/eleve.html")
    assert err.value.status_code == 503 and "maintenance" in err.value.detail["message"]


@pytest.mark.parametrize("exc, code", [
    (type("MFAError", (Exception,), {})("double authentification requise"), "two_factor"),
    (type("ENTLoginError", (Exception,), {})("bad"), "bad_credentials"),
    (type("ConnectionError", (Exception,), {})("down"), "unavailable"),
])
def test_library_errors_become_clear_messages(exc, code):
    assert pronote._explain(exc).detail["code"] == code


def test_robot_connect_keeps_only_the_sealed_ical_link(logged, monkeypatch, caplog):
    seen = {}

    def fake_robot(uai, username, password):
        seen.update(uai=uai, username=username, password=password)
        return EVENTS, {"kind": "ical", "url": "https://0190701j.index-education.net/pronote/ical/x.ics?icalsecurise=S3CRET"}

    monkeypatch.setattr(pronote, "robot_login", fake_robot)
    with caplog.at_level(logging.DEBUG):
        res = logged.post("/api/timetable/connect", json=BODY)
    assert res.status_code == 200 and seen["password"] == BODY["password"]
    data = res.json()
    assert data["method"] == "ical" and data["sealed"] and len(data["events"]) == 1
    body = res.text
    assert BODY["password"] not in body and "S3CRET" not in body  # ni le mot de passe ni le lien en clair
    assert BODY["password"] not in caplog.text  # jamais dans les journaux


def test_robot_without_ical_asks_to_reconnect_later(logged, monkeypatch):
    monkeypatch.setattr(pronote, "robot_login", lambda *a: (EVENTS, {"kind": "snapshot"}))
    data = logged.post("/api/timetable/connect", json=BODY).json()
    assert data["method"] == "snapshot" and data["sealed"] is None and data["events"]


def test_wrong_password_message(logged, monkeypatch):
    def fail(*a):
        raise HTTPException(401, detail={"code": "bad_credentials", "message": "Identifiants incorrects."})
    monkeypatch.setattr(pronote, "robot_login", fail)
    res = logged.post("/api/timetable/connect", json=BODY)
    assert res.status_code == 401 and BODY["password"] not in res.text


def test_robot_tries_the_second_ent_variant_then_succeeds(monkeypatch):
    monkeypatch.setattr(pronote, "detect_ent", lambda url: ["lyceeconnecte_aquitaine", "lyceeconnecte_edu"])
    tried = []

    def login(mode, *, url, username, password, ent):
        tried.append(ent)
        if ent == "lyceeconnecte_aquitaine":
            raise HTTPException(401, detail={"code": "bad_credentials", "message": "x"})
        return EVENTS, None

    monkeypatch.setattr(pronote, "login", login)
    events, keep = pronote.robot_login("0190701J", "u", "p")
    assert tried == ["lyceeconnecte_aquitaine", "lyceeconnecte_edu"] and keep == {"kind": "snapshot"}


def test_school_search_uses_the_official_directory(logged, monkeypatch):
    calls = {}

    class FakeClient:
        def __init__(self, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, params):
            calls.update(url=url, params=params)
            return httpx.Response(200, request=httpx.Request("GET", url), json={"results": [
                {"identifiant_de_l_etablissement": "0750656F", "nom_etablissement": "Lycée Lavoisier",
                 "nom_commune": "Paris", "type_etablissement": "Lycée"}]})

    from studoo.routes import timetable
    monkeypatch.setattr(timetable.httpx, "AsyncClient", FakeClient)
    res = logged.get("/api/timetable/schools", params={"q": 'Lavoisier Paris"); drop'})
    assert res.json()["schools"] == [{"uai": "0750656F", "name": "Lycée Lavoisier", "city": "Paris", "type": "Lycée"}]
    assert "data.education.gouv.fr" in calls["url"] and '"' not in calls["params"]["where"].split("search(")[1].split(",")[1].split(")")[0].strip('" ')
