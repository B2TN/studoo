"""Dépendances communes : utilisateur connecté, admin, protection CSRF."""
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request, Response

from .config import get_settings
from .security import decrypt_json, encrypt_json

SESSION_COOKIE = "studoo_session"
FLAG_COOKIE = "studoo_in"  # simple indicateur lisible par JS (aucune donnée)
SESSION_MAX_AGE = 60 * 60 * 24 * 30  # 30 jours


@dataclass
class User:
    sub: str
    email: str
    name: str
    picture: str
    refresh_token: str

    @property
    def is_admin(self) -> bool:
        return self.email.lower() in get_settings().admin_list


def read_session(request: Request) -> dict | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    return decrypt_json(token, max_age=SESSION_MAX_AGE)


def write_session(response: Response, data: dict) -> None:
    secure = get_settings().secure_cookies
    response.set_cookie(
        SESSION_COOKIE, encrypt_json(data), max_age=SESSION_MAX_AGE,
        httponly=True, secure=secure, samesite="lax", path="/",
    )
    response.set_cookie(FLAG_COOKIE, "1", max_age=SESSION_MAX_AGE, secure=secure, samesite="lax", path="/")


def clear_session(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(FLAG_COOKIE, path="/")


def current_user(request: Request) -> User:
    data = read_session(request)
    if not data or "sub" not in data:
        raise HTTPException(401, detail={"code": "not_logged_in", "message": "Connecte-toi pour continuer."})
    # Le cookie seul ne suffit pas : le compte doit toujours exister (pas supprimé par l'admin) et ne pas être banni.
    from .services import accounts
    accounts.guard_session(request, data["sub"])
    return User(
        sub=data["sub"], email=data.get("email", ""), name=data.get("name", ""),
        picture=data.get("picture", ""), refresh_token=data.get("rt", ""),
    )


def admin_user(user: User = Depends(current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(403, detail={"code": "forbidden", "message": "Accès réservé."})
    return user


async def csrf_guard(request: Request) -> None:
    """Exige l'en-tête `X-Studoo: 1` sur les requêtes qui modifient quelque chose.

    Un site pirate ne peut pas ajouter cet en-tête à une requête vers notre
    domaine (le navigateur bloquerait la requête), ce qui empêche les
    attaques CSRF en plus du cookie SameSite=Lax.
    """
    if request.method not in {"GET", "HEAD", "OPTIONS"} and request.headers.get("x-studoo") != "1":
        raise HTTPException(403, detail={"code": "csrf", "message": "Requête refusée."})
