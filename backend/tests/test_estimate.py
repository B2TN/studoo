from datetime import datetime, timedelta, timezone

from studoo.services import estimate

NOW = datetime(2026, 11, 26, 15, 0, tzinfo=timezone.utc)


def done(wait, work, size=10):
    created = NOW - timedelta(hours=1)
    started = created + timedelta(seconds=wait)
    return {"created_at": created, "started_at": started, "finished_at": started + timedelta(seconds=work), "size": size}


def test_priors_give_an_honest_range_for_a_new_podcast():
    m = estimate.model("podcast", [])
    eta = estimate.estimate({"status": "queued", "created_at": NOW, "size": 10}, m, NOW)
    assert 60 <= eta["low"] <= 120 and 150 <= eta["high"] <= 300 and eta["high"] > eta["low"]


def test_measured_history_replaces_the_priors():
    history = [done(30, 600 + 10 * i) for i in range(10)]  # le serveur met en réalité ≈ 10 min par podcast
    m = estimate.model("podcast", history)
    eta = estimate.estimate({"status": "queued", "created_at": NOW, "size": 10}, m, NOW)
    assert eta["low"] >= 600 and eta["high"] <= 900  # marge de +30 % : fourchette honnête


def test_running_job_uses_progress_and_says_when_late():
    m = estimate.model("podcast", [])
    started = NOW - timedelta(seconds=60)
    eta = estimate.estimate({"status": "running", "created_at": started, "started_at": started, "size": 10,
                             "progress": 50}, m, NOW)
    assert eta["late"] is False and 30 <= eta["low"] <= eta["high"]
    long_ago = NOW - timedelta(seconds=900)
    late = estimate.estimate({"status": "running", "created_at": long_ago, "started_at": long_ago, "size": 10,
                              "progress": 90}, m, NOW)
    assert late["late"] is True and 50 <= late["low"] <= late["high"] <= 200  # ≈ 10 % restant à la vitesse observée


def test_queue_position_adds_waiting_time():
    m = estimate.model("video", [])
    alone = estimate.estimate({"status": "queued", "created_at": NOW, "size": 2}, m, NOW)
    behind = estimate.estimate({"status": "queued", "created_at": NOW, "size": 2}, m, NOW, ahead=6)
    assert behind["ahead"] == 6 and behind["low"] > alone["low"]
