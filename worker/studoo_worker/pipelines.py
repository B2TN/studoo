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


def podcast(payload: dict, report) -> tuple[bytes, str, str, str, dict]:
    minutes = int(payload["options"].get("minutes", 10))
    mode = payload["options"].get("voice", "naturelle")
    parts_n = max(1, minutes // 10)  # le script est écrit par morceaux d'environ 10 minutes
    title, lines = "", []
    report(5, "Lecture de tes cours par l'IA")
    with LLM() as llm:
        for part in range(parts_n):
            report(8 + 30 * part / parts_n, f"Écriture du script ({part + 1}/{parts_n})")
            context = ""
            if lines:
                tail = "\n".join(f"{line['speaker']}: {line['text']}" for line in lines[-4:])
                context = (f"\nCeci est la SUITE du podcast (partie {part + 1} sur {parts_n}). Dernières répliques :\n{tail}\n"
                           "Continue sans refaire d'introduction ; aborde les notions suivantes du cours.\n")
            if part == parts_n - 1 and parts_n > 1:
                context += "C'est la DERNIÈRE partie : termine par un récapitulatif des points clés.\n"
            script = llm.json(
                "Écris le script d'un podcast éducatif à deux voix (A et B) qui explique ces cours.\n"
                f"Longueur de CETTE partie : environ 1 500 mots (10 minutes).{context}\n"
                "A et B sont deux élèves passionnés qui se relancent. Répliques de 1 à 4 phrases.\n\n"
                + sources_prompt(payload["sources"]),
                PodcastScript.model_json_schema(), max_tokens=5000, temperature=0.7)
            title = title or script["title"]
            lines += script["lines"]
    parts = []
    for i, line in enumerate(lines):
        parts += [tts.say(line["text"], line["speaker"], mode), tts.silence(0.35)]
        if i % 5 == 0:
            report(40 + 50 * i / max(1, len(lines)), f"Enregistrement des voix ({i + 1}/{len(lines)})")
    import numpy as np
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
                f"Écris EXACTEMENT {n} diapos. Narration d'environ {words_per_slide} mots par diapo ; "
                f"puces très courtes (5 mots max).{context}\n" + sources_prompt(payload["sources"]),
                VideoScript.model_json_schema(), max_tokens=400 + n * (words_per_slide * 2 + 120), temperature=0.6)
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
