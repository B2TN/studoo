"""Feuilles d'exercices et correction de copie (itération 2, construites en itération 4)."""
import json

from studoo_worker import exercises, pipelines, settings, writer

SOURCES = [{"title": "Suites", "text": "Une suite géométrique…", "id": "f1", "chapter_id": "c1"},
           {"title": "Limites", "text": "La limite d'une suite…", "id": "f2", "chapter_id": "c2"}]


def fake_sheet():
    q = lambda label, pts, src: {"label": label, "statement": "Calcule u3.", "choices": [], "points": pts,  # noqa: E731
                                 "answer": "u3 = 8", "short_answer": "8", "notion": "suite géométrique", "source": src}
    return {"title": "Suites et limites", "instructions": "Justifie tes réponses.",
            "exercises": [{"title": "Exercice 1", "intro": "", "questions": [q("1.a", 3, 1), q("1.b", 4, 1)]},
                          {"title": "Exercice 2", "intro": "u0 = 1", "questions": [q("2", 6, 2)]}]}


def test_sheet_is_built_from_the_courses_with_a_barème_on_20(monkeypatch):
    seen = {}

    def write(prompt, schema, **kw):
        seen["prompt"] = prompt
        return fake_sheet()

    monkeypatch.setattr(writer, "write", write)
    data, name, mime, kind, props = exercises.sheet(
        {"sources": SOURCES, "options": {"type": "controle", "difficulty": "progressif"}}, lambda p, s: None)
    doc = json.loads(data)
    assert kind == "exercices" and name == "Contrôle blanc — Suites et limites.json" and props["sheetType"] == "controle"
    assert "COURS 1 : Suites" in seen["prompt"] and "QUE les notions de ces cours" in seen["prompt"]
    points = [q["points"] for ex in doc["exercises"] for q in ex["questions"]]
    assert sum(points) == 20 and all(p >= 0.5 for p in points)
    assert doc["type_label"] == "Contrôle blanc" and doc["sources"][1] == {"id": "f2", "title": "Limites", "chapter_id": "c2"}
    assert [q["label"] for ex in doc["exercises"] for q in ex["questions"]] == ["1.a", "1.b", "2"]


def test_question_numbers_are_unique_and_title_not_repeated(monkeypatch):
    raw = fake_sheet()
    raw["title"] = "Contrôle blanc : Suites"
    for ex in raw["exercises"]:
        for q in ex["questions"]:
            q["label"] = "1"  # l'IA recommence à 1 dans chaque exercice
    monkeypatch.setattr(writer, "write", lambda *a, **k: raw)
    data, name, *_ = exercises.sheet({"sources": SOURCES, "options": {"type": "controle"}}, lambda p, s: None)
    doc = json.loads(data)
    assert name == "Contrôle blanc — Suites.json" and doc["title"] == "Suites"
    assert [q["label"] for ex in doc["exercises"] for q in ex["questions"]] == ["1.a", "1.b", "2"]


def test_correction_reads_the_photo_with_gpt_and_grades_softly(monkeypatch):
    monkeypatch.setattr(writer, "write", lambda *a, **k: fake_sheet())
    data, *_ = exercises.sheet({"sources": SOURCES, "options": {}}, lambda p, s: None)
    sheet_doc = json.loads(data)
    calls = []

    def write(prompt, schema, **kw):
        calls.append(kw.get("images"))
        assert "Tolérance SOUPLE" in prompt and "Réponse attendue : 8" in prompt
        return {"readable": True, "general_comment": "Bon travail !",
                "questions": [
                    {"label": "1.a", "read_answer": "8", "points_obtained": 5, "verdict": "juste", "errors": [], "comment": "Bravo"},
                    {"label": "Question 2", "read_answer": "u = 2", "points_obtained": 2, "verdict": "partiel",
                     "errors": ["Résultat faux"], "comment": "La démarche est bonne"}],
                "to_review": [{"notion": "limite d'une suite", "why": "confusion", "source": 2}]}

    monkeypatch.setattr(writer, "write", write)
    data, name, mime, kind, props = exercises.correct(
        {"sources": [{"title": "Feuille", "text": json.dumps(sheet_doc)}], "images": ["aW1n"],
         "options": {"sheet_id": "s1"}}, lambda p, s: None)
    doc = json.loads(data)
    assert calls == [["aW1n"]] and kind == "correction" and props["sheetId"] == "s1"
    by = {q["label"]: q for q in doc["questions"]}
    pts = {label: q["points"] for ex in sheet_doc["exercises"] for q in ex["questions"] for label in [q["label"]]}
    assert by["1.a"]["points_obtained"] == pts["1.a"]  # jamais plus que le barème
    assert by["1.b"]["verdict"] == "absent" and by["1.b"]["points_obtained"] == 0  # oubliée par l'IA : absente
    assert doc["grade"] == pts["1.a"] + 2 and doc["total"] == 20
    assert doc["to_review"][0]["source_id"] == "f2" and doc["to_review"][0]["chapter_id"] == "c2"


def test_correction_falls_back_to_the_local_reader_without_vision(monkeypatch):
    monkeypatch.setattr(writer, "write", lambda *a, **k: fake_sheet())
    data, *_ = exercises.sheet({"sources": SOURCES, "options": {}}, lambda p, s: None)

    def write(prompt, schema, **kw):
        if kw.get("images"):
            raise writer.WriterError("pas de vision")
        assert "Texte lu sur la copie" in prompt and "u3 = 8" in prompt
        return {"readable": True, "general_comment": "", "questions": [], "to_review": []}

    monkeypatch.setattr(writer, "write", write)
    monkeypatch.setattr(exercises, "_read_with_local_ocr", lambda images, report: "u3 = 8")
    data, *_ = exercises.correct({"sources": [{"title": "F", "text": data.decode()}], "images": ["x"], "options": {}},
                                 lambda p, s: None)
    doc = json.loads(data)
    assert doc["read_by"] == "lecteur local" and doc["grade"] == 0 and len(doc["questions"]) == 3


def test_photos_only_go_to_a_vision_model(monkeypatch):
    monkeypatch.setattr(settings, "AZURE_OPENAI_KEY", "")
    monkeypatch.setattr(settings, "GROQ_API_KEY", "gk")
    assert writer._providers(images=True) == []  # gpt-oss (Groq) ne lit pas les images
    assert [p["name"] for p in writer._providers()] == ["Groq"]
    assert "exercices" in pipelines.PIPELINES and "correction" in pipelines.PIPELINES
