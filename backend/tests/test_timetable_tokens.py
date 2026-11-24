import logging

import pytest
from fastapi import HTTPException

from studoo.services import ics, pronote
from studoo.services.sealed import seal, unseal

EVENTS = [{"uid": "1", "title": "Maths", "subject": "Mathématiques", "start": "2026-11-24T08:00:00",
           "end": "2026-11-24T09:00:00", "location": "", "description": "", "cancelled": False}]


def test_sealed_token_is_encrypted_and_bound_to_user():
    token = seal("user-1", {"kind": "ical", "url": "https://pronote.example/ical?secret=abc"})
    assert "secret=abc" not in token
    assert unseal("user-1", token)["url"].endswith("secret=abc")
    with pytest.raises(HTTPException):
        unseal("user-2", token)
    with pytest.raises(HTTPException):
        unseal("user-1", token[:-5] + "AAAAA")


def test_ade_variants_try_everything():
    url = "https://adeconsult.app.u-pariscite.fr/jsp/custom/modules/plannings/anonymous_cal.jsp?resources=123&projectId=4&firstDate=2024-01-01&lastDate=2024-06-30"
    variants = ics.url_variants(url)
    assert len(variants) == 3
    assert "calType=ical" in variants[1]
    assert "nbWeeks=26" in variants[2] and "firstDate" not in variants[2]


def test_ics_url_returns_sealed_source(logged, monkeypatch):
    async def fake_fetch(url, start, end):
        return url, {"events": EVENTS, "subjects": ["Mathématiques"]}
    monkeypatch.setattr("studoo.routes.timetable.fetch_working", fake_fetch)
    res = logged.post("/api/timetable/ics-url", json={"url": "https://edt.example.fr/cal.ics?token=SECRET"}).json()
    assert res["method"] == "ical" and "SECRET" not in res["sealed"]
    synced = logged.post("/api/timetable/sync", json={"sealed": res["sealed"]}).json()
    assert synced["events"][0]["subject"] == "Mathématiques"


def test_pronote_password_never_returned(logged, monkeypatch):
    seen = {}

    def fake_login(mode, **kw):
        seen.update(kw)
        return EVENTS, {"kind": "ical", "url": "https://0750000a.index-education.net/pronote/ical/mesinformations.ics?icalsecurise=X"}
    monkeypatch.setattr(pronote, "login", fake_login)
    monkeypatch.setattr("studoo.routes.timetable._check_host", lambda host: None)
    res = logged.post("/api/timetable/pronote", json={
        "mode": "ent", "ent": "ile_de_france", "url": "https://0750000a.index-education.net/pronote/eleve.html",
        "username": "eleve", "password": "MotDePasseSecret",
    })
    assert res.status_code == 200
    assert seen["password"] == "MotDePasseSecret"  # utilisé pour se connecter…
    assert "MotDePasseSecret" not in res.text  # …mais jamais renvoyé
    assert res.json()["sealed"] and res.json()["method"] == "ical"


@pytest.mark.parametrize("payload,code", [
    ({"mode": "ent", "ent": "inconnu", "url": "https://x.index-education.net/pronote/", "username": "a", "password": "b"}, "invalid"),
    ({"mode": "password", "url": "http://x.fr/", "username": "a", "password": "b"}, "bad_url"),
    ({"mode": "qr", "qr": {"url": "https://x/pronote/"}, "pin": "12"}, "bad_qr"),
])
def test_pronote_validation(logged, payload, code):
    res = logged.post("/api/timetable/pronote", json=payload)
    assert res.status_code == 422 and res.json()["detail"]["code"] == code


def test_validation_error_does_not_echo_password(logged):
    res = logged.post("/api/timetable/pronote", json={"mode": "password", "password": "x" * 500})
    assert res.status_code == 422 and "xxxxx" not in res.text


def test_pronotepy_debug_logs_disabled():
    assert logging.getLogger("pronotepy").level == logging.WARNING


def test_ent_list(client):
    ents = client.get("/api/timetable/ents").json()["ents"]
    assert {"ile_de_france", "monbureaunumerique", "ent_hdf"} <= {e["id"] for e in ents}
