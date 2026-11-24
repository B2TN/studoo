"""Connexion avec Google (seul moyen de connexion).

Déroulé :
1. Le navigateur ouvre la fenêtre Google (bibliothèque GIS) et reçoit un *code*.
2. Il envoie ce code ici ; on l'échange contre des jetons avec notre secret.
3. On vérifie l'identité (id_token), on crée un cookie de session chiffré
   qui contient le *refresh token* (jamais exposé au JavaScript).
4. Le navigateur demande ensuite des jetons d'accès Drive courts via /token.
"""
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, insert, select, update

from .. import db
from ..config import get_settings
from ..deps import User, clear_session, current_user, read_session, write_session
from ..limits import client_ip, rate_limit

router = APIRouter(prefix="/api/auth", tags=["auth"])

TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"


class CodeIn(BaseModel):
    code: str = Field(min_length=10, max_length=2048)


def _verify_id_token(token: str) -> dict:
    # Import tardif : ces bibliothèques sont lourdes et ne servent qu'à la connexion.
    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token as google_id_token
    return google_id_token.verify_oauth2_token(
        token, google_requests.Request(), get_settings().google_client_id, clock_skew_in_seconds=10,
    )


def _upsert_user(sub: str, email: str, name: str) -> None:
    engine = db.get_engine()
    with engine.begin() as conn:
        exists = conn.execute(select(db.users.c.sub).where(db.users.c.sub == sub)).first()
        if exists:
            conn.execute(update(db.users).where(db.users.c.sub == sub)
                         .values(email=email, name=name, last_seen_at=db.now()))
        else:
            conn.execute(insert(db.users).values(sub=sub, email=email, name=name,
                                                 created_at=db.now(), last_seen_at=db.now()))


def _public_user(data: dict) -> dict:
    email = data.get("email", "")
    return {
        "sub": data["sub"], "email": email, "name": data.get("name", ""),
        "picture": data.get("picture", ""),
        "isAdmin": email.lower() in get_settings().admin_list,
    }


@router.post("/google")
async def login_google(body: CodeIn, request: Request, response: Response):
    rate_limit(f"login:{client_ip(request)}", limit=20, window_seconds=600)
    s = get_settings()
    async with httpx.AsyncClient(timeout=15) as client:
        res = await client.post(TOKEN_URL, data={
            "code": body.code, "client_id": s.google_client_id, "client_secret": s.google_client_secret,
            "redirect_uri": "postmessage", "grant_type": "authorization_code",
        })
    if res.status_code != 200:
        raise HTTPException(400, detail={"code": "google_exchange", "message": "La connexion Google a échoué. Réessaie."})
    tokens = res.json()
    if DRIVE_SCOPE not in tokens.get("scope", "").split():
        raise HTTPException(400, detail={
            "code": "drive_scope_missing",
            "message": "Studoo a besoin d'accéder à ses propres fichiers dans ton Drive pour ranger tes cours. Coche la case Google Drive.",
        })
    try:
        claims = _verify_id_token(tokens["id_token"])
    except (ValueError, KeyError):
        raise HTTPException(400, detail={"code": "bad_id_token", "message": "Identité Google invalide."})

    refresh = tokens.get("refresh_token")
    previous = read_session(request) or {}
    if not refresh and previous.get("sub") == claims["sub"]:
        refresh = previous.get("rt")
    if not refresh:
        # Google ne redonne le refresh token qu'au premier consentement :
        # le navigateur relance la connexion avec prompt=consent.
        raise HTTPException(409, detail={"code": "need_consent", "message": "Confirme l'accès une dernière fois."})

    session = {
        "sub": claims["sub"], "email": claims.get("email", ""), "name": claims.get("name", ""),
        "picture": claims.get("picture", ""), "rt": refresh,
    }
    _upsert_user(session["sub"], session["email"], session["name"])
    write_session(response, session)
    return {
        "user": _public_user(session),
        "accessToken": tokens.get("access_token"),
        "expiresIn": tokens.get("expires_in", 3599),
    }


@router.post("/dev-login")
async def dev_login(response: Response):
    """Connexion factice, uniquement en local, pour tester sans compte Google."""
    if not get_settings().dev_login_enabled:
        raise HTTPException(404)
    session = {"sub": "dev-user", "email": "dev@studoo.localhost", "name": "Léa Démo", "picture": "", "rt": "dev"}
    _upsert_user(session["sub"], session["email"], session["name"])
    write_session(response, session)
    return {"user": {**_public_user(session), "isAdmin": True}, "accessToken": "dev", "expiresIn": 3600}


@router.get("/me")
async def me(request: Request, response: Response):
    """Utilisateur connecté, ou `null` (pas d'erreur 401 : c'est un cas normal)."""
    session = read_session(request)
    if not session or "sub" not in session:
        if request.cookies:
            clear_session(response)  # cookie expiré ou invalide : on nettoie
        return {"user": None}
    user = current_user(request)
    data = {"sub": user.sub, "email": user.email, "name": user.name, "picture": user.picture}
    out = _public_user(data)
    if user.refresh_token == "dev":
        out["isAdmin"] = True
        out["dev"] = True
    return {"user": out}


@router.post("/token")
async def access_token(user: Annotated[User, Depends(current_user)], response: Response):
    """Donne un jeton d'accès Drive frais (valable ~1 h) au navigateur."""
    if user.refresh_token == "dev":
        return {"accessToken": "dev", "expiresIn": 3600}
    s = get_settings()
    async with httpx.AsyncClient(timeout=15) as client:
        res = await client.post(TOKEN_URL, data={
            "client_id": s.google_client_id, "client_secret": s.google_client_secret,
            "refresh_token": user.refresh_token, "grant_type": "refresh_token",
        })
    if res.status_code != 200:
        clear_session(response)
        raise HTTPException(401, detail={"code": "session_expired", "message": "Ta session a expiré, reconnecte-toi."})
    data = res.json()
    return {"accessToken": data["access_token"], "expiresIn": data.get("expires_in", 3599)}


@router.post("/logout")
async def logout(response: Response):
    clear_session(response)
    return {"ok": True}


@router.delete("/account")
async def delete_account(user: Annotated[User, Depends(current_user)], response: Response):
    """Droit à l'effacement (RGPD) : on révoque l'accès Google et on efface le compte.

    Les fichiers du Drive appartiennent à l'utilisateur et restent chez lui.
    """
    if user.refresh_token and user.refresh_token != "dev":
        async with httpx.AsyncClient(timeout=10) as client:
            try:
                await client.post(REVOKE_URL, data={"token": user.refresh_token})
            except httpx.HTTPError:
                pass
    with db.get_engine().begin() as conn:
        conn.execute(delete(db.users).where(db.users.c.sub == user.sub))
        conn.execute(delete(db.user_ai_usage).where(db.user_ai_usage.c.sub == user.sub))
        conn.execute(delete(db.jobs).where(db.jobs.c.sub == user.sub))
        conn.execute(delete(db.push_subscriptions).where(db.push_subscriptions.c.sub == user.sub))
    clear_session(response)
    return {"ok": True}
