"""Feuilles d'exercices (à partir des cours choisis) et correction d'une copie photographiée.

Types de feuilles (libellés compris des lycéens comme des étudiants, choisis en itération 2) :
- Exercices d'entraînement (= TD) ; Mise en pratique (= TP) ; Contrôle blanc (= DST) ; Questions flash (= QCM).
La longueur est fixée par le type ; la difficulté est au choix (ou progressive). Barème sur 20.

Correction : la photo de la copie est lue et corrigée par GPT-4.1 mini (Azure OpenAI), avec une tolérance souple
et des points partiels ; si aucune IA ne lit les images, le lecteur open source du serveur lit la copie puis
l'IA corrige le texte lu.
"""
import json
import logging
import re

from . import writer

log = logging.getLogger(__name__)

TYPES = {
    "entrainement": {"label": "Exercices d'entraînement", "short": "TD", "minutes": 45, "exercises": 6,
                     "brief": "6 exercices d'application, du plus simple au plus complet, chacun avec 1 à 3 questions."},
    "pratique": {"label": "Mise en pratique", "short": "TP", "minutes": 60, "exercises": 3,
                 "brief": "3 problèmes concrets (situation réelle, données chiffrées), chacun découpé en 3 à 5 étapes guidées."},
    "controle": {"label": "Contrôle blanc", "short": "DST", "minutes": 60, "exercises": 5,
                 "brief": "un sujet de contrôle de 5 exercices variés (questions de cours, applications, un exercice de "
                          "réflexion), comme un vrai devoir surveillé."},
    "flash": {"label": "Questions flash", "short": "QCM", "minutes": 10, "exercises": 1,
              "brief": "un seul exercice de 15 questions à choix multiples (4 propositions, une seule bonne réponse)."},
}
DIFFICULTY = {
    "facile": "facile : applications directes du cours",
    "moyen": "moyenne : il faut combiner deux notions",
    "difficile": "difficile : raisonnements en plusieurs étapes, pièges classiques",
    "progressif": "progressive : les premières questions sont faciles, les dernières difficiles",
}
TOTAL = 20

QUESTION = {
    "type": "object",
    "properties": {
        "label": {"type": "string", "description": "numéro affiché, ex. « 1 », « 2.a »"},
        "statement": {"type": "string"},
        "choices": {"type": "array", "items": {"type": "string"}, "description": "propositions d'un QCM, sinon vide"},
        "points": {"type": "number"},
        "answer": {"type": "string", "description": "corrigé détaillé, étape par étape"},
        "short_answer": {"type": "string", "description": "réponse attendue en une ligne (ou la lettre du QCM)"},
        "notion": {"type": "string", "description": "notion du cours travaillée"},
        "source": {"type": "integer", "description": "numéro du cours (1, 2…) d'où vient la notion"},
    },
    "required": ["label", "statement", "choices", "points", "answer", "short_answer", "notion", "source"],
}
SHEET_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "instructions": {"type": "string", "description": "consignes générales, 1 ou 2 phrases"},
        "exercises": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "intro": {"type": "string", "description": "énoncé commun (situation, données), peut être vide"},
                "questions": {"type": "array", "items": QUESTION, "minItems": 1},
            },
            "required": ["title", "intro", "questions"],
        }, "minItems": 1},
    },
    "required": ["title", "instructions", "exercises"],
}
CORRECTION_SCHEMA = {
    "type": "object",
    "properties": {
        "readable": {"type": "boolean", "description": "faux si la photo est illisible ou n'est pas cette copie"},
        "questions": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "label": {"type": "string"},
                "read_answer": {"type": "string", "description": "ce que l'élève a écrit (recopié), vide s'il n'a pas répondu"},
                "points_obtained": {"type": "number"},
                "verdict": {"type": "string", "enum": ["juste", "partiel", "faux", "absent"]},
                "errors": {"type": "array", "items": {"type": "string"}},
                "comment": {"type": "string", "description": "une phrase encourageante et utile"},
            },
            "required": ["label", "read_answer", "points_obtained", "verdict", "errors", "comment"],
        }},
        "to_review": {"type": "array", "items": {
            "type": "object",
            "properties": {"notion": {"type": "string"}, "why": {"type": "string"}, "source": {"type": "integer"}},
            "required": ["notion", "why", "source"],
        }},
        "general_comment": {"type": "string"},
    },
    "required": ["readable", "questions", "to_review", "general_comment"],
}


def _numbered_sources(sources: list[dict]) -> str:
    return "\n\n".join(f"=== COURS {i + 1} : {s['title']} ===\n{s['text']}" for i, s in enumerate(sources))


def _scale_points(exercises: list[dict]) -> None:
    """Ramène le barème à exactement 20 points (par demi-points)."""
    questions = [q for ex in exercises for q in ex["questions"]]
    raw = [max(0.5, float(q.get("points") or 1)) for q in questions]
    factor = TOTAL / sum(raw)
    scaled = [max(0.5, round(r * factor * 2) / 2) for r in raw]
    scaled[-1] = max(0.5, scaled[-1] + TOTAL - sum(scaled))  # l'arrondi est absorbé par la dernière question
    for q, pts in zip(questions, scaled):
        q["points"] = pts


def relabel(exercises: list[dict], qcm: bool = False) -> None:
    """Numéros UNIQUES (l'IA recommence souvent à « 1 » dans chaque exercice) : « 1 », « 2.a », « 2.b »…
    Pour des questions flash (un seul exercice), simplement 1 à 15."""
    letters = "abcdefghijklmnopqrstuvwxyz"
    for i, ex in enumerate(exercises, 1):
        qs = ex["questions"]
        for j, q in enumerate(qs):
            if qcm or len(exercises) == 1:
                q["label"] = str(j + 1)
            else:
                q["label"] = str(i) if len(qs) == 1 else f"{i}.{letters[j % 26]}"


def _clean_title(title: str, spec: dict) -> str:
    """« Contrôle blanc : Suites » → « Suites » (le type est déjà dans le nom du fichier)."""
    for word in (spec["label"], spec["short"]):
        if title.lower().startswith(word.lower()):
            title = title[len(word):].lstrip(" :—–-")
    return title.strip() or "Révision"


def sheet(payload: dict, report) -> tuple:
    opts = payload["options"]
    kind = opts.get("type", "entrainement")
    spec = TYPES.get(kind, TYPES["entrainement"])
    level = DIFFICULTY.get(opts.get("difficulty", "progressif"), DIFFICULTY["progressif"])
    sources = payload["sources"]
    report(10, "Écriture de la feuille par l'IA")
    doc = writer.write(
        _numbered_sources(sources) + "\n\n"
        f"Écris une feuille « {spec['label']} » ({spec['short']}) sur ces cours : {spec['brief']}\n"
        f"Durée pour l'élève : {spec['minutes']} minutes. Difficulté {level}.\n"
        "Règles : n'utilise QUE les notions de ces cours (aucune notion extérieure) ; énoncés clairs, adaptés à un "
        "lycéen comme à un étudiant ; chaque question a un barème (« points »), un corrigé détaillé et la réponse "
        "attendue en une ligne ; indique la notion travaillée et le numéro du cours d'où elle vient. "
        "Pour un QCM, mets 4 propositions dans « choices » et la lettre (A, B, C ou D) dans « short_answer » ; "
        "sinon « choices » est vide. Les réponses de l'élève seront écrites à la main sur papier.",
        SHEET_SCHEMA, gemini_key=payload.get("gemini_key", ""), max_tokens=9000, temperature=0.5)
    report(85, "Barème et corrigé")
    exercises = [ex for ex in doc["exercises"] if ex.get("questions")]
    if not exercises:
        raise writer.WriterError("L'IA n'a pas écrit d'exercice : réessaie avec d'autres cours.")
    relabel(exercises, qcm=kind == "flash")
    _scale_points(exercises)
    title = _clean_title(doc["title"], spec)
    refs = [{"id": s.get("id", ""), "title": s["title"], "chapter_id": s.get("chapter_id", "")} for s in sources]
    out = {
        "version": 1, "type": kind, "type_label": spec["label"], "type_short": spec["short"],
        "difficulty": opts.get("difficulty", "progressif"), "title": title, "instructions": doc["instructions"],
        "duration_minutes": spec["minutes"], "total": TOTAL, "exercises": exercises, "sources": refs,
    }
    name = f"{spec['label']} — {title}"[:110].replace("/", "-") + ".json"
    return (json.dumps(out, ensure_ascii=False).encode(), name, "application/json", "exercices",
            {"sheetType": kind, "total": str(TOTAL)})


def _sheet_for_grading(doc: dict) -> str:
    lines = [f"Feuille : {doc['title']} ({doc.get('type_label', '')}), notée sur {doc.get('total', TOTAL)}."]
    for ex in doc["exercises"]:
        lines.append(f"\n## {ex['title']}\n{ex.get('intro', '')}")
        for q in ex["questions"]:
            choices = " | ".join(q.get("choices") or [])
            lines.append(f"- Question {q['label']} ({q['points']} pts, notion : {q.get('notion', '')}, cours n°{q.get('source', 1)}) : "
                         f"{q['statement']}" + (f"\n  Propositions : {choices}" if choices else "")
                         + f"\n  Réponse attendue : {q['short_answer']}\n  Corrigé : {q['answer']}")
    return "\n".join(lines)


def _key(label: str) -> str:
    """« Question 2.a », « Q2a », « 2 a) » → « 2a » : l'IA ne recopie pas toujours le numéro à l'identique."""
    label = re.sub(r"^\s*(question|exercice|ex\.?|q)\s*", "", str(label).lower())
    return re.sub(r"[^0-9a-z]", "", label)


def _read_with_local_ocr(images: list[str], report) -> str:
    from . import ocr as ocr_engine  # lecteur open source (lent, seulement en secours)
    texts = []
    for i, img in enumerate(images):
        report(15 + 50 * i / len(images), f"Lecture de la copie (page {i + 1}/{len(images)})")
        texts.append(ocr_engine.read_page(img))
    return "\n\n---\n\n".join(texts)


def correct(payload: dict, report) -> tuple:
    doc = json.loads(payload["sources"][0]["text"])
    labels = [q["label"] for ex in doc["exercises"] for q in ex["questions"]]
    if len(set(labels)) != len(labels):  # ancienne feuille aux numéros en double
        relabel(doc["exercises"], qcm=doc.get("type") == "flash")
    images = payload["images"]
    rules = (
        "Corrige la copie d'un élève pour cette feuille d'exercices. Barème : celui de chaque question.\n"
        "Tolérance SOUPLE : accepte les formulations équivalentes, les fautes d'orthographe, les notations différentes "
        "et les arrondis raisonnables ; donne des points PARTIELS quand la démarche est juste mais le résultat faux, "
        "ou quand la réponse est incomplète. Une question sans réponse est « absent » (0 point).\n"
        "Pour chaque question (champ « label » = son numéro EXACT sur la feuille, par ex. « 2.a », sans le mot « Question ») : "
        "recopie la réponse lue, les points obtenus (jamais plus que le barème), le verdict, "
        "les erreurs précises (vide si tout est juste) et un commentaire court et bienveillant.\n"
        "Puis liste les notions du cours à revoir (avec le numéro du cours) et un commentaire général encourageant.\n"
        "Si la copie est illisible ou ne correspond pas à la feuille, mets readable = false.\n"
        "Écris erreurs, commentaires et notions à revoir en TUTOYANT l'élève (« tu as… », « revois… »).\n\n"
        + _sheet_for_grading(doc)
    )
    report(15, "Lecture et correction de ta copie")
    read_by = "ia"
    try:
        result = writer.write(rules + "\n\nLa copie de l'élève est sur les photos jointes.", CORRECTION_SCHEMA,
                              images=images, max_tokens=6000, temperature=0.2)
    except Exception as exc:  # noqa: BLE001 - aucune IA ne lit les images : lecteur local puis correction du texte
        log.warning("Correction sur photo impossible (%s) : lecteur local", type(exc).__name__)
        text = _read_with_local_ocr(images, report)
        read_by = "lecteur local"
        report(70, "Correction de ta copie")
        result = writer.write(rules + "\n\nTexte lu sur la copie (lecture automatique, peut contenir des erreurs) :\n"
                              + text, CORRECTION_SCHEMA, max_tokens=6000, temperature=0.2)
    report(90, "Calcul de la note")
    by_label = {q["label"]: q for ex in doc["exercises"] for q in ex["questions"]}
    by_key = {_key(label): label for label in by_label}
    questions = []
    for q in result["questions"]:
        label = by_key.get(_key(q.get("label", "")))
        if not label or label in {x["label"] for x in questions}:
            continue
        q["label"] = label
        expected = by_label[label]
        q["points_max"] = expected["points"]
        q["points_obtained"] = max(0.0, min(float(q.get("points_obtained") or 0), float(expected["points"])))
        questions.append(q)
    seen = {q["label"] for q in questions}
    for label, expected in by_label.items():  # question oubliée par l'IA : comptée absente, jamais inventée
        if label not in seen:
            questions.append({"label": label, "read_answer": "", "points_obtained": 0.0, "points_max": expected["points"],
                              "verdict": "absent", "errors": [], "comment": "Pas de réponse trouvée sur la copie."})
    order = list(by_label)
    questions.sort(key=lambda q: order.index(q["label"]))
    total = float(doc.get("total", TOTAL))
    grade = round(sum(q["points_obtained"] for q in questions) * 2) / 2
    sources = doc.get("sources", [])
    review = []
    for r in result["to_review"]:
        ref = sources[r["source"] - 1] if 1 <= int(r.get("source") or 0) <= len(sources) else {}
        review.append({"notion": r["notion"], "why": r["why"], "source_id": ref.get("id", ""),
                       "source_title": ref.get("title", ""), "chapter_id": ref.get("chapter_id", "")})
    out = {
        "version": 1, "sheet_id": payload["options"].get("sheet_id", ""), "sheet_title": doc["title"],
        "readable": bool(result.get("readable", True)), "grade": grade, "total": total, "questions": questions,
        "to_review": review, "general_comment": result.get("general_comment", ""), "read_by": read_by,
    }
    name = f"Correction — {doc['title']}"[:110].replace("/", "-") + ".json"
    return (json.dumps(out, ensure_ascii=False).encode(), name, "application/json", "correction",
            {"sheetId": out["sheet_id"], "grade": f"{grade:g}/{total:g}"})
