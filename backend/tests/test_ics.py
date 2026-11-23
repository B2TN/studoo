from datetime import date

import pytest
from fastapi import HTTPException

from studoo.services import ics

SAMPLE = """BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//FR
BEGIN:VEVENT
UID:1@test
DTSTART:20261123T080000Z
DTEND:20261123T090000Z
RRULE:FREQ=WEEKLY;COUNT=4
SUMMARY:MATHEMATIQUES - M. DUPONT - 101
LOCATION:Salle 101
END:VEVENT
BEGIN:VEVENT
UID:2@test
DTSTART:20261124T100000Z
DTEND:20261124T120000Z
SUMMARY:TD Physique-Chimie
STATUS:CANCELLED
END:VEVENT
END:VCALENDAR
"""


@pytest.mark.parametrize("raw,expected", [
    ("MATHEMATIQUES - M. DUPONT - 101", "Mathématiques"),
    ("CM Analyse 1", "Analyse 1"),
    ("TD Physique-Chimie", "Physique-Chimie"),
    ("SVT", "SVT"),
    ("ANGLAIS LV1 - M. CARTER", "Anglais"),
])
def test_clean_subject(raw, expected):
    assert ics.clean_subject(raw) == expected


def test_parse_expands_recurrence():
    data = ics.parse_ics(SAMPLE, date(2026, 11, 20), date(2026, 12, 31))
    maths = [e for e in data["events"] if e["subject"] == "Mathématiques"]
    assert len(maths) == 4
    assert data["subjects"] == ["Mathématiques", "Physique-Chimie"]
    assert any(e["cancelled"] for e in data["events"])


def test_parse_invalid():
    with pytest.raises(HTTPException):
        ics.parse_ics("pas un calendrier", date(2026, 1, 1), date(2026, 2, 1))


def test_webcal_and_ade_rolling():
    assert ics.normalize_url("webcal://exemple.fr/cal.ics").startswith("https://")
    url = "https://ade.univ.fr/jsp/custom/modules/plannings/anonymous_cal.jsp?resources=12&projectId=3&firstDate=2024-01-01&lastDate=2024-02-01"
    rolled = ics.roll_ade_dates(url, today=date(2026, 11, 23))
    assert "firstDate=2026-11-09" in rolled and "lastDate=2027-05-22" in rolled
    with pytest.raises(HTTPException):
        ics.normalize_url("ftp://exemple.fr/x.ics")


def test_ssrf_private_address_refused():
    with pytest.raises(HTTPException) as exc:
        ics._check_host("127.0.0.1")
    assert exc.value.detail["code"] == "bad_url"


def test_ics_file_endpoint(logged):
    res = logged.post("/api/timetable/ics-file", json={"content": SAMPLE, "days_before": 60, "days_after": 60})
    assert res.status_code == 200


def test_floating_times_stay_local():
    cal = SAMPLE.replace("DTSTART:20261123T080000Z", "DTSTART:20261123T080000").replace("DTEND:20261123T090000Z", "DTEND:20261123T090000")
    ev = ics.parse_ics(cal, date(2026, 11, 20), date(2026, 11, 24))["events"][0]
    assert ev["start"] == "2026-11-23T08:00:00"
