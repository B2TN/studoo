"""Formes (schémas) des réponses demandées à Gemini.

Gemini doit répondre en JSON qui respecte exactement ces modèles :
le site peut ainsi les afficher sans deviner leur structure.
"""
from typing import Literal

from pydantic import BaseModel, Field


# ---------- Transcription ----------
class Segment(BaseModel):
    speaker: str = Field(description="Rôle de la personne : Professeur, Élève, Élève 2, Intervenant…")
    text: str


class Transcript(BaseModel):
    language: str = Field(description="Code langue principal, ex. fr, en, es")
    segments: list[Segment]


# ---------- Estimation du cours / titre ----------
class Classification(BaseModel):
    course: str = Field(description="Nom du cours (matière) le plus probable")
    chapter: str = Field(description="Nom du chapitre le plus probable")
    course_exists: bool
    chapter_exists: bool
    title: str = Field(description="Titre court et précis du document (max 80 caractères)")
    confidence: float = Field(ge=0, le=1)


# ---------- Fiche de révision ----------
BlockType = Literal["paragraph", "definition", "formula", "list", "example", "warning", "tip", "date"]
Color = Literal["yellow", "pink", "green", "blue", "orange", "lilac"]


class Block(BaseModel):
    type: BlockType
    title: str = ""
    text: str = ""
    items: list[str] = []


class Section(BaseModel):
    heading: str
    color: Color
    blocks: list[Block]


class QuizItem(BaseModel):
    question: str
    answer: str


class Fiche(BaseModel):
    title: str
    subtitle: str = ""
    sections: list[Section]
    key_points: list[str] = Field(description="3 à 7 points essentiels à retenir")
    mnemonic: str = Field(default="", description="Moyen mnémotechnique s'il y en a un pertinent, sinon vide")
    quiz: list[QuizItem] = Field(description="3 à 6 questions de vérification")


# ---------- Podcast ----------
class PodcastLine(BaseModel):
    speaker: Literal["A", "B"]
    text: str


class PodcastScript(BaseModel):
    title: str
    host_a: str = Field(description="Prénom de l'animatrice/animateur A")
    host_b: str = Field(description="Prénom de l'animatrice/animateur B")
    lines: list[PodcastLine]


# ---------- Vidéo ----------
Doodle = Literal[
    "idea", "book", "formula", "chart", "globe", "atom", "clock", "warning",
    "check", "question", "people", "arrow", "heart", "star", "flask", "pencil",
]


class Slide(BaseModel):
    title: str
    bullets: list[str] = Field(description="2 à 4 puces très courtes")
    doodle: Doodle
    narration: str = Field(description="Texte lu à voix haute pour cette diapo")


class VideoScript(BaseModel):
    title: str
    slides: list[Slide]


# ---------- Numérisation ----------
class OcrResult(BaseModel):
    text: str = Field(description="Texte complet de la ou des pages, en Markdown")
    language: str
