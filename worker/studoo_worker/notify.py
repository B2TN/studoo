"""Prévenir l'élève quand sa génération est prête.

1. Notification web (PWA) sur chacun de ses appareils abonnés ;
2. sinon, e-mail de secours (Brevo, si configuré) ;
3. dans tous les cas, la tâche apparaît « Terminée » sur le tableau de bord.
"""
import json

import httpx
from sqlalchemy import delete, select, update

from studoo import db

from . import settings

LABELS = {"podcast": "Ton podcast", "video": "Ta vidéo", "fiche": "Ta fiche", "ocr": "La lecture de ta copie"}


def _push(sub: str, title: str, body: str, url: str) -> int:
    if not settings.VAPID_PRIVATE_KEY:
        return 0
    from pywebpush import WebPushException, webpush
    sent = 0
    with db.get_engine().connect() as conn:
        subs = conn.execute(select(db.push_subscriptions).where(db.push_subscriptions.c.sub == sub)).mappings().all()
    for s in subs:
        try:
            webpush(subscription_info={"endpoint": s["endpoint"], "keys": {"p256dh": s["p256dh"], "auth": s["auth"]}},
                    data=json.dumps({"title": title, "body": body, "url": url}),
                    vapid_private_key=settings.VAPID_PRIVATE_KEY, vapid_claims={"sub": settings.VAPID_SUBJECT}, ttl=86400)
            sent += 1
        except WebPushException as exc:
            if exc.response is not None and exc.response.status_code in (404, 410):  # abonnement expiré
                with db.get_engine().begin() as conn:
                    conn.execute(delete(db.push_subscriptions).where(db.push_subscriptions.c.endpoint == s["endpoint"]))
    return sent


def _email(to: str, title: str, body: str, url: str) -> bool:
    if not (settings.BREVO_API_KEY and settings.MAIL_FROM and to):
        return False
    res = httpx.post("https://api.brevo.com/v3/smtp/email", headers={"api-key": settings.BREVO_API_KEY}, json={
        "sender": {"name": "Studoo", "email": settings.MAIL_FROM}, "to": [{"email": to}], "subject": title,
        "htmlContent": f"<p>{body}</p><p><a href=\"{url}\">Ouvrir Studoo</a></p>"
                       "<p style=\"color:#777;font-size:12px\">Tu reçois ce message car tu as lancé une génération sur Studoo.</p>",
    }, timeout=20)
    return res.status_code < 300


def job_finished(job: dict, email: str, ok: bool, file_id: str = "") -> None:
    label = LABELS.get(job["kind"], "Ta génération")
    title = f"{label} est prêt{'e' if job['kind'] in {'video', 'fiche', 'ocr'} else ''} !" if ok else f"{label} a échoué"
    body = f"« {job['title']} » est rangé dans ton Google Drive." if ok else "Ouvre Studoo pour relancer la génération."
    url = f"{settings.APP_URL}/fichier/{file_id}" if ok and file_id else f"{settings.APP_URL}/"
    sent = _push(job["sub"], title, body, url)
    if not sent:
        _email(email, title, body, url)
    with db.get_engine().begin() as conn:
        conn.execute(update(db.jobs).where(db.jobs.c.id == job["id"]).values(notified=True))
