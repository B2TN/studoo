"""Réponses factices, utilisées pour les tests et la démo locale sans clé Gemini."""
import re


def silence_pcm(seconds: int, rate: int = 24000) -> bytes:
    return b"\x00\x00" * rate * max(1, seconds)


def _count(prompt: str, pattern: str, default: int) -> int:
    m = re.search(pattern, prompt)
    return int(m.group(1)) if m else default


def answer(key: str, prompt: str) -> dict:
    if key == "Transcript":
        return {"language": "fr", "segments": [
            {"speaker": "Professeur", "text": "Aujourd'hui on commence le chapitre sur les suites géométriques."},
            {"speaker": "Élève", "text": "C'est quoi la différence avec les suites arithmétiques ?"},
            {"speaker": "Professeur", "text": "Dans une suite géométrique, on multiplie toujours par le même nombre, la raison q."},
        ]}
    if key == "Classification":
        return {"course": "Mathématiques", "chapter": "Suites", "course_exists": True, "chapter_exists": False,
                "title": "Introduction aux suites géométriques", "confidence": 0.82}
    if key == "Fiche":
        return {
            "title": "Les suites géométriques", "subtitle": "Mathématiques · Suites",
            "sections": [
                {"heading": "Définition", "color": "yellow", "blocks": [
                    {"type": "definition", "title": "Suite géométrique",
                     "text": "Une suite où l'on passe d'un terme au suivant en multipliant par la raison q.", "items": []},
                    {"type": "formula", "title": "Relation de récurrence", "text": "u(n+1) = q × u(n)", "items": []},
                ]},
                {"heading": "À retenir", "color": "pink", "blocks": [
                    {"type": "list", "title": "", "text": "",
                     "items": ["Arithmétique : on ajoute", "Géométrique : on multiplie"]},
                    {"type": "warning", "title": "Piège", "text": "Ne pas confondre la raison q avec le premier terme.", "items": []},
                ]},
            ],
            "key_points": ["On multiplie par q à chaque étape", "u(n) = u(0) × q^n"],
            "mnemonic": "Géo comme « gros » : ça grossit vite en multipliant.",
            "quiz": [{"question": "Que fait-on pour passer d'un terme au suivant ?", "answer": "On multiplie par la raison q."}],
        }
    if key == "PodcastScript":
        minutes = _count(prompt, r"DURÉE CIBLE : (\d+)", 10)
        lines = []
        for i in range(max(6, minutes)):
            lines.append({"speaker": "A", "text": f"Point {i + 1} : dans le cours, une suite géométrique se construit en multipliant par la raison."})
            lines.append({"speaker": "B", "text": "Exactement, et c'est ce qui la distingue d'une suite arithmétique."})
        return {"title": "Les suites géométriques en 10 minutes", "host_a": "Léa", "host_b": "Hugo", "lines": lines}
    if key == "VideoScript":
        slides_n = _count(prompt, r"NOMBRE DE DIAPOS : (\d+)", 6)
        doodles = ["idea", "formula", "chart", "warning", "check", "star"]
        return {"title": "Les suites géométriques", "slides": [
            {"title": f"Étape {i + 1}", "bullets": ["On part d'un premier terme", "On multiplie par q"],
             "doodle": doodles[i % len(doodles)],
             "narration": "Dans ce cours, chaque terme s'obtient en multipliant le précédent par la raison."}
            for i in range(slides_n)
        ]}
    if key == "OcrResult":
        return {"language": "fr", "text": "# Chapitre 3 — Les suites\n\n**Définition** : une suite géométrique de raison q vérifie u(n+1) = q × u(n)."}
    raise KeyError(key)
