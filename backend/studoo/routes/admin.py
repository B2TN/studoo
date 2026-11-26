"""Pages admin et analytics (réservées aux e-mails listés dans ADMIN_EMAILS)."""
from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, desc, func, select, update

from .. import db
from ..deps import User, admin_user
from ..limits import quota_status

router = APIRouter(prefix="/api/admin", tags=["admin"])
Admin = Annotated[User, Depends(admin_user)]


@router.get("/overview")
async def overview(_: Admin):
    engine = db.get_engine()
    week_ago = db.now() - timedelta(days=7)
    with engine.connect() as conn:
        total_users = conn.execute(select(func.count()).select_from(db.users)).scalar_one()
        active = conn.execute(select(func.count()).select_from(db.users)
                              .where(db.users.c.last_seen_at >= week_ago)).scalar_one()
        gens = conn.execute(select(db.generations.c.kind, func.sum(db.generations.c.count))
                            .group_by(db.generations.c.kind)).all()
        unread = conn.execute(select(func.count()).select_from(db.messages)
                              .where(db.messages.c.handled.is_(False))).scalar_one()
    return {
        "users": total_users, "activeUsers7d": active,
        "generations": {k: int(v) for k, v in gens},
        "unreadMessages": unread, "quota": quota_status(),
    }


@router.get("/users")
async def list_users(_: Admin, page: int = Query(1, ge=1), size: int = Query(50, ge=1, le=200)):
    with db.get_engine().connect() as conn:
        rows = conn.execute(select(db.users).order_by(desc(db.users.c.last_seen_at))
                            .limit(size).offset((page - 1) * size)).mappings().all()
    return {"users": [
        {"sub": r["sub"], "email": r["email"], "name": r["name"],
         "createdAt": r["created_at"].isoformat(), "lastSeenAt": r["last_seen_at"].isoformat()}
        for r in rows
    ]}


@router.delete("/users/{sub}")
async def remove_user(sub: str, _: Admin):
    with db.get_engine().begin() as conn:
        res = conn.execute(delete(db.users).where(db.users.c.sub == sub))
    if res.rowcount == 0:
        raise HTTPException(404)
    return {"ok": True}


@router.get("/analytics")
async def analytics(_: Admin, days: int = Query(30, ge=1, le=365)):
    start = db.today() - timedelta(days=days - 1)
    with db.get_engine().connect() as conn:
        views = conn.execute(select(db.page_views.c.day, func.sum(db.page_views.c.count))
                             .where(db.page_views.c.day >= start).group_by(db.page_views.c.day)).all()
        uniq = conn.execute(select(db.visitors.c.day, func.count())
                            .where(db.visitors.c.day >= start).group_by(db.visitors.c.day)).all()
        top = conn.execute(select(db.page_views.c.path, func.sum(db.page_views.c.count).label("n"))
                           .where(db.page_views.c.day >= start).group_by(db.page_views.c.path)
                           .order_by(desc("n")).limit(10)).all()
        gens = conn.execute(select(db.generations.c.day, db.generations.c.kind, db.generations.c.count)
                            .where(db.generations.c.day >= start)).all()
    series = []
    v = {d: int(n) for d, n in views}
    u = {d: int(n) for d, n in uniq}
    g: dict = {}
    for d, kind, n in gens:
        g.setdefault(d, {})[kind] = n
    for i in range(days):
        d = start + timedelta(days=i)
        series.append({"day": d.isoformat(), "views": v.get(d, 0), "visitors": u.get(d, 0), "generations": g.get(d, {})})
    return {"series": series, "topPaths": [{"path": p, "views": int(n)} for p, n in top]}


@router.get("/messages")
async def list_messages(_: Admin):
    with db.get_engine().connect() as conn:
        rows = conn.execute(select(db.messages).order_by(desc(db.messages.c.created_at)).limit(100)).mappings().all()
    return {"messages": [
        {"id": r["id"], "createdAt": r["created_at"].isoformat(), "email": r["email"],
         "subject": r["subject"], "body": r["body"], "handled": r["handled"]}
        for r in rows
    ]}


@router.post("/messages/{msg_id}/handled")
async def mark_handled(msg_id: int, _: Admin):
    with db.get_engine().begin() as conn:
        conn.execute(update(db.messages).where(db.messages.c.id == msg_id).values(handled=True))
    return {"ok": True}


@router.get("/school-reports")
async def school_reports(_: Admin):
    """Établissements signalés (C4) : regroupés par établissement et logiciel, les plus demandés d'abord."""
    t = db.school_reports
    with db.get_engine().connect() as conn:
        rows = conn.execute(select(
            func.lower(t.c.establishment).label("key"), func.min(t.c.establishment).label("establishment"), t.c.software,
            func.count().label("n"),
            func.count(func.distinct(t.c.reporter)).label("people"), func.max(t.c.created_at).label("last"),
        ).group_by(func.lower(t.c.establishment), t.c.software).order_by(desc("n"), desc("last")).limit(200)).mappings().all()
        errors = conn.execute(select(func.lower(t.c.establishment).label("e"), t.c.software, t.c.error_code, func.count().label("n"))
                              .group_by(func.lower(t.c.establishment), t.c.software, t.c.error_code)).mappings().all()
    by = {}
    for e in errors:
        by.setdefault((e["e"], e["software"]), {})[e["error_code"]] = int(e["n"])
    return {"reports": [
        {"establishment": r["establishment"], "software": r["software"], "count": int(r["n"]), "people": int(r["people"]),
         "last": r["last"].isoformat() if r["last"] else None, "errors": by.get((r["key"], r["software"]), {})}
        for r in rows
    ]}
