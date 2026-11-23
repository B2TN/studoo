"""Emploi du temps : import par lien ou fichier .ics."""
from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .. import db
from ..deps import User, current_user
from ..limits import rate_limit
from ..services.ics import fetch_ics, normalize_url, parse_ics

router = APIRouter(prefix="/api/timetable", tags=["timetable"])
CurrentUser = Annotated[User, Depends(current_user)]


def _window(days_before: int, days_after: int):
    today = db.today()
    return today - timedelta(days=days_before), today + timedelta(days=days_after)


class UrlIn(BaseModel):
    url: str = Field(min_length=8, max_length=2000)
    days_before: int = Field(default=7, ge=0, le=60)
    days_after: int = Field(default=35, ge=1, le=200)


@router.post("/ics-url")
async def from_url(body: UrlIn, user: CurrentUser):
    rate_limit(f"ics:{user.sub}", limit=30, window_seconds=600)
    text = await fetch_ics(body.url)
    start, end = _window(body.days_before, body.days_after)
    return {**parse_ics(text, start, end), "url": normalize_url(body.url)}


class FileIn(BaseModel):
    content: str = Field(min_length=10, max_length=3_000_000)
    days_before: int = Field(default=7, ge=0, le=60)
    days_after: int = Field(default=35, ge=1, le=200)


@router.post("/ics-file")
async def from_file(body: FileIn, user: CurrentUser):
    rate_limit(f"ics:{user.sub}", limit=30, window_seconds=600)
    start, end = _window(body.days_before, body.days_after)
    return parse_ics(body.content, start, end)
