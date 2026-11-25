"""Les traitements eux-mêmes : podcast, vidéo, fiche, lecture de copie (OCR)."""
import json
import re

from studoo.services.schemas import Fiche, PodcastScript, VideoScript

from . import drive, media, voices, writer
from .llm import sources_prompt


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


def podcast(payload: dict, report) -> tuple:
    minutes = int(payload["options"].get("minutes", 10))
    voice = payload["options"].get("voice", voices.DEFAULT)
    key = payload.get("gemini_key", "")
    target = minutes * 60
    parts = max(1, minutes // 10)  # une partie de script par tranche de 10 min (≈ 1 500 mots)
    title, lines = "", []
    for part in range(parts):
        report(5 + 40 * part / parts, f"Écriture du script par l'IA ({part + 1}/{parts})" if parts > 1 else "Écriture du script par l'IA")
        context = ""
        if lines:
            tail = "\n".join(f"{line['speaker']}: {line['text']}" for line in lines[-4:])
            context = f"Ceci est la SUITE du podcast. Dernières répliques :\n{tail}\nContinue sans refaire d'introduction ni de salutations.\n"
        if parts > 1:
            context += f"Partie {part + 1} sur {parts} : traite la {'première' if part == 0 else 'suite de la'} partie des notions du cours, dans l'ordre.\n"
        context += ("Termine par un récapitulatif des points clés et une phrase de fin.\n" if part == parts - 1
                    else "Ne conclus pas encore : la suite arrive.\n")
        # Les cours d'abord (identiques à chaque partie), puis la consigne.
        script = writer.write(
            sources_prompt(payload["sources"]) + "\n\n"
            "Écris le script d'un podcast éducatif à deux voix (A et B) qui explique ces cours.\n"
            f"Longueur de cette partie : environ 1 500 mots (10 minutes à l'oral), au moins 30 répliques.\n{context}"
            "A et B sont deux élèves passionnés et complices : ils se relancent, posent des questions, donnent des "
            "exemples concrets et chiffrés, reformulent les notions difficiles, avec un ton naturel et vivant "
            "(« Attends, tu veux dire que… ? », « Exactement ! »). Répliques de 1 à 4 phrases, faciles à dire à voix haute : "
            "écris les nombres, symboles et formules en toutes lettres comme on les prononce.",
            _podcast_schema(30), gemini_key=key, max_tokens=9000, temperature=0.7)
        title = title or re.sub(r"\s*[–—:-]\s*(la )?(dernière|première) partie\s*$", "", script["title"], flags=re.I)
        lines += script["lines"]
    report(50, "Enregistrement des voix")
    audio = voices.synthesize([(line["speaker"], line["text"]) for line in lines], option=voice, gemini_key=key)
    missing = target - media.seconds(audio)
    if missing > 0.15 * target:  # trop court : un bonus d'exercices corrigés, une seule fois
        report(75, "Écriture d'un bonus d'exercices")
        tail = "\n".join(f"{line['speaker']}: {line['text']}" for line in lines[-3:])
        bonus = writer.write(
            sources_prompt(payload["sources"]) + "\n\n"
            f"Voici la fin d'un podcast à deux voix (A et B) sur ces cours :\n{tail}\n"
            f"Écris un BONUS d'environ {int(missing / 60 * 150)} mots : des exercices d'application corrigés pas à pas, "
            "même ton naturel, puis une phrase de fin. Écris les nombres et formules comme on les prononce.",
            _podcast_schema(6), gemini_key=key, max_tokens=6000, temperature=0.7)
        report(85, "Enregistrement des voix du bonus")
        extra = voices.synthesize([(x["speaker"], x["text"]) for x in bonus["lines"]], option=voice, gemini_key=key)
        audio = media.join_mp3([audio, extra])
    report(95, "Finitions")
    return audio, f"Podcast — {_safe(title)}.mp3", "audio/mpeg", "podcast", {"minutes": str(round(media.seconds(audio) / 60))}


def video(payload: dict, report) -> tuple:
    """Vidéo « animée dans le navigateur » : script des diapos (JSON) + voix (MP3) avec le moment de chaque diapo.

    Le navigateur anime les diapos en suivant la voix (et peut en faire un MP4) : rien à monter sur le serveur.
    """
    fmt = payload["options"].get("format", "short")
    minutes, slides_n = {"short": (2, 6), "medium": (10, 20), "long": (30, 48)}[fmt]
    voice = payload["options"].get("voice", voices.DEFAULT)
    key = payload.get("gemini_key", "")
    words_per_slide = minutes * 150 // slides_n
    batch = 12
    title, slides = "", []
    while len(slides) < slides_n:
        n = min(batch, slides_n - len(slides))
        report(5 + 40 * len(slides) / slides_n, f"Écriture des diapos ({len(slides) + 1}-{len(slides) + n} sur {slides_n})")
        done = "; ".join(s["title"] for s in slides)
        context = f"\nDiapos déjà écrites : {done}. Écris les {n} SUIVANTES, sans répéter.\n" if slides else "\n"
        if len(slides) + n >= slides_n:
            context += "La dernière diapo est un récapitulatif.\n"
        script = writer.write(
            sources_prompt(payload["sources"]) + "\n\n"
            "Prépare une vidéo explicative sous forme de diaporama dessiné à la main, commentée par une voix chaleureuse.\n"
            f"Écris EXACTEMENT {n} diapos. Narration d'environ {words_per_slide} mots par diapo : phrases complètes, "
            "ton vivant de prof sympa, avec un exemple concret ; écris les nombres et formules comme on les prononce. "
            f"Puces très courtes (5 mots max), dans l'ordre où la narration les aborde.{context}",
            _video_schema(n, words_per_slide * 4), gemini_key=key, max_tokens=400 + n * (words_per_slide * 3 + 150), temperature=0.6)
        title = title or script["title"]
        new = script["slides"][:n]
        if not new:
            break
        slides += new
    report(50, "Enregistrement de la voix")
    clips = voices.synthesize_groups([[("A", s["narration"])] for s in slides], option=voice, gemini_key=key)
    report(85, "Calage des diapos sur la voix")
    gap = media.silence_mp3(0.7)
    chunks, t = [], 0.0
    for slide, clip in zip(slides, clips):
        slide["start"], slide["end"] = round(t, 2), round(t + media.seconds(clip), 2)
        chunks += [clip, gap]
        t = slide["end"] + media.seconds(gap)
    audio = media.join_mp3(chunks)
    doc = {"version": 1, "title": title, "format": fmt, "voice": voice, "duration": round(t, 2), "slides": slides}
    data = json.dumps(doc, ensure_ascii=False).encode()
    props = {"format": fmt, "minutes": str(max(1, round(t / 60)))}
    return data, f"Vidéo — {_safe(title)}.json", "application/json", "video-anim", props, audio


def fiche(payload: dict, report) -> tuple:
    report(10, "Écriture de la fiche par l'IA")
    result = writer.write(
        sources_prompt(payload["sources"]) + "\n\n"
        "Crée une fiche de révision claire et visuelle : 2 à 6 sections (couleurs de surligneur différentes), "
        "définitions, formules, listes, exemples, pièges (warning), astuces (tip), et un mini-quiz.\n"
        f"Cours : {payload.get('course') or 'non précisé'} · Chapitre : {payload.get('chapter') or 'non précisé'}.",
        Fiche.model_json_schema(), gemini_key=payload.get("gemini_key", ""), max_tokens=5000, temperature=0.4)
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
    data, name, mime, kind, props, *extra = PIPELINES[job["kind"]](payload, report)
    report(97, "Rangement dans ton Google Drive")
    token = drive.access_token(payload["refresh_token"])
    if extra and extra[0]:  # vidéo : la voix est un fichier à part (caché), relié au script des diapos
        audio = drive.upload(token, folder_id=payload["folder_id"], name=name.rsplit(".", 1)[0] + " (voix).mp3",
                             mime="audio/mpeg", data=extra[0], kind="video-audio")
        props = {**props, "audioId": audio["id"]}
    saved = drive.upload(token, folder_id=payload["folder_id"], name=name, mime=mime, data=data, kind=kind, props=props)
    pdf_id = payload["options"].get("pdf_id")
    if job["kind"] == "ocr" and pdf_id:
        drive.set_props(token, pdf_id, {"textId": saved["id"]})  # relie le texte lu au PDF numérisé
    return saved["id"], saved.get("name", name)
