"""Petite base de données : comptes, compteurs et messages.

Aucun contenu de cours n'est stocké ici (tout est sur le Drive de
l'utilisateur). On utilise SQLAlchemy « Core » : du SQL lisible, qui
fonctionne aussi bien avec SQLite (local) qu'avec Postgres (production).
"""
from datetime import date, datetime, timezone

from sqlalchemy import (
    Boolean, Column, Date, DateTime, Integer, MetaData, String, Table, Text,
    create_engine, insert, select, update,
)
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.pool import NullPool

from .config import get_settings

metadata = MetaData()

users = Table(
    "users", metadata,
    Column("sub", String(64), primary_key=True),  # identifiant Google
    Column("email", String(320), nullable=False),
    Column("name", String(200), nullable=False, default=""),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("last_seen_at", DateTime(timezone=True), nullable=False),
)

page_views = Table(
    "page_views", metadata,
    Column("day", Date, primary_key=True),
    Column("path", String(200), primary_key=True),
    Column("count", Integer, nullable=False, default=0),
)

visitors = Table(
    "visitors", metadata,
    Column("day", Date, primary_key=True),
    Column("hash", String(32), primary_key=True),
)

ai_usage = Table(
    "ai_usage", metadata,
    Column("day", Date, primary_key=True),
    Column("tier", String(16), primary_key=True),
    Column("count", Integer, nullable=False, default=0),
)

user_ai_usage = Table(
    "user_ai_usage", metadata,
    Column("day", Date, primary_key=True),
    Column("sub", String(64), primary_key=True),
    Column("count", Integer, nullable=False, default=0),
)

generations = Table(
    "generations", metadata,
    Column("day", Date, primary_key=True),
    Column("kind", String(32), primary_key=True),
    Column("count", Integer, nullable=False, default=0),
)

rate_limits = Table(
    "rate_limits", metadata,
    Column("key", String(128), primary_key=True),
    Column("window", Integer, primary_key=True),
    Column("count", Integer, nullable=False, default=0),
)

messages = Table(
    "messages", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("email", String(320), nullable=False),
    Column("subject", String(120), nullable=False),
    Column("body", Text, nullable=False),
    Column("handled", Boolean, nullable=False, default=False),
)

_engine: Engine | None = None


def get_engine() -> Engine:
    """Crée la connexion une seule fois par processus."""
    global _engine
    if _engine is None:
        url = get_settings().database_url
        if url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql+psycopg://", 1)
        elif url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+psycopg://", 1)
        kwargs = {"poolclass": NullPool} if url.startswith("postgresql") else {}
        _engine = create_engine(url, **kwargs)
        metadata.create_all(_engine)
    return _engine


def reset_engine() -> None:
    """Utilisé par les tests pour repartir d'une base vide."""
    global _engine
    if _engine is not None:
        _engine.dispose()
    _engine = None


def now() -> datetime:
    return datetime.now(timezone.utc)


def today() -> date:
    return now().date()


def increment(table: Table, keys: dict, amount: int = 1) -> int:
    """Ajoute `amount` au compteur identifié par `keys` (le crée si besoin).

    Retourne la nouvelle valeur.
    """
    engine = get_engine()
    cond = [table.c[k] == v for k, v in keys.items()]
    with engine.begin() as conn:
        res = conn.execute(update(table).where(*cond).values(count=table.c.count + amount))
        if res.rowcount == 0:
            try:
                with conn.begin_nested():
                    conn.execute(insert(table).values(**keys, count=amount))
            except IntegrityError:
                conn.execute(update(table).where(*cond).values(count=table.c.count + amount))
        return conn.execute(select(table.c.count).where(*cond)).scalar_one()


def read_count(table: Table, keys: dict) -> int:
    cond = [table.c[k] == v for k, v in keys.items()]
    with get_engine().connect() as conn:
        return conn.execute(select(table.c.count).where(*cond)).scalar() or 0
