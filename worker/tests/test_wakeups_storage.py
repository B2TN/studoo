"""File de réveil Azure et place disque."""
import os

import httpx

from studoo_worker import settings, storage, wakeups

URL = "https://compte.queue.core.windows.net/studoo-jobs?sv=2024&sp=p&sig=abc"


def test_drain_deletes_every_message(monkeypatch):
    queue = [("id-1", "r+1/="), ("id-2", "r2")]
    deleted = []

    def handler(request: httpx.Request):
        assert request.url.host == "compte.queue.core.windows.net" and request.url.params["sig"] == "abc"
        if request.method == "GET":
            assert request.url.path == "/studoo-jobs/messages"
            body = "".join(f"<QueueMessage><MessageId>{i}</MessageId><InsertionTime>x</InsertionTime>"
                           f"<PopReceipt>{r}</PopReceipt></QueueMessage>" for i, r in queue)
            queue.clear()
            return httpx.Response(200, text=f"<QueueMessagesList>{body}</QueueMessagesList>")
        deleted.append((request.url.path, request.url.params["popreceipt"]))
        return httpx.Response(204)

    real = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    assert wakeups.drain(URL) == 2
    assert deleted == [("/studoo-jobs/messages/id-1", "r+1/="), ("/studoo-jobs/messages/id-2", "r2")]


def test_drain_without_queue_or_when_unreachable(monkeypatch):
    assert wakeups.drain("") == 0

    def broken(request):
        raise httpx.ConnectError("hors ligne")

    real = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(broken), **kw))
    assert wakeups.drain(URL) == 0  # pas d'exception : les tâches restent lues dans la base


def test_settings_load_online_without_session_secret(monkeypatch):
    # Sur Azure : APP_URL en https, pas de SESSION_SECRET → la config du site ne doit pas bloquer le worker.
    from studoo.config import get_settings

    assert os.environ["SESSION_SECRET"]  # posé par studoo_worker/__init__.py
    monkeypatch.setenv("APP_URL", "https://studoo.vercel.app")
    get_settings.cache_clear()
    try:
        assert not get_settings().is_local
    finally:
        get_settings.cache_clear()


def test_make_room_removes_other_big_models(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "MODELS_DIR", tmp_path)
    monkeypatch.setattr(storage, "BIG", 10)  # « gros » = plus de 10 octets, pour le test
    (tmp_path / "llm.gguf").write_bytes(b"x" * 100)
    (tmp_path / "hf").mkdir()
    (tmp_path / "hf" / "poids.safetensors").write_bytes(b"x" * 100)
    (tmp_path / "voix.onnx").write_bytes(b"x" * 5)
    storage.make_room(1e9, keep="hf")  # 1 000 000 Go : jamais assez de place → on efface
    assert not (tmp_path / "llm.gguf").exists()
    assert (tmp_path / "hf" / "poids.safetensors").exists() and (tmp_path / "voix.onnx").exists()
    storage.make_room(0, keep="hf")  # assez de place : rien n'est touché


def test_llm_start_failure_shows_the_cause(monkeypatch):
    # « python -m module_inexistant » s'arrête aussitôt en écrivant la cause : comme un llama-server qui plante.
    import sys

    import pytest

    from studoo_worker import llm

    monkeypatch.setattr(settings, "LLAMA_SERVER", sys.executable)
    monkeypatch.setattr(llm, "model_path", lambda: "module_inexistant_studoo")
    with pytest.raises(RuntimeError, match="n'a pas pu démarrer.*module_inexistant_studoo"):
        with llm.LLM(port=8099):
            pass
