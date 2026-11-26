"""Robot HyperPlanning (Index Éducation) — EXPÉRIMENTAL.

⚠️ Construit sans compte de test. Ce qui est sûr (documentation d'Index Éducation, projets publics) : un
étudiant peut obtenir, dans HyperPlanning, une ADRESSE iCal personnelle qui se met à jour toute seule, de la
forme `https://<hôte>/hp/Telechargements/ical/Edt_<nom>.ics?version=…&idICal=…&param=…`. Ce qui est supposé :
la façon de la demander une fois connecté. HyperPlanning utilise le même moteur web que Pronote (même
éditeur) ; le robot réutilise donc la bibliothèque pronotepy (MIT) pour ouvrir la session chiffrée, puis
demande les paramètres iCal comme Pronote le fait (`PageInfosPerso` → `paramICal`, `paramSuppl`).
Testé uniquement sur des données d'exemple (backend/tests/fixtures/hyperplanning).

Ordre d'essai, en s'arrêtant au premier qui donne un VRAI calendrier (BEGIN:VCALENDAR) :
1. une adresse iCal déjà présente dans les pages vues après la connexion ;
2. les paramètres iCal demandés au serveur HyperPlanning (session pronotepy).
Le lien trouvé est vérifié en le lisant ; il est ensuite gardé chiffré dans le Drive de l'élève (sans mot de passe).
"""
import logging
import re
from urllib.parse import urlparse

import httpx

from . import ade, robot_errors

SERVICE = "HyperPlanning"
log = logging.getLogger("studoo.hyperplanning")
ICAL_RE = re.compile(r"""(?:https?://[^\s"'<>\\]+)?/(?:[\w-]+/)*Telechargements/ical/[^\s"'<>\\]+?\.ics\?[^\s"'<>\\]+""", re.I)
ESPACES = ("etudiant", "etudiant.html")  # adresse de l'espace étudiant, selon les installations


def find_ical(page: str, base: str) -> str | None:
    """Adresse iCal d'HyperPlanning écrite dans une page (lien « Exporter au format iCal », script…)."""
    m = ICAL_RE.search(page.replace("\\/", "/").replace("&amp;", "&"))
    if not m:
        return None
    url = m.group(0)
    if url.startswith("/"):
        url = f"{base}{url}"
    return url if urlparse(url).scheme == "https" else None


def espace_url(base: str) -> str:
    """https://hp.univ-x.fr → https://hp.univ-x.fr/hp/etudiant (l'espace étudiant)."""
    root = base.rstrip("/")
    return f"{root}/etudiant" if root.endswith("/hp") else f"{root}/hp/etudiant"


def ical_candidates(root: str, version: str, param_ical: str, param_suppl: str) -> list[str]:
    """Adresses iCal possibles à partir des paramètres donnés par le serveur (format HyperPlanning, puis Pronote)."""
    return [
        f"{root}/Telechargements/ical/Edt.ics?version={version}&idICal={param_ical}&param={param_suppl}",
        f"{root}/ical/Edt.ics?icalsecurise={param_ical}&version={version}&param={param_suppl}",
    ]


def _protocol_ical(url: str, username: str, password: str, cookies=None) -> tuple[str, list[str]]:
    """Session Index Éducation (pronotepy) → (racine, adresses iCal candidates). Lève une erreur claire sinon."""
    import pronotepy  # import tardif : bibliothèque lourde

    ent = (lambda u, p, **kw: cookies) if cookies is not None else None
    try:
        client = pronotepy.ClientBase(url, username=username, password=password, ent=ent)
    except pronotepy.CryptoError:
        raise robot_errors.bad_credentials(SERVICE) from None
    except (pronotepy.ENTLoginError, pronotepy.PronoteAPIError):
        raise robot_errors.page_changed(SERVICE) from None
    if not getattr(client, "logged_in", False):
        raise robot_errors.bad_credentials(SERVICE)
    root = client.communication.root_site
    general = client.func_options.get("dataSec", {}).get("data", {}).get("General", {})
    version = general.get("versionHP") or general.get("versionPN") or general.get("version") or ""
    for onglet in (16, 49, 7):  # numéro d'onglet de la page « Mes informations » : celui de Pronote d'abord
        try:
            data = client.post("PageInfosPerso", onglet, None)
            item = data["dataSec"]["data"]["iCal"]["liste"]["V"][0]
            return root, ical_candidates(root, version, item["paramICal"], item.get("paramSuppl", ""))
        except (KeyError, IndexError, TypeError, pronotepy.PronoteAPIError):
            continue
    raise robot_errors.page_changed(SERVICE)


def first_working(candidates: list[str], check) -> str:
    """Première adresse qui renvoie un vrai calendrier (`check(url)` → True/False)."""
    for url in candidates:
        try:
            if check(url):
                return url
        except httpx.HTTPError:
            continue
    raise robot_errors.page_changed(SERVICE)


def looks_like_calendar(url: str) -> bool:
    res = httpx.get(url, timeout=ade.TIMEOUT, follow_redirects=True, headers={"User-Agent": ade.UA})
    return res.status_code == 200 and "BEGIN:VCALENDAR" in res.text[:2000]


def robot(base: str, username: str, password: str, *, check=looks_like_calendar) -> str:
    """Connexion à HyperPlanning → adresse iCal vérifiée. Le mot de passe ne sert qu'à la connexion."""
    url = espace_url(base)
    try:
        probe = httpx.get(url, follow_redirects=True, timeout=ade.TIMEOUT, headers={"User-Agent": ade.UA})
    except httpx.HTTPError as exc:
        raise robot_errors.from_http(exc, SERVICE) from None
    if robot_errors.is_blocked(probe):
        raise robot_errors.blocked(SERVICE)
    if probe.status_code >= 400:
        raise robot_errors.page_changed(SERVICE)
    cas = urlparse(str(probe.url)).hostname != urlparse(url).hostname
    cookies = None
    if cas:  # HyperPlanning renvoie vers la page de l'université : connexion CAS/Shibboleth (même code qu'ADE)
        client, res = ade.sso_login(url, username, password,
                                    back=lambda r: "/hp/" in r.url.path and 'type="password"' not in r.text.lower())
        try:
            found = find_ical(res.text, f"https://{res.url.host}")
            if found:
                return first_working([found], check)
            cookies = client.cookies
            url = str(res.url).split("?")[0]
        finally:
            client.close()
    else:
        found = find_ical(probe.text, f"https://{probe.url.host}")
        if found:
            return first_working([found], check)
    try:
        _root, candidates = _protocol_ical(url, username, password, cookies)
    except httpx.HTTPError as exc:
        raise robot_errors.from_http(exc, SERVICE) from None
    except Exception as exc:  # noqa: BLE001 - réponse inattendue d'HyperPlanning : jamais de détail (ni identifiant)
        if getattr(exc, "status_code", None):
            raise
        log.warning("Robot HyperPlanning : %s", type(exc).__name__)
        raise robot_errors.page_changed(SERVICE) from None
    return first_working(candidates, check)
