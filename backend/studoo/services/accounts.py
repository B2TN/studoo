"""Comptes : vérification de la session, effacement complet, bannissements, journal admin (itération 7, C3).

Limites, dites honnêtement (reprises dans l'interface admin, la page RGPD et les CGU) :
- une adresse IP est souvent PARTAGÉE (lycée, université, wifi public, réseau mobile) : la bannir peut bloquer des
  innocents. Le bannissement d'IP est donc toujours TEMPORAIRE (30 jours au plus), même si le reste est définitif ;
- l'« appareil » est un identifiant au hasard gardé par le navigateur : vider les données du site, changer de
  navigateur ou passer en navigation privée suffit à le contourner. C'est un frein, jamais une garantie ;
- le compte Google et l'adresse e-mail sont la protection la plus solide contre la réinscription.
Vie privée : on ne garde que des EMPREINTES chiffrées (HMAC avec une clé secrète du serveur), jamais une IP, un
identifiant d'appareil ou une adresse e-mail en clair. Les fichiers du Drive de l'utilisateur ne sont jamais touchés.
"""
import hashlib
import hmac
import time
from datetime import datetime, timedelta

from fastapi import HTTPException, Request
from sqlalchemy import delete, insert, or_, select, update

from .. import db
from ..config import get_settings
from ..limits import client_ip

IP_MAX_DAYS = 30          # une IP partagée ne reste jamais bloquée plus d'un mois
DEFAULT_DAYS = 30         # durée proposée par défaut dans l'admin
CACHE_SECONDS = 60        # vérification de la session : au plus une lecture de la base par minute et par compte
DEVICE_HEADER = "x-studoo-device"
_cache: dict[tuple, tuple[float, object]] = {}


def anon(kind: str, value: str) -> str:
    """Empreinte non réversible sans la clé secrète du serveur."""
    secret = get_settings().session_secret.encode()
    return hmac.new(secret, f"ban|{kind}|{value.strip().lower()}".encode(), hashlib.sha256).hexdigest()[:48]


def mask_email(email: str) -> str:
    """« marie.dupont@gmail.com » → « m•••@gmail.com » (pour s'y retrouver dans l'admin, sans l'adresse)."""
    local, _, domain = email.partition("@")
    return f"{local[:1]}•••@{domain}"[:120] if domain else "compte"


def fingerprints(request: Request) -> dict:
    """Empreintes de la requête : IP et appareil (si le navigateur a envoyé son identifiant)."""
    device = (request.headers.get(DEVICE_HEADER) or "").strip()
    return {"ip": anon("ip", client_ip(request)), "device": anon("device", device) if 16 <= len(device) <= 64 else ""}


def active_ban(*, sub: str = "", email: str = "", ip: str = "", device: str = "") -> dict | None:
    """Bannissement en cours qui touche ce compte, cette adresse e-mail, cette IP ou cet appareil (empreintes)."""
    wanted = [("account", anon("account", sub) if sub else ""), ("email", anon("email", email) if email else ""),
              ("ip", ip), ("device", device)]
    conds = [(db.bans.c.kind == k) & (db.bans.c.value_hash == v) for k, v in wanted if v]
    if not conds:
        return None
    now = db.now()
    with db.get_engine().connect() as conn:
        row = conn.execute(select(db.bans).where(or_(*conds), db.bans.c.lifted_at.is_(None),
                                                 or_(db.bans.c.expires_at.is_(None), db.bans.c.expires_at > now))
                           .order_by(db.bans.c.expires_at.desc().nulls_first()).limit(1)).mappings().first()
    return dict(row) if row else None


def banned_error(ban: dict) -> HTTPException:
    until = ban.get("expires_at")
    when = f" jusqu'au {until:%d/%m/%Y}" if isinstance(until, datetime) else ""
    return HTTPException(403, detail={"code": "banned", "message": f"L'accès à Studoo a été bloqué{when} à la suite d'un abus. "
                                                                   "Si tu penses que c'est une erreur, écris-nous via la page contact."})


def check_login(request: Request, sub: str, email: str) -> dict:
    """Avant d'ouvrir une session : refuse un compte, une adresse, une IP ou un appareil bannis."""
    fp = fingerprints(request)
    ban = active_ban(sub=sub, email=email, ip=fp["ip"], device=fp["device"])
    if ban:
        raise banned_error(ban)
    return fp


def guard_session(request: Request, sub: str) -> None:
    """À chaque requête connectée : le compte existe toujours (pas supprimé par l'admin) et n'est pas banni.
    Résultat gardé une minute par serveur, pour ne pas interroger la base à chaque requête."""
    fp = fingerprints(request)
    key = (sub, fp["ip"], fp["device"])
    now = time.monotonic()
    hit = _cache.get(key)
    if hit and now - hit[0] < CACHE_SECONDS:
        verdict = hit[1]
    else:
        with db.get_engine().connect() as conn:
            row = conn.execute(select(db.users.c.email).where(db.users.c.sub == sub)).first()
        verdict = "gone" if row is None else (active_ban(sub=sub, email=row.email, ip=fp["ip"], device=fp["device"]) or "ok")
        if len(_cache) > 5000:
            _cache.clear()
        _cache[key] = (now, verdict)
    if verdict == "gone":
        raise HTTPException(401, detail={"code": "account_deleted", "message": "Ce compte n'existe plus. Reconnecte-toi pour en créer un nouveau."})
    if verdict != "ok":
        raise banned_error(verdict)


def forget_cache(sub: str | None = None) -> None:
    """Oublie les vérifications gardées (toutes, ou celles d'un compte qui vient de se reconnecter)."""
    if sub is None:
        _cache.clear()
        return
    for key in [k for k in _cache if k[0] == sub]:
        _cache.pop(key, None)


def remember_fingerprints(sub: str, fp: dict) -> None:
    forget_cache(sub)
    values = {"last_ip_hash": fp["ip"]}
    if fp.get("device"):
        values["last_device_hash"] = fp["device"]
    with db.get_engine().begin() as conn:
        conn.execute(update(db.users).where(db.users.c.sub == sub).values(**values))


def erase(conn, sub: str) -> None:
    """Efface TOUT ce que Studoo garde sur ce compte (jamais le Drive de l'utilisateur)."""
    for table in (db.user_ai_usage, db.jobs, db.push_subscriptions, db.user_keys):
        conn.execute(delete(table).where(table.c.sub == sub))
    conn.execute(delete(db.users).where(db.users.c.sub == sub))


def log(conn, admin: str, action: str, target: str = "", details: str = "", reason: str = "") -> None:
    conn.execute(insert(db.admin_log).values(created_at=db.now(), admin=admin[:320], action=action[:40],
                                             target=target[:120], details=details[:500], reason=reason[:300]))


def remove_user(sub: str, *, admin: str, mode: str, days: int | None, reason: str = "") -> dict:
    """Supprime le compte ; mode « ban » : bloque aussi le compte Google, l'adresse e-mail, la dernière IP et l'appareil."""
    with db.get_engine().begin() as conn:
        row = conn.execute(select(db.users).where(db.users.c.sub == sub)).mappings().first()
        if row is None:
            raise HTTPException(404, detail={"code": "not_found", "message": "Compte introuvable."})
        if row["email"].lower() in get_settings().admin_list:
            raise HTTPException(422, detail={"code": "is_admin", "message": "Impossible de supprimer ou bannir un compte administrateur."})
        label = mask_email(row["email"])
        created = []
        if mode == "ban":
            now = db.now()
            until = now + timedelta(days=days) if days else None
            ip_until = now + timedelta(days=min(days or IP_MAX_DAYS, IP_MAX_DAYS))
            items = [("account", anon("account", sub), until), ("email", anon("email", row["email"]), until)]
            if row.get("last_ip_hash"):
                items.append(("ip", row["last_ip_hash"], ip_until))
            if row.get("last_device_hash"):
                items.append(("device", row["last_device_hash"], until))
            for kind, value, end in items:
                conn.execute(insert(db.bans).values(created_at=now, expires_at=end, kind=kind, value_hash=value,
                                                    label=label, reason=reason[:300], admin=admin))
                created.append(kind)
        erase(conn, sub)
        duration = "définitif" if not days else f"{days} jours"
        log(conn, admin, "ban" if mode == "ban" else "delete_user", label,
            f"bloqués : {', '.join(created)} ; durée : {duration} (IP : {min(days or IP_MAX_DAYS, IP_MAX_DAYS)} jours max)"
            if mode == "ban" else "compte et données Studoo effacés (Drive non touché)", reason)
    forget_cache()
    return {"ok": True, "mode": mode, "blocked": created}


def lift(ban_id: int, admin: str, reason: str = "") -> None:
    with db.get_engine().begin() as conn:
        row = conn.execute(select(db.bans).where(db.bans.c.id == ban_id)).mappings().first()
        if row is None:
            raise HTTPException(404, detail={"code": "not_found", "message": "Bannissement introuvable."})
        # On lève tous les blocages posés en même temps pour la même personne (même libellé, même date).
        conn.execute(update(db.bans).where(db.bans.c.label == row["label"], db.bans.c.created_at == row["created_at"],
                                           db.bans.c.lifted_at.is_(None)).values(lifted_at=db.now()))
        log(conn, admin, "unban", row["label"], "bannissement levé", reason)
    forget_cache()


def purge(conn) -> None:
    """Durées annoncées : bannissements terminés gardés 30 jours, journal admin 12 mois."""
    limit = db.now() - timedelta(days=30)
    conn.execute(delete(db.bans).where(or_(db.bans.c.lifted_at < limit, db.bans.c.expires_at < limit)))
    conn.execute(delete(db.admin_log).where(db.admin_log.c.created_at < db.now() - timedelta(days=365)))
