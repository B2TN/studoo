import uuid

import numpy as np

from studoo import db
from studoo.jobcrypto import seal_payload
from studoo_worker import __main__ as main
from studoo_worker import notify, pipelines, queue, settings


def add_job(kind="podcast", **payload):
    job_id = str(uuid.uuid4())
    data = {"refresh_token": "rt", "email": "e@x.fr", "sources": [{"title": "C", "text": "Cours"}], "images": [],
            "options": {"minutes": 10}, "folder_id": "folder", "course": "", "chapter": "", **payload}
    with db.get_engine().begin() as conn:
        conn.execute(db.jobs.insert().values(
            id=job_id, sub="u1", kind=kind, title="T", status="queued", progress=0, step="", attempts=0,
            payload=seal_payload(settings.JOB_SECRET, data), error="", result_file_id="", result_name="",
            notified=False, created_at=db.now()))
    return job_id


def get(job_id):
    with db.get_engine().connect() as conn:
        return conn.execute(db.jobs.select().where(db.jobs.c.id == job_id)).mappings().one()


def test_claim_and_finish_wipes_payload():
    jid = add_job()
    job, payload = queue.claim()
    assert job["id"] == jid and payload["refresh_token"] == "rt"
    assert get(jid)["status"] == "running"
    assert queue.claim() is None  # déjà prise
    queue.finish(jid, "file1", "Podcast.mp3")
    row = get(jid)
    assert row["status"] == "done" and row["payload"] is None and row["progress"] == 100


def test_retry_then_final_failure():
    jid = add_job()
    for attempt in range(1, settings.MAX_ATTEMPTS + 1):
        job, _ = queue.claim()
        queue.fail(jid, "boum", attempts=job["attempts"])
    row = get(jid)
    assert row["status"] == "failed" and row["error"] == "boum"


def test_process_one_end_to_end(monkeypatch):
    jid = add_job()
    calls = {}
    monkeypatch.setattr(pipelines, "PIPELINES", {"podcast": lambda p, report: (report(50, "x"), (b"mp3", "Podcast — T.mp3", "audio/mpeg", "podcast", {}))[1]})
    monkeypatch.setattr(pipelines.drive, "access_token", lambda rt: "tok")
    monkeypatch.setattr(pipelines.drive, "upload", lambda token, **kw: calls.setdefault("upload", {"id": "f1", "name": kw["name"]}))
    monkeypatch.setattr(notify, "_push", lambda *a: 1)
    assert main.process_one() is True
    row = get(jid)
    assert row["status"] == "done" and row["result_file_id"] == "f1" and row["notified"]


def test_cancelled_job_stops(monkeypatch):
    jid = add_job()

    def slow(payload, report):
        with db.get_engine().begin() as conn:
            conn.execute(db.jobs.update().where(db.jobs.c.id == jid).values(status="cancelled"))
        report(10, "étape")
        raise AssertionError("ne doit pas arriver")
    monkeypatch.setattr(pipelines, "PIPELINES", {"podcast": slow})
    assert main.process_one() is True
    assert get(jid)["status"] == "cancelled"


def test_video_render_and_mp3():
    from studoo_worker import media, tts
    slides = [{"title": "Les suites", "bullets": ["On multiplie", "Par q"], "narration": "Une suite géométrique se construit en multipliant.", "doodle": "idea"}]
    audios = [tts.silence(2.0)]
    mp4 = media.mp4(slides, audios, "short")
    assert mp4[4:8] == b"ftyp" and len(mp4) > 5000
    head = media.mp3(np.zeros(24000, dtype=np.float32))
    assert head[:3] == b"ID3" or head[:2] in (b"\xff\xfb", b"\xff\xf3")  # en-tête ID3 ou trame MP3


def test_purge_failed_after_24h():
    from datetime import timedelta
    jid = add_job()
    with db.get_engine().begin() as conn:
        conn.execute(db.jobs.update().where(db.jobs.c.id == jid).values(status="failed", finished_at=db.now() - timedelta(hours=30)))
    queue.purge()
    assert get(jid)["payload"] is None


def test_lock_is_kept_alive_during_a_long_step(monkeypatch):
    # Un appel au modèle peut durer plus que le verrou : sans prolongation, une 2e machine reprenait la tâche.
    import time

    jid = add_job()
    calls = []
    real = queue.keep_alive
    monkeypatch.setattr(main, "KEEP_ALIVE_SECONDS", 0.05)
    monkeypatch.setattr(queue, "keep_alive", lambda job_id: (calls.append(job_id), real(job_id)))

    def slow(payload, report):
        time.sleep(0.4)  # une longue étape sans aucun report()
        return b"mp3", "Podcast — T.mp3", "audio/mpeg", "podcast", {}

    monkeypatch.setattr(pipelines, "PIPELINES", {"podcast": slow})
    monkeypatch.setattr(pipelines.drive, "access_token", lambda rt: "tok")
    monkeypatch.setattr(pipelines.drive, "upload", lambda token, **kw: {"id": "f1", "name": kw["name"]})
    monkeypatch.setattr(notify, "_push", lambda *a: 1)
    assert main.process_one() is True
    assert len(calls) >= 3 and set(calls) == {jid}
    seen = len(calls)
    time.sleep(0.2)
    assert len(calls) == seen  # arrêté à la fin de la tâche
    assert get(jid)["status"] == "done"
