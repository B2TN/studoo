"""Robot ADE des universités : connexion CAS/Shibboleth, arborescence GWT-RPC, lien d'export (relevés réels du 26/11/2026)."""
import json
import logging

import httpx
import pytest
from fastapi import HTTPException

from studoo.services import ade

BASE = "https://adeconsult.app.u-pariscite.fr"
IDP = "https://auth.u-paris.fr/idp/profile/cas/login"

# Réponses réelles d'ADE 2025.1 (Université Paris Cité), raccourcies à 2 éléments.
PROJECTS = '[6]{"5""1737557597291_1_HS_Suppression_impossible"{"4""UPCité 2026-2027 restauré"{"3""UPCité avec salles pour futur"' \
           '{"2""UPCité 2027-2028"{"1""UPCité 2026-2027 planté"{"0""UPCité 2025-2026"'
LEAVES = ('{"0"{"32466""true""3""12""0""11""0""false"[1]{"StringField""NAME""LabelName""1ère année""false""false""""trainee""1""0"[0][0][12]'
          '{"32470""false""4""-1""0""0""0""false"[2]{"ColorField""COLOR""LabelColor""102,102,255""false""false"'
          '{"StringField""NAME""LabelName""101""false""false""IUT Paris - Rives de Seine.Département INFO.1ère année.101""trainee""1""0"[0][0]'
          '{"32471""false""4""-1""1""1""0""false"[2]{"ColorField""COLOR""LabelColor""102,102,255""false""false"'
          '{"StringField""NAME""LabelName""102""false""false""IUT Paris - Rives de Seine.Département INFO.1ère année.102""trainee""1""0"[0][0]"false"')
FOLDERS = ('{"0"{"32465""true""2""6""0""5""0""false"[1]{"StringField""NAME""LabelName""Département INFO""false""false""""trainee""1""0"[0][0][6]'
           '{"32466""true""3""-1""0""0""0""false"[2]{"ColorField""COLOR""LabelColor""255,102,102""false""false"'
           '{"StringField""NAME""LabelName""1ère année""false""false""IUT Paris - Rives de Seine.Département INFO.1ère année""trainee""1""0"[0][0]"false"')
GWT = {"module": f"{BASE}/direct/gwtdirectplanning/", "perm": "E25EC43C8A44C2056AD16D38F96E4C74",
       "names": {"DirectPlanningServiceProxy": "AF8E80FD952FAE1F1E1D64FCA0763541", "WebClientServiceProxy": "5EB99F51B592E97DD3B5315B286394D6"},
       "methods": ["method13loadProject", "method4getChildren", "method4getProjectList", "method6loadProject", "method1getChildren"],
       "sigs": dict(ade.DEFAULT_SIGS), "cid": "aIYfuuc"}


def ok(inner: str) -> str:
    return "//OK" + json.dumps([1, [inner], 0, 7], ensure_ascii=False)


def client_for(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)


def test_gwt_long_is_the_client_clock():
    alphabet = ade._B64
    decode = lambda s: sum(alphabet.index(c) * 64 ** i for i, c in enumerate(reversed(s)))  # noqa: E731
    assert decode("aIYfuuc") > 1_700_000_000_000  # relevé réel : l'heure en millisecondes
    assert decode(ade.gwt_long(1795705409899)) == 1795705409899


def test_tree_and_projects_are_parsed_from_real_answers():
    calls = []

    def handler(req):
        body = req.content.decode()
        calls.append(body)
        if "getProjectList" in body:
            return httpx.Response(200, text=ok(PROJECTS))
        if '"32466""true""3"' in body:
            return httpx.Response(200, text=ok(LEAVES))
        return httpx.Response(200, text=ok(FOLDERS))

    c = client_for(handler)
    assert ade.projects(c, GWT)[1] == {"id": 4, "name": "UPCité 2026-2027 restauré"}
    folders = ade.children(c, GWT, 32465, "Département INFO", 2)
    assert folders == [{"id": 32466, "name": "1ère année", "level": 3, "folder": True,
                        "path": "IUT Paris - Rives de Seine.Département INFO.1ère année"}]
    leaves = ade.children(c, GWT, 32466, "1ère année", 3)
    assert [(n["id"], n["name"], n["folder"]) for n in leaves] == [(32470, "101", False), (32471, "102", False)]
    assert "method4getChildren" in calls[-1] and "TreeResourceConfig/2234901663" in calls[-1]
    assert '|aIYfuuc|' in calls[-1] and '""false""false""""trainee""1""0"[0][0]|' in calls[-1]  # format exact d'ADE


def test_wrong_method_number_is_retried():
    def handler(req):
        if "method1getChildren" in req.content.decode():
            return httpx.Response(200, text="//EX[1,[\"x\"],0,7]")
        return httpx.Response(200, text=ok(FOLDERS))
    gwt = {**GWT, "methods": ["method1getChildren", "method4getChildren"]}
    assert ade.children(client_for(handler), gwt, 32465, "Département INFO", 2)[0]["id"] == 32466


def test_discover_reads_the_ids_in_ade_code():
    cache = ("x=['DirectPlanningServiceProxy','AF8E80FD952FAE1F1E1D64FCA0763541'],y='WebClientServiceProxy','5EB99F51B592E97DD3B5315B286394D6';"
             "'method4getChildren';'method13loadProject';'method4getProjectList';"
             "'com.adesoft.gwt.directplan.client.ui.tree.TreeResourceConfig/1111111111'")

    def handler(req):
        if req.url.path.endswith("nocache.js"):
            return httpx.Response(200, text="'E25EC43C8A44C2056AD16D38F96E4C74'")
        return httpx.Response(200, text=cache.replace("x=[", "").replace("],y=", ","))
    gwt = ade.discover(client_for(handler), BASE)
    assert gwt["names"]["DirectPlanningServiceProxy"] == "AF8E80FD952FAE1F1E1D64FCA0763541"
    assert gwt["sigs"]["TreeResourceConfig"].endswith("/1111111111") and "method4getChildren" in gwt["methods"]


def idp(password_ok=True, mfa=False):
    """Faux Shibboleth comme celui de Paris Cité : page « Loading Session », formulaire, retour vers ADE."""
    def handler(req):
        url = str(req.url)
        if url.startswith(f"{BASE}/direct/"):
            if "ticket=" in url or req.headers.get("cookie", "").find("JSESSIONID") >= 0:
                return httpx.Response(200, text="<html>ADE</html>", headers={"set-cookie": "JSESSIONID=abc; Path=/direct"})
            return httpx.Response(302, headers={"location": f"{IDP}?execution=e1s1"})
        if "e1s1" in url and req.method == "GET":
            return httpx.Response(200, text='<form action="/idp/profile/cas/login?execution=e1s1" method="post">'
                                            '<input name="shib_idp_ls_supported" type="hidden"><input name="_eventId_proceed" type="hidden"></form>')
        if "e1s1" in url and req.method == "POST":
            return httpx.Response(302, headers={"location": f"{IDP}?execution=e1s2"})
        if "e1s2" in url and req.method == "GET":
            return httpx.Response(200, text='<form action="/idp/profile/cas/login?execution=e1s2" method="post">'
                                            '<input id="username" name="j_username" type="text"><input name="j_password" type="password">'
                                            '<button type="submit" name="_eventId_proceed">Connexion</button></form>')
        if "e1s2" in url and req.method == "POST":
            form = dict(x.split("=", 1) for x in req.content.decode().split("&"))
            assert "_eventId_proceed" in form and form["j_username"] == "etu"
            if mfa:
                return httpx.Response(200, text="<p>Saisissez le code de vérification (double authentification)</p><form><input name='otp'></form>")
            if password_ok and form["j_password"] == "bon":
                return httpx.Response(302, headers={"location": f"{BASE}/direct/?ticket=ST-1"})
            return httpx.Response(200, text='<p>Identifiant ou mot de passe incorrect</p><form action="/idp/profile/cas/login?execution=e1s2" method="post">'
                                            '<input name="j_username" type="text"><input name="j_password" type="password"></form>')
        return httpx.Response(404)
    return handler


@pytest.mark.parametrize("password, mfa, code", [("bon", False, None), ("faux", False, "bad_credentials"), ("bon", True, "two_factor")])
def test_university_login(monkeypatch, password, mfa, code):
    real = httpx.Client
    monkeypatch.setattr(ade.httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(idp(mfa=mfa)), **kw))
    if code is None:
        client = ade.login(BASE, "etu", password)
        state = ade.dump(client, BASE, GWT)
        assert any(c["name"] == "JSESSIONID" for c in state["cookies"]) and "bon" not in json.dumps(state)
    else:
        with pytest.raises(HTTPException) as err:
            ade.login(BASE, "etu", password)
        assert err.value.detail["code"] == code


def test_export_link_needs_no_password():
    url = ade.export_url(BASE, 4, 32470)
    assert url == f"{BASE}/jsp/custom/modules/plannings/anonymous_cal.jsp?resources=32470&projectId=4&calType=ical&nbWeeks=20"


def test_routes_keep_only_the_sealed_session_then_the_link(logged, monkeypatch, caplog):
    class FakeClient:
        cookies = httpx.Cookies()

        def close(self):
            pass

    monkeypatch.setattr(ade, "login", lambda base, u, p: FakeClient())
    monkeypatch.setattr(ade, "discover", lambda c, base: GWT)
    monkeypatch.setattr(ade, "register", lambda c, g: None)
    monkeypatch.setattr(ade, "projects", lambda c, g: [{"id": 4, "name": "UPCité 2026-2027"}])
    monkeypatch.setattr(ade, "dump", lambda c, base, g: {"base": base, "cookies": [{"name": "JSESSIONID", "value": "SECRETSESSION",
                                                                                   "domain": "adeconsult.app.u-pariscite.fr", "path": "/direct"}],
                                                          "gwt": g, "at": 9e12})
    with caplog.at_level(logging.DEBUG):
        res = logged.post("/api/timetable/ade/login", json={"university": "paris-cite", "username": "etu", "password": "MotDePasse-42"})
    data = res.json()
    assert res.status_code == 200 and data["projects"][0]["id"] == 4
    assert "MotDePasse-42" not in res.text and "SECRETSESSION" not in res.text and "MotDePasse-42" not in caplog.text

    monkeypatch.setattr(ade, "load_project", lambda c, g, pid: None)
    monkeypatch.setattr(ade, "children", lambda c, g, nid, name, level: [{"id": 32470, "name": "101", "level": 4, "folder": False, "path": "IUT.101"}])
    tree = logged.post("/api/timetable/ade/tree", json={"session": data["session"], "project": 4}).json()
    assert tree["nodes"][0]["name"] == "101"

    from studoo.routes import timetable

    async def fetch(url, start, end):
        assert "resources=32470" in url and "projectId=4" in url
        return url, {"events": [], "subjects": []}
    monkeypatch.setattr(timetable, "fetch_working", fetch)
    done = logged.post("/api/timetable/ade/choose", json={"session": data["session"], "project": 4, "resource": 32470, "label": "IUT 101"}).json()
    assert done["sealed"] and done["method"] == "ical" and "anonymous_cal" not in json.dumps(done)


def test_client_id_is_registered_like_ade_does_at_startup():
    bodies = []

    def handler(req):
        bodies.append(req.content.decode())
        return httpx.Response(200, text="//OK[1,[],0,7]")
    gwt = {**GWT, "names": {**GWT["names"], "ConfigurationServiceProxy": "EF3C90C386D8FC5AC360EBC475A862C9"},
           "methods": ["method1login", "method1getInitialConfiguration"] + GWT["methods"]}
    ade.register(client_for(handler), gwt)
    assert "method1getInitialConfiguration|J|java.lang.String/2004016611|fr|" in bodies[0]
    # relevé réel du démarrage d'ADE 2025.1 (demande de connexion vide : la session vient de l'université)
    assert bodies[1].endswith(".DirectLoginRequest/635437471||fr|1|2|3|4|4|5|6|7|8|aIYfuuc|9|0|10|0|1|1|10|10|-1|0|0|11|0|")


def test_long_gwt_answers_split_with_concat_are_read():
    long_answer = '//OK[1,2,["a","b"].concat(["{\\"4\\"\\"UPCité 2026-2027\\""]),0,7]'
    assert ade._strings(long_answer)  # ne plante plus
    assert ade._strings('//OK[1,["x"],0,7]') == "x"
    assert ade._strings("//OK[pas du json") == "[pas du json"


def test_httpx_urls_are_not_logged():
    import studoo.main  # noqa: F401 - règle les journaux
    assert logging.getLogger("httpx").level >= logging.WARNING


def test_unexpected_robot_error_gives_a_clear_message(logged, monkeypatch):
    def boom(*a):
        raise ValueError("réponse inattendue")
    monkeypatch.setattr(ade, "login", boom)
    res = logged.post("/api/timetable/ade/login", json={"university": "paris-cite", "username": "etu", "password": "x"})
    assert res.status_code == 502 and res.json()["detail"]["code"] == "ade_robot"
