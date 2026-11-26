// Emploi du temps : semaine en cours + connexion par robot (lycées) ou dernier recours (.ics).
//
// Itération 4 : l'élève ne colle plus aucun lien. Il choisit son lycée et tape son identifiant et son
// mot de passe ; le robot de Studoo (côté serveur) se connecte et récupère l'emploi du temps, puis oublie
// le mot de passe. Seule l'option « Dernier recours : .ics » demande un lien ou un fichier.
import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { time } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { drive, getSettings } from "../lib/storage.js";
import {
  adeChoose, adeLogin, adeTree, addSource, celcatChoose, celcatGroups, celcatLogin, clearTimetableCache, guessProject,
  higherDetect, higherSearch, loadEvents, removeSource, RECONNECT_DAYS, robotConnect, staleSources,
} from "../lib/timetable-data.js";
import { detectSoftware, ICAL_STEPS_PRONOTE, ICAL_STEPS_UNIVERSITY, LAST_RESORT_STEPS, ROBOT_TESTED } from "../lib/establishments.js";
import { openDialog, toast } from "../lib/ui.js";

const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi"];
const COLORS = ["yellow", "pink", "green", "blue", "orange", "lilac"];
const PRIVACY_NOTE = "Ton identifiant sert uniquement à récupérer ton emploi du temps, il est supprimé juste après.";

function mondayOf(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function colorFor(subject, palette) {
  if (!palette.has(subject)) palette.set(subject, COLORS[palette.size % COLORS.length]);
  return palette.get(subject);
}

function weekView(events, monday) {
  const palette = new Map();
  const today = new Date().toDateString();
  return h("div", { class: "week" }, DAYS.map((name, i) => {
    const day = new Date(monday);
    day.setDate(day.getDate() + i);
    const list = events.filter((e) => new Date(e.start).toDateString() === day.toDateString());
    return h("section", { class: `day card sketch${day.toDateString() === today ? " today" : ""}`, "aria-label": `${name} ${day.getDate()}` },
      h("h3", {}, day.toDateString() === today ? h("span", { class: "hl" }, name) : name, " ", h("span", { class: "small muted" }, day.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }))),
      list.length ? list.map((e) => h("div", { class: `lesson c-${colorFor(e.subject, palette)}${e.cancelled ? " cancelled" : ""}` },
        h("time", { datetime: e.start }, `${time(e.start)} – ${time(e.end)}`), h("strong", {}, e.subject),
        e.location ? h("span", { class: "small" }, ` · ${e.location}`) : null, e.cancelled ? h("span", { class: "small" }, " (annulé)") : null))
        : h("p", { class: "small muted" }, "—"));
  }));
}

// ---------- Dernier recours : lien ou fichier .ics ----------
function icsForm({ steps, label = "Lien de ton emploi du temps", onDone, extra = {}, open = null }) {
  const input = h("input", { class: "input", id: "ics-url", type: "url", inputmode: "url", placeholder: "https://…/calendar.ics", autocomplete: "off" });
  const hint = h("span", { class: "hint", "aria-live": "polite" });
  const err = h("p", { class: "error", role: "alert" });
  input.addEventListener("input", () => { const s = detectSoftware(input.value); hint.textContent = s ? `Reconnu : ${s}` : ""; });
  const btn = h("button", { class: "btn primary", type: "submit" }, icon("link"), "Ajouter ce lien");
  return h("form", { class: "stack", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = "";
    const url = input.value.trim();
    if (!/^(https?|webcal):\/\/\S+$/i.test(url)) { err.textContent = "Colle un lien qui commence par https:// ou webcal://"; input.setAttribute("aria-invalid", "true"); input.focus(); return; }
    btn.disabled = true;
    try {
      const res = await api("/api/timetable/ics-url", { method: "POST", json: { url } });
      // Seule la version chiffrée du lien est rangée dans ton Drive.
      await addSource({ type: "sealed", sealed: res.sealed, label: detectSoftware(url) || "Lien iCal", ...extra });
      toast(`${res.events.length} cours trouvés !`, "success");
      onDone(res.subjects);
    } catch (e2) {
      err.textContent = e2.message;
    } finally {
      btn.disabled = false;
    }
  } },
    open ? h("p", {}, h("a", { class: "btn", href: open.url, target: "_blank", rel: "noopener" }, icon("external-link"), open.label)) : null,
    steps ? h("ol", { class: "steps-list" }, steps.map((s) => h("li", {}, s))) : null,
    h("div", { class: "field" }, h("label", { for: "ics-url" }, label), input, hint),
    err, h("div", {}, btn));
}

function icsFileForm(onDone) {
  const input = h("input", { type: "file", accept: ".ics,text/calendar", id: "ics-file", class: "input" });
  const err = h("p", { class: "error", role: "alert" });
  return h("form", { class: "stack", onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = "";
    const file = input.files[0];
    if (!file) { err.textContent = "Choisis un fichier .ics."; return; }
    if (file.size > 3 * 1024 * 1024) { err.textContent = "Fichier trop gros (3 Mo max)."; return; }
    try {
      const content = await file.text();
      const res = await api("/api/timetable/ics-file", { method: "POST", json: { content } });
      const root = await drive.init();
      const saved = await drive.save({ parentId: root, name: `Emploi du temps — ${file.name}`, mimeType: "text/calendar", kind: "timetable", blob: new Blob([content], { type: "text/calendar" }) });
      await addSource({ type: "ics-file", fileId: saved.id, label: file.name });
      toast(`${res.events.length} cours importés`, "success");
      onDone(res.subjects);
    } catch (e2) { err.textContent = e2.message; }
  } },
    h("div", { class: "field" }, h("label", { for: "ics-file" }, "Fichier .ics (copié dans ton Drive)"), input), err,
    h("div", {}, h("button", { class: "btn primary", type: "submit" }, icon("upload"), "Importer le fichier")));
}

// ---------- Robot : lycées (Pronote, avec ou sans ENT) ----------
function schoolSearch(onPick) {
  const input = h("input", { class: "input", id: "school-q", type: "search", autocomplete: "off", placeholder: "Ex. : Lavoisier Paris",
    "aria-describedby": "school-hint", "aria-controls": "school-results" });
  const results = h("div", { class: "establishments", id: "school-results", "aria-live": "polite" });
  let timer = 0;
  let seq = 0;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { mount(results); return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      mount(results, h("p", { class: "small muted" }, "Recherche…"));
      try {
        const { schools } = await api(`/api/timetable/schools?q=${encodeURIComponent(q)}`);
        if (mine !== seq) return;
        mount(results, schools.length ? schools.map((s) => h("button", { class: "btn", type: "button", onclick: () => onPick(s) },
          icon("school"), h("span", {}, h("strong", {}, s.name), h("span", { class: "small muted" }, ` · ${s.city}`))))
          : h("p", { class: "small muted" }, "Aucun établissement trouvé : essaie avec la ville, ou un autre mot du nom."));
      } catch (e) { if (mine === seq) mount(results, h("p", { class: "error" }, e.message)); }
    }, 350);
  });
  return h("div", { class: "stack" },
    h("div", { class: "field" }, h("label", { for: "school-q" }, "Ton lycée (nom ou ville)"), input,
      h("span", { class: "hint", id: "school-hint" }, "Annuaire officiel de l'Éducation nationale.")),
    results);
}

function robotForm(school, onDone, onBack) {
  const user = h("input", { class: "input", id: "rb-user", autocomplete: "username", autocapitalize: "none", spellcheck: false });
  const pass = h("input", { class: "input", id: "rb-pass", type: "password", autocomplete: "current-password" });
  const err = h("p", { class: "error", role: "alert" });
  const submit = h("button", { class: "btn primary", type: "submit" }, icon("check"), "Récupérer mon emploi du temps");
  const form = h("form", { class: "stack", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = "";
    if (!user.value.trim() || !pass.value) { err.textContent = "Identifiant et mot de passe requis."; return; }
    submit.disabled = true;
    submit.replaceChildren(h("span", { class: "spinner", style: { width: "22px", height: "22px" } }), "Le robot se connecte… (10 à 30 s)");
    try {
      const res = await robotConnect({ uai: school.uai, username: user.value.trim(), password: pass.value }, school);
      toast(res.method === "ical"
        ? `${res.events.length} cours trouvés : ton emploi du temps se mettra à jour tout seul.`
        : `${res.events.length} cours récupérés. Ton lycée ne permet pas la mise à jour automatique : Studoo te rappellera de te reconnecter dans ${RECONNECT_DAYS} jours.`,
      "success", 9000);
      onDone(res.subjects);
    } catch (e2) {
      err.textContent = e2.message;
    } finally {
      pass.value = ""; // le mot de passe est effacé du formulaire dans tous les cas
      submit.disabled = false;
      submit.replaceChildren(icon("check"), "Récupérer mon emploi du temps");
    }
  } },
    h("p", {}, icon("school"), " ", h("strong", {}, school.name), h("span", { class: "small muted" }, ` · ${school.city} `),
      h("button", { class: "btn small ghost", type: "button", onclick: onBack }, "Changer")),
    h("p", { class: "notice", role: "note" }, icon("shield-lock"), " ", PRIVACY_NOTE),
    h("div", { class: "field" }, h("label", { for: "rb-user" }, "Identifiant (celui de ton ENT ou de Pronote)"), user),
    h("div", { class: "field" }, h("label", { for: "rb-pass" }, "Mot de passe"), pass),
    err, h("div", {}, submit),
    h("p", { class: "small muted" }, "Le robot de Studoo trouve tout seul l'adresse Pronote de ton lycée et ton ENT régional, se connecte, "
      + "récupère ton emploi du temps puis oublie ton mot de passe (il n'est jamais enregistré, ni écrit dans un journal). "
      + "Connecteur non officiel : il peut cesser de marcher après une mise à jour de Pronote."));
  setTimeout(() => user.focus(), 0);
  return form;
}

function highSchoolTab(done, preset) {
  const slot = h("div");
  const pick = (school) => mount(slot, robotForm(school, done, () => mount(slot, schoolSearch(pick))));
  if (preset) pick(preset); else mount(slot, schoolSearch(pick));
  return h("div", { class: "stack" }, slot,
    h("p", { class: "small muted" }, "ÉcoleDirecte, Skolengo sans Pronote, double authentification obligatoire ? Le robot ne peut pas s'y connecter : utilise le dernier recours."));
}

// ---------- Robot : universités (ADE) ----------
// 1. identifiant + mot de passe de l'université (seule étape qui les utilise) ; 2. l'année ; 3. établissement →
// filière → classe dans l'arborescence d'ADE ; 4. Studoo garde le lien d'export (lisible sans mot de passe).
function adeRobot(u, done, useLastResort) {
  const slot = h("div", { class: "stack" });
  let session = null;
  let project = null;

  const loginForm = () => {
    const user = h("input", { class: "input", id: "ade-user", autocomplete: "username", autocapitalize: "none", spellcheck: false });
    const pass = h("input", { class: "input", id: "ade-pass", type: "password", autocomplete: "current-password" });
    const err = h("p", { class: "error", role: "alert" });
    const submit = h("button", { class: "btn primary", type: "submit" }, icon("check"), "Me connecter");
    setTimeout(() => user.focus(), 0);
    return h("form", { class: "stack", novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      if (!user.value.trim() || !pass.value) { err.textContent = "Identifiant et mot de passe requis."; return; }
      submit.disabled = true;
      submit.replaceChildren(h("span", { class: "spinner", style: { width: "22px", height: "22px" } }), "Connexion à ton université… (10 à 20 s)");
      try {
        const res = await adeLogin(u.base ? { base: u.base, username: user.value.trim(), password: pass.value }
          : { university: u.robot, username: user.value.trim(), password: pass.value });
        session = res.session;
        mount(slot, projectStep(res.projects));
      } catch (e2) {
        err.textContent = e2.message;
      } finally {
        pass.value = ""; // le mot de passe est effacé du formulaire dans tous les cas
        submit.disabled = false;
        submit.replaceChildren(icon("check"), "Me connecter");
      }
    } },
      h("p", { class: "notice", role: "note" }, icon("shield-lock"), " ", PRIVACY_NOTE),
      ROBOT_TESTED.has(u.robot) || u.tested ? null : h("p", { class: "small muted" }, icon("info"),
        " Robot en test pour cette université : s'il n'y arrive pas, utilise le dernier recours."),
      h("div", { class: "field" }, h("label", { for: "ade-user" }, "Identifiant de ton université (ENT)"), user),
      h("div", { class: "field" }, h("label", { for: "ade-pass" }, "Mot de passe"), pass),
      err, h("div", {}, submit),
      h("p", { class: "small muted" }, "Le robot se connecte par la page officielle de ton université, ouvre ADE, puis te laisse choisir ta classe. "
        + "Ton mot de passe ne sert qu'à cette connexion : il n'est jamais enregistré. Studoo garde ensuite seulement le lien d'export de ta classe, qui se lit sans mot de passe."));
  };

  const projectStep = (projects) => {
    const best = guessProject(projects);
    const choices = h("div", { class: "choices", role: "radiogroup" }, projects.map((p) => {
      const id = `ade-p-${p.id}`;
      return h("div", { class: "choice" },
        h("input", { type: "radio", name: "ade-project", id, value: String(p.id), checked: p.id === best?.id }),
        h("label", { for: id }, h("strong", {}, p.name)));
    }));
    return h("div", { class: "stack" },
      h("p", {}, icon("check"), " Connecté ! ", h("strong", {}, "1. Choisis l'année"), " (ADE range les emplois du temps par année ; la plus probable est cochée)."),
      choices,
      h("div", {}, h("button", { class: "btn primary", type: "button", onclick: async (e) => {
        project = Number(slot.querySelector("input[name=ade-project]:checked")?.value);
        e.currentTarget.disabled = true;
        await openLevel([]);
      } }, icon("arrow-right"), "Continuer")));
  };

  // path : dossiers ouverts depuis la racine [{id, name, level}]
  async function openLevel(path) {
    const parent = path[path.length - 1] || null;
    mount(slot, h("div", { class: "loading" }, h("div", { class: "spinner" }), "Lecture d'ADE…"));
    let nodes;
    try {
      nodes = await adeTree(session, project, parent ? { id: parent.id, name: parent.name, level: parent.level } : null).then((r) => r.nodes);
    } catch (e) {
      mount(slot, h("p", { class: "error", role: "alert" }, e.message), h("div", { class: "row" },
        h("button", { class: "btn", type: "button", onclick: () => mount(slot, loginForm()) }, icon("refresh"), "Recommencer"),
        h("button", { class: "btn", type: "button", onclick: () => useLastResort(u) }, "Dernier recours (.ics)")));
      return;
    }
    const filter = h("input", { class: "input", type: "search", placeholder: "Filtrer la liste…", "aria-label": "Filtrer la liste" });
    const list = h("div", { class: "establishments" });
    const choose = async (node, btn) => {
      btn.disabled = true;
      try {
        const res = await adeChoose(session, project, node, u.name);
        session = null; // la session ADE n'est plus utile : oubliée
        toast(`${res.events.length} cours trouvés : ton emploi du temps se mettra à jour tout seul.`, "success", 8000);
        done(res.subjects);
      } catch (e) { btn.disabled = false; toast(e.message, "error", 8000); }
    };
    const paint = () => {
      const q = filter.value.trim().toLowerCase();
      const shown = nodes.filter((n) => !q || n.name.toLowerCase().includes(q));
      mount(list, shown.length ? shown.map((n) => n.folder
        ? h("button", { class: "btn", type: "button", onclick: () => openLevel([...path, n]) }, icon("folder"), h("span", {}, h("strong", {}, n.name)))
        : h("button", { class: "btn c-green", type: "button", style: { color: "var(--on-fluo)" }, onclick: (e) => choose(n, e.currentTarget) },
          icon("check"), h("span", {}, h("strong", {}, n.name), h("span", { class: "small" }, " · c'est ma classe"))))
        : h("p", { class: "small muted" }, "Rien ne correspond."));
    };
    filter.addEventListener("input", paint);
    paint();
    const step = path.length === 0 ? "2. Choisis ton établissement (ou ta composante)" : nodes.some((n) => !n.folder) ? "Dernière étape : choisis ta classe" : "Continue : ta filière, ton année…";
    mount(slot,
      h("nav", { class: "crumbs", "aria-label": "Position dans ADE" },
        h("button", { class: "btn small ghost", type: "button", onclick: () => openLevel([]) }, "ADE"),
        path.map((p, i) => [icon("chevron-right"), h("button", { class: "btn small ghost", type: "button", onclick: () => openLevel(path.slice(0, i + 1)) }, p.name)])),
      h("p", {}, h("strong", {}, step)),
      nodes.length > 10 ? filter : null,
      list,
      parent ? h("p", { class: "small muted" }, "Ta classe n'est pas dans la liste ? ",
        h("button", { class: "btn small", type: "button", onclick: (e) => choose({ ...parent, path: parent.name }, e.currentTarget) }, "Prendre tout « ", parent.name, " »")) : null);
  }

  mount(slot, loginForm());
  return slot;
}

// ---------- Robot : Celcat ----------
function celcatRobot(school, sys, done) {
  const slot = h("div", { class: "stack" });
  let session = "";
  const search = () => {
    const input = h("input", { class: "input", id: "celcat-q", type: "search", autocomplete: "off", placeholder: "Ex. : L1 INFO, TD2, M1 Droit…" });
    const results = h("div", { class: "establishments", "aria-live": "polite" });
    let timer = 0;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { mount(results); return; }
      timer = setTimeout(async () => {
        mount(results, h("p", { class: "small muted" }, "Recherche…"));
        try {
          const groups = await celcatGroups(sys.base, q, session);
          mount(results, groups.length ? groups.map((g) => h("button", { class: "btn", type: "button", onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              const res = await celcatChoose(sys.base, g, session, school);
              toast(res.method === "celcat" ? `${res.events.length} cours trouvés : ton emploi du temps se mettra à jour tout seul.`
                : `${res.events.length} cours récupérés. Studoo te rappellera de te reconnecter dans ${RECONNECT_DAYS} jours.`, "success", 9000);
              done(res.subjects);
            } catch (e2) { toast(e2.message, "error", 8000); }
          } }, icon("check"), h("span", {}, h("strong", {}, g.name), g.dept ? h("span", { class: "small muted" }, ` · ${g.dept}`) : null)))
            : h("p", { class: "small muted" }, "Aucun groupe trouvé : essaie un autre mot (sigle de la formation, n° de TD…)."));
        } catch (e) {
          if (/connexion/i.test(e.message) && !session) mount(slot, loginForm()); else mount(results, h("p", { class: "error" }, e.message));
        }
      }, 350);
    });
    setTimeout(() => input.focus(), 0);
    return h("div", { class: "stack" },
      h("div", { class: "field" }, h("label", { for: "celcat-q" }, "Ton groupe (formation, année, TD…)"), input,
        h("span", { class: "hint" }, "Cherche dans l'emploi du temps Celcat de ton établissement.")),
      results);
  };
  const loginForm = () => {
    const user = h("input", { class: "input", id: "cc-user", autocomplete: "username", autocapitalize: "none", spellcheck: false });
    const pass = h("input", { class: "input", id: "cc-pass", type: "password", autocomplete: "current-password" });
    const err = h("p", { class: "error", role: "alert" });
    const submit = h("button", { class: "btn primary", type: "submit" }, icon("check"), "Me connecter");
    return h("form", { class: "stack", novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      if (!user.value.trim() || !pass.value) { err.textContent = "Identifiant et mot de passe requis."; return; }
      submit.disabled = true;
      try {
        session = await celcatLogin({ base: sys.base, username: user.value.trim(), password: pass.value });
        mount(slot, search());
      } catch (e2) { err.textContent = e2.message; } finally { pass.value = ""; submit.disabled = false; }
    } },
      h("p", { class: "notice", role: "note" }, icon("shield-lock"), " ", PRIVACY_NOTE),
      h("p", { class: "small muted" }, icon("info"), " Robot Celcat en test : s'il n'y arrive pas, utilise le dernier recours."),
      h("div", { class: "field" }, h("label", { for: "cc-user" }, "Identifiant de ton établissement (ENT)"), user),
      h("div", { class: "field" }, h("label", { for: "cc-pass" }, "Mot de passe"), pass),
      err, h("div", {}, submit));
  };
  mount(slot, sys.login ? loginForm() : search());
  return slot;
}

// ---------- Supérieur : chercher son établissement, détecter son logiciel, lancer le bon robot ----------
function universityTab(useLastResort, done) {
  const slot = h("div", { class: "stack" });

  async function chosen(school) {
    const head = h("p", {}, icon("school"), " ", h("strong", {}, school.name), school.city ? h("span", { class: "small muted" }, ` · ${school.city} `) : " ",
      h("button", { class: "btn small ghost", type: "button", onclick: () => mount(slot, finder()) }, "Changer"));
    mount(slot, head, h("div", { class: "loading" }, h("div", { class: "spinner" }), "Studoo cherche le logiciel d'emploi du temps de ton établissement…"));
    let systems = [];
    try { systems = await higherDetect(school.domain); } catch (e) { toast(e.message, "error"); }
    const sys = systems.find((x) => x.software === "ade" && !x.native) || systems.find((x) => x.software === "celcat") || systems[0];
    if (sys?.software === "ade" && !sys.native) {
      mount(slot, head, h("p", { class: "small muted" }, icon("check"), ` Emploi du temps trouvé : ${sys.name}.`),
        adeRobot({ name: school.name, base: sys.base, tested: sys.base.includes("u-pariscite.fr") }, done, () => useLastResort({ name: school.name, software: sys })));
      return;
    }
    if (sys?.software === "celcat") {
      mount(slot, head, h("p", { class: "small muted" }, icon("check"), ` Emploi du temps trouvé : ${sys.name}.`), celcatRobot(school, sys, done));
      return;
    }
    const why = !sys ? "Studoo n'a pas reconnu le logiciel d'emploi du temps de ton établissement."
      : sys.native ? `Ton établissement utilise ${sys.name} avec des identifiants propres à ADE : le robot ne sait pas encore s'y connecter.`
        : `Ton établissement utilise ${sys.name} : le robot ne sait pas encore s'y connecter.`;
    mount(slot, head, h("p", { class: "card sketch small" }, icon("info"), " ", why, " Le dernier recours prend 2 minutes : Studoo te guide."),
      h("div", {}, h("button", { class: "btn primary", type: "button", onclick: () => useLastResort({ name: school.name, software: sys }) }, icon("arrow-right"), "Continuer avec le dernier recours")));
  }

  function finder() {
    const input = h("input", { class: "input", id: "uni-q", type: "search", autocomplete: "off", placeholder: "Ex. : Paris Cité, IUT Rives de Seine, INSA Lyon…" });
    const results = h("div", { class: "establishments", "aria-live": "polite" });
    let timer = 0;
    let seq = 0;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 3) { mount(results); return; }
      timer = setTimeout(async () => {
        const mine = ++seq;
        mount(results, h("p", { class: "small muted" }, "Recherche…"));
        try {
          const schools = await higherSearch(q);
          if (mine !== seq) return;
          mount(results, schools.length ? schools.map((sc) => h("button", { class: "btn", type: "button", onclick: () => chosen(sc) },
            icon("school"), h("span", {}, h("strong", {}, sc.name), sc.city ? h("span", { class: "small muted" }, ` · ${sc.city}`) : null)))
            : h("p", { class: "small muted" }, "Aucun établissement trouvé : essaie avec la ville ou le sigle."));
        } catch (e) { if (mine === seq) mount(results, h("p", { class: "error" }, e.message)); }
      }, 350);
    });
    setTimeout(() => input.focus(), 0);
    return h("div", { class: "stack" },
      h("div", { class: "field" }, h("label", { for: "uni-q" }, "Ton université ou ton école (nom, sigle ou ville)"), input,
        h("span", { class: "hint" }, "Annuaire officiel de l'Enseignement supérieur.")),
      results,
      h("p", { class: "small muted" }, "Studoo reconnaît ADE et Celcat et s'y connecte pour toi. HyperPlanning, Aurion et les autres : dernier recours guidé."));
  }

  mount(slot, finder());
  return slot;
}

function lastResortTab(done, establishment) {
  const u = establishment;
  return h("div", { class: "stack" },
    h("p", { class: "small muted" }, "Seulement si le robot ne peut pas se connecter à ton service. C'est la seule option où tu fournis toi-même un lien ou un fichier."),
    u ? h("p", {}, icon("school"), " ", h("strong", {}, u.name),
      u.url ? [" · ", h("a", { href: u.url, target: "_blank", rel: "noopener" }, u.url.replace("https://", ""))] : null) : null,
    icsForm({
      steps: u ? u.steps || LAST_RESORT_STEPS[u.software?.software] || ICAL_STEPS_UNIVERSITY : ICAL_STEPS_PRONOTE,
      open: u?.ade ? { url: u.ade, label: "Ouvrir l'emploi du temps ADE (connexion officielle)" } : null,
      onDone: done, extra: u ? { establishment: u.name } : {},
    }),
    h("p", { class: "small muted" }, icon("shield-lock"), " Studoo garde seulement le lien, chiffré, dans ton Drive, et l'actualise tout seul."),
    h("hr"), icsFileForm(done));
}

function afterImport(go) {
  return (subjects) => {
    clearTimetableCache();
    if (subjects?.length) toast("Astuce : dans « Mes cours », crée tous tes dossiers de matières d'un clic.", "info", 8000);
    go("/emploi-du-temps", { replace: true });
  };
}

function addPanel(go, { reconnect = null } = {}) {
  const done = afterImport(go);
  let establishment = null;
  const tabs = [
    ["Je suis au lycée", () => highSchoolTab(done, reconnect)],
    ["Je suis étudiant·e", () => universityTab((u) => { establishment = u; select(2); }, done)],
    ["Dernier recours : .ics", () => lastResortTab(done, establishment)],
  ];
  const panel = h("div", { style: { marginTop: "14px" } });
  const buttons = tabs.map(([label], i) => h("button", { class: "btn", type: "button", role: "tab", "aria-selected": "false", onclick: () => { if (i !== 2) establishment = null; select(i); } }, label));
  function select(i) {
    buttons.forEach((b, j) => { b.setAttribute("aria-selected", String(i === j)); b.classList.toggle("primary", i === j); });
    mount(panel, tabs[i][1]());
  }
  select(0);
  return h("section", { class: "card sketch", id: "ajouter", style: { marginTop: "26px" } }, h("span", { class: "tape" }),
    h("h2", { style: { fontSize: "30px", marginBottom: "10px" } }, reconnect ? "Mettre à jour ton emploi du temps" : "Ajouter un emploi du temps"),
    h("div", { class: "row", role: "tablist" }, buttons), panel);
}

export async function render({ view, query, go }) {
  const settings = await getSettings();
  const sources = settings.timetable?.sources || [];
  const offset = Number(query.get("semaine") || 0);
  const monday = mondayOf(new Date());
  monday.setDate(monday.getDate() + offset * 7);
  let events = [];
  let error = null;
  if (sources.length) {
    try { events = await loadEvents(); } catch (e) { error = e; }
  }
  const stale = staleSources(sources);
  const reconnectOf = (s) => (s.uai ? { uai: s.uai, name: s.school || s.label, city: s.city || "" } : null);
  const reconnect = (s) => {
    const finish = (close) => (x) => { close(); afterImport(go)(x); };
    if (s.higher) { // source Celcat protégée : on refait le parcours étudiant
      openDialog("Mettre à jour ton emploi du temps", (close) => universityTab(() => { close(); go("/emploi-du-temps#ajouter"); }, finish(close)));
      return;
    }
    openDialog("Mettre à jour ton emploi du temps", (close) => highSchoolTab(finish(close), reconnectOf(s)));
  };

  mount(view,
    h("h1", { class: "view-title" }, "Emploi du ", h("span", { class: "hl" }, "temps")),
    stale.length ? h("p", { class: "notice", role: "status" }, icon("refresh"),
      ` Ton emploi du temps date de plus de ${RECONNECT_DAYS} jours : reconnecte-toi pour le mettre à jour. `,
      h("button", { class: "btn small", type: "button", onclick: () => reconnect(stale[0]) }, "Me reconnecter")) : null,
    sources.length ? [
      h("div", { class: "row", style: { margin: "10px 0 16px" } },
        h("a", { class: "btn small", href: `/emploi-du-temps?semaine=${offset - 1}`, "data-link": "1", "aria-label": "Semaine précédente" }, icon("arrow-left")),
        h("strong", {}, `Semaine du ${monday.toLocaleDateString("fr-FR", { day: "numeric", month: "long" })}`),
        h("a", { class: "btn small", href: `/emploi-du-temps?semaine=${offset + 1}`, "data-link": "1", "aria-label": "Semaine suivante" }, icon("arrow-right")),
        h("span", { class: "spacer" }),
        h("button", { class: "btn small", onclick: async () => { clearTimetableCache(); go(location.pathname + location.search, { replace: true }); } }, icon("refresh"), "Actualiser")),
      error ? h("p", { class: "card sketch error" }, `Synchronisation impossible : ${error.message}`) : null,
      weekView(events, monday),
      h("h2", { class: "section" }, "Sources connectées"),
      h("ul", { class: "files card sketch" }, sources.map((s) => h("li", {},
        h("span", { class: "kind c-lilac" }, icon(s.type === "snapshot" || /pronote/i.test(s.label || "") ? "school" : "link")),
        h("span", {}, h("strong", {}, s.label || s.type), s.establishment ? h("span", { class: "small muted" }, ` · ${s.establishment}`) : null,
          s.type === "snapshot" ? h("span", { class: "small muted" }, ` · récupéré le ${new Date(s.syncedAt).toLocaleDateString("fr-FR")}`) : null),
        h("span", { class: "meta" },
          s.type === "snapshot" ? h("button", { class: "btn small", onclick: () => reconnect(s) }, icon("refresh"), "Mettre à jour") : null,
          h("button", { class: "btn small danger", title: "Supprime le jeton chiffré : Studoo ne pourra plus lire cet emploi du temps", onclick: async () => { await removeSource(s.id); toast("Déconnecté : le jeton a été supprimé.", "success"); go(location.pathname, { replace: true }); } }, icon("logout"), "Déconnecter"))))),
    ] : h("p", { class: "muted" }, "Connecte ton emploi du temps : Studoo saura quel cours tu enregistres et créera tes dossiers de matières."),
    addPanel(go));
}
