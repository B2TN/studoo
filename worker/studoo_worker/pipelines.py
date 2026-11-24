"""Les traitements eux-mêmes : podcast, vidéo, fiche, lecture de copie (OCR)."""
import json
import re

from studoo.services.schemas import Fiche, PodcastScript, VideoScript

from . import drive, media, tts
from .llm import LLM, sources_prompt


class Cancelled(Exception):
    pass


def _safe(name: str, max_len: int = 80) -> str:
    return re.sub(r"[\\/:*?\"<>|\n\r]+", " ", name).strip()[:max_len] or "Sans titre"


def _podcast_schema(min_lines: int) -> dict:
    """Schéma du script avec un nombre minimal de répliques : les petits modèles écrivent sinon trop court."""
    schema = PodcastScript.model_json_schema()
    schema["properties"]["lines"]["minItems"] = min_lines
    return schema


def _video_schema(n: int, min_chars: int) -> dict:
    """Schéma avec exactement n diapos et une narration d'au moins min_chars caractères."""
    schema = VideoScript.model_json_schema()
    schema["properties"]["slides"].update(minItems=n, maxItems=n)
    schema["$defs"]["Slide"]["properties"]["narration"]["minLength"] = min_chars
    return schema


def podcast(payload: dict, report) -> tuple[bytes, str, str, str, dict]:
    import numpy as np
    minutes = int(payload["options"].get("minutes", 10))
    mode = payload["options"].get("voice", "naturelle")
    target = minutes * 60  # secondes visées
    # Le script est écrit par morceaux de 10 min au plus, et les voix enregistrées au fur et à mesure :
    # on continue tant que la durée RÉELLE n'atteint pas la cible (les petits modèles écrivent trop court).
    max_parts = max(1, minutes // 10) + max(1, minutes // 20)
    title, lines, parts, seconds, recap_done = "", [], [], 0.0, False
    report(5, "Lecture de tes cours par l'IA")
    with LLM() as llm:
        for part in range(max_parts):
            if seconds >= 0.92 * target:
                break
            remaining = min(10.0, max(2.0, (target - seconds) / 60))
            words = int(remaining * 150)
            report(5 + 87 * seconds / target, f"Écriture du script (partie {part + 1})")
            context = ""
            if lines:
                tail = "\n".join(f"{line['speaker']}: {line['text']}" for line in lines[-4:])
                context = (f"\nCeci est la SUITE du podcast. Dernières répliques :\n{tail}\n"
                           "Continue sans refaire d'introduction ni de salutations.\n")
            if recap_done:
                context += ("Le récapitulatif est déjà fait : ajoute un BONUS d'exercices d'application "
                            "corrigés pas à pas, puis une phrase de fin.\n")
            elif (target - seconds) / 60 <= 10:
                context += ("Termine par un récapitulatif des points clés.\n" if not lines else
                            "C'est la fin du podcast : termine par un récapitulatif des points clés.\n")
                recap_done = True
            else:
                context += "Aborde les notions suivantes du cours.\n"
            script = llm.json(
                "Écris le script d'un podcast éducatif à deux voix (A et B) qui explique ces cours.\n"
                f"Longueur de CETTE partie : environ {words} mots ({remaining:.0f} minutes), "
                f"au moins {max(8, words // 35)} répliques.{context}\n"
                "A et B sont deux élèves passionnés qui se relancent, donnent des exemples chiffrés, "
                "posent des questions et reformulent. Répliques de 2 à 4 phrases.\n\n"
                + sources_prompt(payload["sources"]),
                _podcast_schema(max(8, words // 35)), max_tokens=5000, temperature=0.7)
            title = title or re.sub(r"\s*[–—:-]\s*(la )?(dernière|première) partie\s*$", "", script["title"], flags=re.I)
            new = script["lines"]
            lines += new
            for i, line in enumerate(new):
                clip = tts.say(line["text"], line["speaker"], mode)
                parts += [clip, tts.silence(0.35)]
                seconds += len(clip) / tts.RATE + 0.35
                if i % 5 == 0:
                    report(min(91, 5 + 87 * seconds / target), f"Enregistrement des voix ({len(lines) - len(new) + i + 1} répliques)")
    audio = np.concatenate(parts) if parts else tts.silence(1)
    report(92, "Fabrication du MP3")
    data = media.mp3(audio)
    return data, f"Podcast — {_safe(title)}.mp3", "audio/mpeg", "podcast", {"minutes": str(round(len(audio) / tts.RATE / 60))}


def video(payload: dict, report) -> tuple[bytes, str, str, str, dict]:
    fmt = payload["options"].get("format", "short")
    minutes, slides_n = {"short": (2, 6), "medium": (10, 20), "long": (30, 48)}[fmt]
    mode = payload["options"].get("voice", "naturelle")
    words_per_slide = minutes * 150 // slides_n
    batch = 8  # diapos écrites par paquets, pour rester dans la mémoire du modèle
    title, slides = "", []
    report(5, "Lecture de tes cours par l'IA")
    with LLM() as llm:
        while len(slides) < slides_n:
            n = min(batch, slides_n - len(slides))
            report(8 + 27 * len(slides) / slides_n, f"Écriture des diapos ({len(slides) + 1}-{len(slides) + n} sur {slides_n})")
            done = "; ".join(s["title"] for s in slides)
            context = f"\nDiapos déjà écrites : {done}. Écris les {n} SUIVANTES, sans répéter.\n" if slides else ""
            if len(slides) + n >= slides_n:
                context += "La dernière diapo est un récapitulatif.\n"
            script = llm.json(
                "Prépare une vidéo explicative sous forme de diaporama dessiné à la main.\n"
                f"Écris EXACTEMENT {n} diapos. Narration d'environ {words_per_slide} mots par diapo "
                f"(plusieurs phrases complètes, avec un exemple) ; puces très courtes (5 mots max).{context}\n"
                + sources_prompt(payload["sources"]),
                _video_schema(n, words_per_slide * 5), max_tokens=400 + n * (words_per_slide * 2 + 120), temperature=0.6)
            title = title or script["title"]
            new = script["slides"][:n]
            if not new:
                break
            slides += new
    audios = []
    for i, s in enumerate(slides):
        audios.append(tts.say(s["narration"], "A", mode))
        report(35 + 40 * (i + 1) / len(slides), f"Voix de la diapo {i + 1}/{len(slides)}")
    report(78, "Dessin et montage de la vidéo")
    data = media.mp4(slides, audios, fmt, on_progress=lambda p: report(78 + 18 * p, "Dessin et montage de la vidéo"))
    return data, f"Vidéo — {_safe(title)}.mp4", "video/mp4", "video", {"format": fmt, "voice": "open-source"}


def fiche(payload: dict, report) -> tuple[bytes, str, str, str, dict]:
    report(5, "Lecture de tes cours par l'IA")
    with LLM() as llm:
        report(15, "Écriture de la fiche")
        result = llm.json(
            "Crée une fiche de révision claire et visuelle : 2 à 6 sections (couleurs de surligneur différentes), "
            "définitions, formules, listes, exemples, pièges (warning), astuces (tip), et un mini-quiz.\n"
            f"Cours : {payload.get('course') or 'non précisé'} · Chapitre : {payload.get('chapter') or 'non précisé'}.\n\n"
            + sources_prompt(payload["sources"]), Fiche.model_json_schema(), max_tokens=4000, temperature=0.4)
    data = json.dumps(result, ensure_ascii=False, indent=2).encode()
    return data, f"Fiche — {_safe(result['title'], 70)}.json", "application/json", "fiche", {}


def ocr(payload: dict, report) -> tuple[bytes, str, str, str, dict]:
    from . import ocr as ocr_engine
    pages = payload["images"]
    texts = []
    for i, img in enumerate(pages):
        report(5 + 85 * i / len(pages), f"Lecture de la page {i + 1}/{len(pages)}")
        texts.append(ocr_engine.read_page(img))
    title = _safe(payload["options"].get("title") or "Texte lu", 70)
    body = f"# {title}\n\n" + "\n\n---\n\n".join(texts)
    return body.encode(), f"{title} (texte).md", "text/markdown", "scan-text", {}


PIPELINES = {"podcast": podcast, "video": video, "fiche": fiche, "ocr": ocr}


def run(job: dict, payload: dict, report) -> tuple[str, str]:
    """Exécute la tâche puis range le résultat dans le Drive ; renvoie (id du fichier, nom)."""
    data, name, mime, kind, props = PIPELINES[job["kind"]](payload, report)
    report(97, "Rangement dans ton Google Drive")
    token = drive.access_token(payload["refresh_token"])
    saved = drive.upload(token, folder_id=payload["folder_id"], name=name, mime=mime, data=data, kind=kind, props=props)
    pdf_id = payload["options"].get("pdf_id")
    if job["kind"] == "ocr" and pdf_id:
        drive.set_props(token, pdf_id, {"textId": saved["id"]})  # relie le texte lu au PDF numérisé
    return saved["id"], saved.get("name", name)
