"""Robot ADE (emplois du temps des universités).

ADE ne donne pas directement l'emploi du temps de l'étudiant : il faut choisir l'année (« projet »), puis
descendre dans l'arborescence établissement → filière → classe. Le robot :
1. se connecte par la page de connexion de l'université (CAS / Shibboleth) avec l'identifiant et le mot de
   passe de l'étudiant — c'est la SEULE étape qui les utilise ; ils sont oubliés à la fin de la requête ;
2. parle ensuite à ADE comme son interface web (appels GWT-RPC `getProjectList`, `loadProject`,
   `getChildren`) avec la session ADE temporaire (cookie), renvoyée chiffrée au navigateur entre deux étapes ;
3. une fois la classe choisie, fabrique le lien d'export iCal officiel d'ADE (`anonymous_cal.jsp`), qui se lit
   SANS identifiant : c'est lui seul que Studoo garde (chiffré, dans le Drive de l'étudiant).

Testé le 26/11/2026 sur l'ADE de l'Université Paris Cité (IUT Paris – Rives de Seine), version ADE 2025.1.
Les identifiants techniques (noms forts GWT, numéros de méthode, signatures de types) sont relus dans le code
d'ADE à chaque connexion : une mise à jour d'ADE ne casse pas le robot tant que les méthodes existent.
"""
import json
import re
import time
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import HTTPException

UA = "Mozilla/5.0 (Studoo; robot d'emploi du temps)"
TIMEOUT = 25

# Universités dont l'ADE passe par une connexion CAS/Shibboleth (adresse ADE après la connexion).
UNIVERSITIES = {
    "paris-cite": {"name": "Université Paris Cité", "base": "https://adeconsult.app.u-pariscite.fr", "tested": True},
    "amu": {"name": "Aix-Marseille Université", "base": "https://agenda-web-consult.univ-amu.fr", "tested": False},
    "lyon1": {"name": "Université Claude Bernard Lyon 1", "base": "https://edt.univ-lyon1.fr", "tested": False},
    "rennes": {"name": "Université de Rennes", "base": "https://planning.univ-rennes.fr", "tested": False},
    "tours": {"name": "Université de Tours", "base": "https://ade.univ-tours.fr", "tested": False},
    "artois": {"name": "Université d'Artois", "base": "https://ade-consult.univ-artois.fr", "tested": False},
}

# Valeurs relevées sur ADE 2025.1 (utilisées si le code d'ADE ne permet pas de les relire).
DEFAULT_SIGS = {
    "TreeResourceConfig": "com.adesoft.gwt.directplan.client.ui.tree.TreeResourceConfig/2234901663",
    "OutputField": "com.adesoft.gwt.core.client.rpc.config.OutputField/870745015",
    "FieldType": "com.adesoft.gwt.core.client.rpc.config.FieldType/1797283245",
    "SortInfo": "com.extjs.gxt.ui.client.data.SortInfo/1143517771",
    "Style$SortDir": "com.extjs.gxt.ui.client.Style$SortDir/3873584144",
    "LoginRequest": "com.adesoft.gwt.core.client.rpc.data.LoginRequest/3705388826",
    "DirectLoginRequest": "com.adesoft.gwt.directplan.client.rpc.data.DirectLoginRequest/635437471",
}
JRE_SIGS = {"String": "java.lang.String/2004016611", "IntArray": "[I/2970817851",
            "LinkedHashMap": "java.util.LinkedHashMap/3008245022", "ArrayList": "java.util.ArrayList/4159755760"}


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def _unavailable() -> HTTPException:
    return _error(503, "unavailable", "ADE ou la page de connexion de ton université ne répond pas (maintenance ?). Réessaie plus tard.")


# ---------- Connexion CAS / Shibboleth ----------
class _Forms(HTMLParser):
    """Formulaires d'une page HTML : action, méthode, champs (nom, type, valeur), boutons nommés."""

    def __init__(self):
        super().__init__()
        self.forms: list[dict] = []
        self.text: list[str] = []

    def handle_starttag(self, tag, attrs):
        a = {k: v or "" for k, v in attrs}
        if tag == "form":
            self.forms.append({"action": a.get("action", ""), "method": a.get("method", "get").lower(), "inputs": []})
        elif tag in ("input", "button") and self.forms:
            self.forms[-1]["inputs"].append({"tag": tag, "name": a.get("name", ""), "type": a.get("type", "text" if tag == "input" else "submit").lower(),
                                             "value": a.get("value", ""), "id": a.get("id", "")})

    def handle_data(self, data):
        if data.strip():
            self.text.append(data.strip())


def _parse(html: str) -> _Forms:
    p = _Forms()
    p.feed(html)
    return p


USER_FIELDS = ("j_username", "username", "login", "user", "uid", "identifiant")


def _fill(form: dict, username: str, password: str) -> dict:
    data = {}
    user_done = False
    for f in form["inputs"]:
        name = f["name"]
        if not name:
            continue
        if f["type"] == "password":
            data[name] = password
        elif f["type"] in ("text", "email") and not user_done and (name.lower() in USER_FIELDS or not user_done):
            data[name] = username
            user_done = True
        elif f["type"] in ("hidden",):
            data[name] = f["value"]
        elif f["type"] == "submit" and name.startswith("_eventId"):
            data[name] = f["value"]
    if "_eventId" not in data and not any(k.startswith("_eventId_") for k in data):
        data["_eventId_proceed" if "/idp/" in form.get("url", "") else "_eventId"] = "" if "/idp/" in form.get("url", "") else "submit"
    return data


def _ls_form(form: dict) -> dict:
    """Page intermédiaire Shibboleth (« Loading Session Information ») : on la valide telle quelle."""
    data = {f["name"]: f["value"] for f in form["inputs"] if f["name"] and f["type"] == "hidden"}
    data["shib_idp_ls_supported"] = "false"
    data["_eventId_proceed"] = ""
    return data


MFA_WORDS = ("otp", "double authentification", "authentification forte", "multi-facteur", "mfa", "code de vérification",
             "code de verification", "second facteur", "2fa", "esup-otp", "totp")
BAD_WORDS = ("incorrect", "invalide", "invalid", "erron", "échec", "echec", "failed", "mauvais", "unknown", "inconnu")


def login(base: str, username: str, password: str) -> httpx.Client:
    """Ouvre une session ADE avec les identifiants de l'université. Renvoie le client (cookies de session)."""
    client = httpx.Client(follow_redirects=True, timeout=TIMEOUT, headers={"User-Agent": UA})
    ade_host = urlparse(base).hostname
    try:
        res = client.get(f"{base}/direct/")
        for _ in range(5):
            if urlparse(str(res.url)).hostname == ade_host:
                return client  # de retour sur ADE : connecté
            page = _parse(res.text)
            low = " ".join(page.text).lower()
            for f in page.forms:
                f["url"] = str(res.url)
            pwd_form = next((f for f in page.forms if any(i["type"] == "password" for i in f["inputs"])), None)
            if pwd_form is None:
                ls = next((f for f in page.forms if any(i["name"].startswith("shib_idp_ls") for i in f["inputs"])), None)
                if ls:
                    res = client.post(urljoin(str(res.url), ls["action"] or str(res.url)), data=_ls_form(ls))
                    continue
                proceed = next((f for f in page.forms if any(i["name"] == "_eventId_proceed" for i in f["inputs"])), None)
                if proceed and getattr(client, "_studoo_sent", False):  # page « autoriser l'accès » après connexion
                    data = {i["name"]: i["value"] for i in proceed["inputs"] if i["name"] and i["type"] in ("hidden", "radio")}
                    data["_eventId_proceed"] = ""
                    res = client.post(urljoin(str(res.url), proceed["action"] or str(res.url)), data=data)
                    continue
                if any(w in low for w in MFA_WORDS):
                    raise _error(401, "two_factor", "Ton université demande une double authentification : le robot ne peut pas "
                                                    "la faire à ta place. Utilise le dernier recours (lien .ics).")
                raise _error(502, "login_page", "Page de connexion de l'université non reconnue : utilise le dernier recours (.ics).")
            if getattr(client, "_studoo_sent", False):  # le formulaire revient après l'envoi : refusé
                if any(w in low for w in MFA_WORDS) and not any(w in low for w in BAD_WORDS):
                    raise _error(401, "two_factor", "Ton université demande une double authentification : le robot ne peut pas "
                                                    "la faire à ta place. Utilise le dernier recours (lien .ics).")
                raise _error(401, "bad_credentials", "Identifiant ou mot de passe de l'université incorrect.")
            client._studoo_sent = True
            res = client.post(urljoin(str(res.url), pwd_form["action"] or str(res.url)), data=_fill(pwd_form, username, password))
        raise _error(502, "login_loop", "La connexion à l'université n'a pas abouti : utilise le dernier recours (.ics).")
    except HTTPException:
        client.close()
        raise
    except httpx.HTTPError:
        client.close()
        raise _unavailable() from None


# ---------- GWT-RPC ----------
_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$_"


def gwt_long(value: int) -> str:
    out = ""
    while value:
        out = _B64[value & 63] + out
        value >>= 6
    return out or "A"


def discover(client: httpx.Client, base: str) -> dict:
    """Relit dans le code d'ADE : permutation, noms forts des services, méthodes et signatures de types."""
    module = f"{base}/direct/gwtdirectplanning/"
    nocache = client.get(module + "gwtdirectplanning.nocache.js").text
    for perm in dict.fromkeys(re.findall(r"[0-9A-F]{32}", nocache)):
        js = client.get(f"{module}{perm}.cache.html")
        if js.status_code != 200 or "DirectPlanningServiceProxy" not in js.text:
            continue
        text = js.text
        names = dict(re.findall(r"'(\w+ServiceProxy)'\s*,\s*'([0-9A-F]{32})'", text))
        known = ["method4getChildren", "method13loadProject", "method4getProjectList",  # relevés sur ADE 2025.1
                 "method1login", "method1getInitialConfiguration"]
        found = set(re.findall(r"method\d+(?:getChildren|loadProject|getProjectList|login|getInitialConfiguration)\b", text))
        methods = [m for m in known if m in found] + sorted(found - set(known))
        sigs = dict(DEFAULT_SIGS)
        for full in set(re.findall(r"com\.(?:adesoft|extjs)\.[\w.$]+/\d+", text)):
            short = full.split("/")[0].rsplit(".", 1)[-1]
            if short in sigs:
                sigs[short] = full
        if "DirectPlanningServiceProxy" in names and "WebClientServiceProxy" in names:
            # « cid » : identifiant du client, fixé à la connexion. ADE y rattache l'année ouverte (loadProject) :
            # tous les appels suivants doivent le réutiliser.
            return {"module": module, "perm": perm, "names": names, "methods": methods, "sigs": sigs, "cid": _ts()}
    raise _error(502, "ade_unknown", "Cette version d'ADE n'est pas reconnue par le robot : utilise le dernier recours (.ics).")


def _rpc(client: httpx.Client, gwt: dict, service: str, body: str) -> str:
    res = client.post(gwt["module"] + service, content=body.encode(), headers={
        "Content-Type": "text/x-gwt-rpc; charset=utf-8", "X-GWT-Permutation": gwt["perm"], "X-GWT-Module-Base": gwt["module"]})
    if res.status_code != 200 or not res.text.startswith("//OK"):
        raise _error(502, "ade_error", "ADE a refusé la demande (session expirée ?) : recommence la connexion.")
    return _strings(res.text)


def _strings(text: str) -> str:
    """Textes d'une réponse GWT « //OK[…] ». Les longues réponses sont découpées en « ].concat([ » (syntaxe
    JavaScript) : on les recolle avant de lire. Si le format reste inconnu, on renvoie le texte brut."""
    body = text[4:]
    for candidate in (body, body.replace("].concat([", ",")):
        try:
            payload = json.loads(candidate)
        except ValueError:
            continue
        lists = [x for x in payload if isinstance(x, list)] if isinstance(payload, list) else []
        return "".join(s for s in (lists[0] if lists else []) if isinstance(s, str))
    return body


def _call(client, gwt, service, method_word, template) -> str:
    """Essaie les numéros de méthode trouvés dans le code (ex. method4getChildren) jusqu'au bon."""
    candidates = [m for m in gwt["methods"] if m.endswith(method_word)] or [method_word]
    last = None
    for method in candidates:
        try:
            return _rpc(client, gwt, service, template(method))
        except HTTPException as exc:
            last = exc
    raise last


def _ts() -> str:
    return gwt_long(int(time.time() * 1000))


def projects(client: httpx.Client, gwt: dict) -> list[dict]:
    sn = gwt["names"]["WebClientServiceProxy"]
    text = _call(client, gwt, "WebClientServiceProxy", "getProjectList", lambda m: (
        f"7|0|5|{gwt['module']}|{sn}|com.adesoft.gwt.core.client.rpc.WebClientServiceProxy|{m}|J|1|2|3|4|1|5|{gwt['cid']}|"))
    return [{"id": int(i), "name": n} for i, n in re.findall(r'\{"(\d+)""([^"]*)"', text)]


def register(client: httpx.Client, gwt: dict) -> None:
    """Enregistre l'identifiant du client auprès d'ADE, comme l'interface au démarrage (session déjà connectée
    par l'université : la demande de connexion ADE est vide). Sans cela, ADE répond « identifiant invalide »."""
    s = gwt["sigs"]
    conf = gwt["names"].get("ConfigurationServiceProxy")
    if conf:
        try:
            _call(client, gwt, "ConfigurationServiceProxy", "getInitialConfiguration", lambda m: (
                f"7|0|7|{gwt['module']}|{conf}|com.adesoft.gwt.core.client.rpc.ConfigurationServiceProxy|{m}|J|"
                f"{JRE_SIGS['String']}|fr|1|2|3|4|2|5|6|{gwt['cid']}|7|"))
        except (HTTPException, ValueError, httpx.HTTPError):
            pass  # facultatif selon les versions : la suite dira si ADE accepte le client
    sn = gwt["names"]["DirectPlanningServiceProxy"]
    _call(client, gwt, "DirectPlanningServiceProxy", "login", lambda m: (
        f"7|0|11|{gwt['module']}|{sn}|com.adesoft.gwt.directplan.client.rpc.DirectPlanningServiceProxy|{m}|J|"
        f"{s['LoginRequest']}|{JRE_SIGS['String']}|Z|{s['DirectLoginRequest']}||fr|1|2|3|4|4|5|6|7|8|{gwt['cid']}|"
        f"9|0|10|0|1|1|10|10|-1|0|0|11|0|"))


def load_project(client: httpx.Client, gwt: dict, project_id: int) -> None:
    sn = gwt["names"]["DirectPlanningServiceProxy"]
    _call(client, gwt, "DirectPlanningServiceProxy", "loadProject", lambda m: (
        f"7|0|7|{gwt['module']}|{sn}|com.adesoft.gwt.directplan.client.rpc.DirectPlanningServiceProxy|{m}|J|I|Z|"
        f"1|2|3|4|3|5|6|7|{gwt['cid']}|{int(project_id)}|1|"))


NODE = re.compile(r'\{"(-?\d+)""(true|false)""(\d+)""-?\d+""-?\d+""-?\d+""-?\d+""(?:true|false)"\[\d+\]'
                  r'(?:\{"ColorField"[^{]*?)?\{"StringField""NAME""LabelName""([^"]*)""(?:true|false)""(?:true|false)""([^"]*)"')


def _safe(name: str) -> str:
    return str(name).replace('"', "'").replace("|", "/")[:200]


def children(client: httpx.Client, gwt: dict, node_id: int, name: str, level: int) -> list[dict]:
    """Contenu d'un dossier de l'arborescence « étudiants » (racine : id -1, niveau 0)."""
    sn = gwt["names"]["DirectPlanningServiceProxy"]
    s = gwt["sigs"]
    cfg = (f'{{"{int(node_id)}""true""{int(level)}""-1""0""0""0""false"[1]{{"StringField""NAME""LabelName""{_safe(name)}""false""false"'
           f'"""trainee""1""0"[0][0]')  # comme l'interface d'ADE : ...""false""false""""trainee""1""0"[0][0]

    def body(method: str) -> str:
        return (f"7|0|20|{gwt['module']}|{sn}|com.adesoft.gwt.directplan.client.rpc.DirectPlanningServiceProxy|{method}|J|"
                f"{JRE_SIGS['String']}|{s['TreeResourceConfig']}|{cfg}|{JRE_SIGS['IntArray']}|{JRE_SIGS['LinkedHashMap']}|COLOR|"
                f"{s['OutputField']}|LabelColor||{s['FieldType']}|NAME|LabelName|{JRE_SIGS['ArrayList']}|{s['SortInfo']}|"
                f"{s['Style$SortDir']}|1|2|3|4|3|5|6|7|{gwt['cid']}|8|7|0|9|2|-1|-1|10|0|2|6|11|12|0|13|11|14|15|11|0|0|6|16|12|0|"
                f"17|16|14|15|4|0|0|18|0|18|0|19|20|1|16|18|0|")

    text = _call(client, gwt, "DirectPlanningServiceProxy", "getChildren", body)
    out = []
    for nid, folder, lvl, label, path in NODE.findall(text):
        if int(nid) == int(node_id):
            continue  # le dossier lui-même
        out.append({"id": int(nid), "name": label, "level": int(lvl), "folder": folder == "true", "path": path})
    return out


def export_url(base: str, project_id: int, resource_id: int, weeks: int = 20) -> str:
    """Lien d'export iCal officiel d'ADE : il se lit sans identifiant et reste à jour (fenêtre glissante)."""
    return (f"{base}/jsp/custom/modules/plannings/anonymous_cal.jsp?resources={int(resource_id)}"
            f"&projectId={int(project_id)}&calType=ical&nbWeeks={int(weeks)}")


# ---------- Session entre deux étapes ----------
def dump(client: httpx.Client, base: str, gwt: dict) -> dict:
    """Ce qui permet de continuer : cookies de la session ADE (jamais le mot de passe) + infos techniques."""
    host = urlparse(base).hostname
    cookies = [{"name": c.name, "value": c.value, "domain": c.domain, "path": c.path}
               for c in client.cookies.jar if host and (c.domain.lstrip(".") in host)]
    return {"base": base, "cookies": cookies, "gwt": gwt, "at": int(time.time())}


SESSION_MINUTES = 25


def resume(state: dict) -> httpx.Client:
    if time.time() - state.get("at", 0) > SESSION_MINUTES * 60:
        raise _error(401, "session_expired", "La session ADE a expiré : reconnecte-toi.")
    client = httpx.Client(follow_redirects=False, timeout=TIMEOUT, headers={"User-Agent": UA})
    for c in state["cookies"]:
        client.cookies.set(c["name"], c["value"], domain=c["domain"], path=c["path"])
    return client
