"""Routes IA : transcription, estimation du cours, fiches, podcasts, vidéos, OCR.

Le contenu des cours ne fait que *transiter* ici : il est envoyé à Gemini
puis oublié. Rien n'est écrit sur disque ni en base.
"""
import base64
import binascii
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, field_validator, model_validator

from ..deps import User, current_user
from ..config import get_settings
from ..limits import consume, count_generation, quota_status, rate_limit
from ..services import gemini, speech
from ..services.schemas import Classification, Fiche, OcrResult, PodcastScript, Transcript, VideoScript

router = APIRouter(prefix="/api/ai", tags=["ai"])
CurrentUser = Annotated[User, Depends(current_user)]

MAX_AUDIO_BYTES = 4 * 1024 * 1024
MIN_AUDIO_BYTES = 800  # en dessous : enregistrement vide (en-tête seul)
AUDIO_TYPES = {"audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/aac"}
MAX_SOURCES_CHARS = 400_000


class SourceDoc(BaseModel):
    title: str = Field(max_length=200)
    text: str = Field(min_length=1, max_length=200_000)


class SourcesIn(BaseModel):
    sources: list[SourceDoc] = Field(min_length=1, max_length=30)
    course: str = Field(default="", max_length=120)
    chapter: str = Field(default="", max_length=120)

    @model_validator(mode="after")
    def total_size(self):
        if sum(len(s.text) for s in self.sources) > MAX_SOURCES_CHARS:
            raise ValueError("Trop de texte : sélectionne moins de cours à la fois.")
        return self

    def as_prompt(self) -> str:
        docs = "\n\n".join(f"### Document {i + 1} : {s.title}\n{s.text}" for i, s in enumerate(self.sources))
        return f"DOCUMENTS DE COURS (seule source autorisée) :\n\n{docs}"


@router.get("/quota")
async def quota(user: CurrentUser):
    return quota_status(user.sub)


@router.post("/transcribe", response_model=Transcript)
async def transcribe(
    request: Request, user: CurrentUser,
    index: int = Query(0, ge=0, le=60),
    prev: str = Query("", max_length=600),
):
    """Transcrit une tranche d'audio (≈5 min) avec les rôles des intervenants.

    L'audio est lu en mémoire (jamais écrit sur disque), envoyé à Gemini,
    puis supprimé dès la réponse reçue.
    """
    rate_limit(f"transcribe:{user.sub}", limit=30, window_seconds=600)
    mime = (request.headers.get("content-type") or "").split(";")[0].strip()
    if mime not in AUDIO_TYPES:
        raise HTTPException(415, detail={"code": "bad_audio", "message": "Format audio non pris en charge."})
    length = int(request.headers.get("content-length") or 0)
    if length > MAX_AUDIO_BYTES:
        raise HTTPException(413, detail={"code": "too_big", "message": "Morceau audio trop gros."})
    audio = await request.body()
    if len(audio) < MIN_AUDIO_BYTES:
        raise HTTPException(422, detail={"code": "empty_audio", "message": "L'enregistrement reçu est vide : le micro n'a rien envoyé."})
    if len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(413, detail={"code": "too_big", "message": "Morceau audio trop gros."})
    s = get_settings()
    if s.speech_key:  # Azure AI Speech (voir services/speech.py)
        consume("lite", user.sub)  # même compteur d'usage que les autres IA
        try:
            result = await speech.transcribe(audio, mime, key=s.speech_key, region=s.speech_region)
        finally:
            del audio  # on oublie l'audio immédiatement, même en cas d'échec
        if index == 0:
            count_generation("transcription")
        return result
    if not s.ai_fake_enabled and not s.gemini_api_key:
        del audio
        raise HTTPException(503, detail={"code": "stt_unconfigured",
                                         "message": "La transcription n'est pas encore configurée sur ce site (service de transcription absent)."})
    prompt = (
        "Transcris fidèlement cet extrait de cours enregistré en classe.\n"
        "- Détecte qui parle et indique son RÔLE (pas son nom) : « Professeur », « Élève », "
        "« Élève 2 », « Intervenant »… Garde les mêmes étiquettes pour les mêmes voix.\n"
        "- Regroupe les phrases d'une même personne dans un seul segment.\n"
        "- Supprime les hésitations (euh, hum) mais ne résume pas.\n"
        "- Si un passage est inaudible, écris [inaudible].\n"
        "- Écris dans la langue parlée (le cours peut être en anglais, espagnol…).\n"
    )
    if prev:
        prompt += f"\nFin de l'extrait précédent, pour garder la cohérence des rôles :\n{prev}\n"
    try:
        result = await gemini.generate_json(
            tier="lite", sub=user.sub, schema=Transcript, prompt=prompt,
            media=[(audio, mime)], temperature=0.1,
        )
    finally:
        del audio  # on oublie l'audio immédiatement
    if index == 0:
        count_generation("transcription")
    return result


class TreeCourse(BaseModel):
    course: str = Field(max_length=120)
    chapters: list[str] = Field(default=[], max_length=60)


class ClassifyIn(BaseModel):
    excerpt: str = Field(min_length=1, max_length=8000)
    kind: Literal["transcript", "scan", "pdf"] = "transcript"
    tree: list[TreeCourse] = Field(default=[], max_length=80)
    hint: str = Field(default="", max_length=200)


@router.post("/classify", response_model=Classification)
async def classify(body: ClassifyIn, user: CurrentUser):
    """Devine le cours et le chapitre, et propose un titre automatique."""
    rate_limit(f"classify:{user.sub}", limit=30, window_seconds=600)
    tree = "\n".join(f"- {c.course} : {', '.join(c.chapters) or '(aucun chapitre)'}" for c in body.tree) or "(aucun cours)"
    prompt = (
        f"Voici un extrait d'un document de cours ({body.kind}).\n"
        f"Cours et chapitres existants de l'élève :\n{tree}\n"
        + (f"Indice de l'emploi du temps : au moment de l'enregistrement, l'élève avait « {body.hint} ».\n" if body.hint else "")
        + "Choisis le cours existant le plus probable (ou propose un nouveau nom court s'il n'existe pas), "
        "le chapitre le plus probable (ou un nouveau nom court), et un titre précis pour ce document. "
        "Utilise exactement l'orthographe des noms existants quand tu les choisis.\n\n"
        f"EXTRAIT :\n{body.excerpt}"
    )
    return await gemini.generate_json(tier="lite", sub=user.sub, schema=Classification, prompt=prompt, temperature=0.2)


@router.post("/fiche", response_model=Fiche)
async def fiche(body: SourcesIn, user: CurrentUser):
    rate_limit(f"gen:{user.sub}", limit=10, window_seconds=600)
    prompt = (
        "Crée une fiche de révision claire et visuelle à partir des documents ci-dessous.\n"
        f"Cours : {body.course or 'non précisé'} · Chapitre : {body.chapter or 'non précisé'}.\n"
        "- 2 à 6 sections, chacune avec une couleur de surligneur différente.\n"
        "- Utilise les types de blocs : définition, formule, liste, exemple, attention (warning), astuce (tip), date.\n"
        "- Phrases courtes, vocabulaire du cours, rien d'inventé.\n"
        "- Quiz : questions dont la réponse est dans les documents.\n\n"
        + body.as_prompt()
    )
    tier = gemini.pick_text_tier("flash")
    result = await gemini.generate_json(tier=tier, sub=user.sub, schema=Fiche, prompt=prompt, system=gemini.GROUNDING_RULE)
    count_generation("fiche")
    return result


class PodcastIn(SourcesIn):
    minutes: Literal[10, 20, 30] = 10


@router.post("/podcast", response_model=PodcastScript)
async def podcast(body: PodcastIn, user: CurrentUser):
    rate_limit(f"gen:{user.sub}", limit=10, window_seconds=600)
    words = body.minutes * 150
    prompt = (
        "Écris le script d'un podcast éducatif à deux voix (A et B) qui explique ces cours.\n"
        f"DURÉE CIBLE : {body.minutes} minutes, soit environ {words} mots au total.\n"
        "- A et B sont deux élèves passionnés qui se relancent et se posent des questions.\n"
        "- Ton vivant et naturel, exemples tirés UNIQUEMENT des documents.\n"
        "- Une introduction, les notions dans l'ordre logique, un récapitulatif final.\n"
        "- Répliques de 1 à 4 phrases.\n\n"
        + body.as_prompt()
    )
    tier = gemini.pick_text_tier("flash")
    result = await gemini.generate_json(tier=tier, sub=user.sub, schema=PodcastScript, prompt=prompt,
                                        system=gemini.GROUNDING_RULE, temperature=0.7)
    count_generation("podcast")
    return result


class VideoIn(SourcesIn):
    format: Literal["short", "medium", "long"] = "short"


VIDEO_FORMATS = {"short": (2, 6), "medium": (10, 20), "long": (30, 48)}


@router.post("/video", response_model=VideoScript)
async def video(body: VideoIn, user: CurrentUser):
    rate_limit(f"gen:{user.sub}", limit=10, window_seconds=600)
    minutes, slides = VIDEO_FORMATS[body.format]
    prompt = (
        "Prépare une vidéo explicative sous forme de diaporama dessiné à la main.\n"
        f"DURÉE CIBLE : {minutes} minutes. NOMBRE DE DIAPOS : {slides}.\n"
        f"- Narration totale d'environ {minutes * 150} mots, répartie entre les diapos.\n"
        "- Puces très courtes (5 mots max), un pictogramme (doodle) adapté par diapo.\n"
        + ("- Format vertical type TikTok : accroche dès la première diapo, rythme rapide.\n" if body.format == "short" else "")
        + "- Contenu UNIQUEMENT issu des documents.\n\n"
        + body.as_prompt()
    )
    tier = gemini.pick_text_tier("flash")
    result = await gemini.generate_json(tier=tier, sub=user.sub, schema=VideoScript, prompt=prompt,
                                        system=gemini.GROUNDING_RULE, temperature=0.6)
    count_generation("video")
    return result


class TtsLine(BaseModel):
    speaker: Literal["A", "B", "N"]
    text: str = Field(min_length=1, max_length=1200)


class TtsIn(BaseModel):
    lines: list[TtsLine] = Field(min_length=1, max_length=20)
    voices: dict[str, str] = {}

    @model_validator(mode="after")
    def total(self):
        if sum(len(line.text) for line in self.lines) > 1400:
            raise ValueError("Segment trop long pour la synthèse vocale.")
        return self

    @field_validator("voices")
    @classmethod
    def clean_voices(cls, v: dict[str, str]) -> dict[str, str]:
        allowed = {"Kore", "Puck", "Charon", "Aoede", "Fenrir", "Leda", "Orus", "Zephyr"}
        return {k: val for k, val in v.items() if k in {"A", "B", "N"} and val in allowed}


@router.post("/tts")
async def tts(body: TtsIn, user: CurrentUser):
    """Renvoie l'audio brut (PCM 16 bits mono) d'un segment d'environ une minute."""
    rate_limit(f"tts:{user.sub}", limit=40, window_seconds=600)
    voices = {"A": "Kore", "B": "Puck", "N": "Kore", **body.voices}
    pcm, rate = await gemini.synthesize(sub=user.sub, lines=[(l.speaker, l.text) for l in body.lines], voices=voices)
    return Response(content=pcm, media_type="application/octet-stream", headers={"X-Sample-Rate": str(rate)})


class OcrImage(BaseModel):
    data: str = Field(max_length=900_000)  # base64 (≈ 650 Ko)
    mime: Literal["image/jpeg", "image/png", "image/webp"] = "image/jpeg"


class OcrIn(BaseModel):
    images: list[OcrImage] = Field(min_length=1, max_length=8)


@router.post("/ocr", response_model=OcrResult)
async def ocr(body: OcrIn, user: CurrentUser):
    """Lit le texte de pages de cours photographiées (pour les fiches et le classement)."""
    rate_limit(f"ocr:{user.sub}", limit=15, window_seconds=600)
    media = []
    for img in body.images:
        try:
            media.append((base64.b64decode(img.data, validate=True), img.mime))
        except (binascii.Error, ValueError):
            raise HTTPException(422, detail={"code": "bad_image", "message": "Image illisible."})
    prompt = (
        "Recopie fidèlement tout le texte de ces pages de cours (manuscrites ou imprimées), dans l'ordre, "
        "en Markdown : titres, listes, formules (en texte simple). Décris brièvement les schémas entre crochets. "
        "N'ajoute rien qui n'est pas écrit."
    )
    result = await gemini.generate_json(tier="lite", sub=user.sub, schema=OcrResult, prompt=prompt, media=media, temperature=0.1)
    count_generation("scan")
    return result
