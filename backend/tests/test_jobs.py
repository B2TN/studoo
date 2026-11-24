from studoo import db
from studoo.config import get_settings
from studoo.jobcrypto import open_payload

SRC = {"title": "Cours 1", "text": "Une suite géométrique de raison q."}


def _job(**over):
    data = {"kind": "podcast", "sources": [SRC], "options": {"minutes": 10}, "folder_id": "folder-123", "course": "Maths"}
    data.update(over)
    return data


def test_create_list_cancel(logged):
    res = logged.post("/api/jobs", json=_job())
    assert res.status_code == 201
    job = res.json()["job"]
    assert job["status"] == "queued" and "payload" not in job
    with db.get_engine().connect() as conn:
        row = conn.execute(db.jobs.select().where(db.jobs.c.id == job["id"])).mappings().one()
    payload = open_payload(get_settings().job_secret, row["payload"])
    assert payload["refresh_token"] == "dev" and payload["sources"][0]["text"].startswith("Une suite")
    assert "Une suite" not in row["payload"]  # chiffré
    assert logged.get("/api/jobs").json()["jobs"][0]["id"] == job["id"]
    assert logged.post(f"/api/jobs/{job['id']}/cancel").status_code == 200
    with db.get_engine().connect() as conn:
        row = conn.execute(db.jobs.select().where(db.jobs.c.id == job["id"])).mappings().one()
    assert row["status"] == "cancelled" and row["payload"] is None  # contenu effacé


def test_job_validation(logged):
    assert logged.post("/api/jobs", json=_job(sources=[])).status_code == 422
    assert logged.post("/api/jobs", json=_job(options={"minutes": 45})).status_code == 422
    assert logged.post("/api/jobs", json=_job(kind="ocr", sources=[], images=[])).status_code == 422


def test_anti_spam_pending_limit(logged):
    codes = [logged.post("/api/jobs", json=_job()).status_code for _ in range(7)]
    assert codes[:5] == [201] * 5 and codes[5] == 429


def test_jobs_are_private(logged):
    job = logged.post("/api/jobs", json=_job()).json()["job"]
    from studoo.deps import write_session
    from fastapi import Response
    resp = Response()
    write_session(resp, {"sub": "autre", "email": "x@y.z", "name": "x", "rt": "r"})
    logged.cookies.clear()
    logged.cookies.set("studoo_session", resp.headers["set-cookie"].split("=", 1)[1].split(";")[0])
    assert logged.post(f"/api/jobs/{job['id']}/cancel").status_code == 404
    assert logged.get("/api/jobs").json()["jobs"] == []


def test_push_subscribe(logged):
    body = {"endpoint": "https://fcm.googleapis.com/fcm/send/abc123456789", "p256dh": "x" * 40, "auth": "y" * 16}
    assert logged.post("/api/push/subscribe", json=body).status_code == 200
    assert logged.post("/api/push/subscribe", json=body).status_code == 200  # idempotent


QUEUE = "https://compte.queue.core.windows.net/studoo-jobs?sv=2024&sp=a&sig=abc"


def _capture(monkeypatch):
    import httpx
    calls = []

    async def fake_post(self, url, content, headers):
        calls.append((url, content))
        return httpx.Response(201, request=httpx.Request("POST", url))

    monkeypatch.setattr(get_settings(), "worker_queue_url", QUEUE)
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    return calls


def test_job_wakes_worker(logged, monkeypatch):
    calls = _capture(monkeypatch)
    assert logged.post("/api/jobs", json=_job()).status_code == 201
    assert calls == [("https://compte.queue.core.windows.net/studoo-jobs/messages?sv=2024&sp=a&sig=abc&messagettl=86400",
                      "<QueueMessage><MessageText>studoo</MessageText></QueueMessage>")]
    assert "Une suite" not in calls[0][1]  # aucun contenu de cours dans la file


def test_job_created_even_if_worker_unreachable(logged, monkeypatch):
    import httpx

    async def broken_post(self, url, content, headers):
        raise httpx.ConnectError("hors ligne")

    monkeypatch.setattr(get_settings(), "worker_queue_url", QUEUE)
    monkeypatch.setattr(httpx.AsyncClient, "post", broken_post)
    assert logged.post("/api/jobs", json=_job()).status_code == 201


def test_stuck_job_is_woken_again_at_most_every_5_min(logged, monkeypatch):
    from datetime import timedelta
    calls = _capture(monkeypatch)
    job = logged.post("/api/jobs", json=_job()).json()["job"]
    calls.clear()
    with db.get_engine().begin() as conn:
        conn.execute(db.jobs.update().where(db.jobs.c.id == job["id"]).values(created_at=db.now() - timedelta(minutes=10)))
    logged.get("/api/jobs")
    logged.get("/api/jobs")
    assert len(calls) == 1
