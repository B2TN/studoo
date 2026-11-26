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
import { addSource, clearTimetableCache, loadEvents, removeSource, RECONNECT_DAYS, robotConnect, staleSources } from "../lib/timetable-data.js";
import { detectSoftware, ICAL_STEPS_PRONOTE, ICAL_STEPS_UNIVERSITY, UNIVERSITIES } from "../lib/establishments.js";
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

function universityTab(useLastResort) {
  return h("div", { class: "stack" },
    h("p", { class: "card sketch small" }, icon("bulb"), " ",
      h("strong", {}, "La connexion automatique des universités n'est pas encore prête. "),
      "Chaque université cache son emploi du temps (ADE, Celcat, HyperPlanning…) derrière sa propre page de connexion : "
      + "le robot doit être construit et testé université par université. En attendant, choisis la tienne : Studoo te guide pour le dernier recours."),
    h("div", { class: "establishments" }, [...UNIVERSITIES, { name: "Autre établissement", city: "", url: "" }].map((u) =>
      h("button", { class: "btn", type: "button", onclick: () => useLastResort(u) },
        icon("school"), h("span", {}, h("strong", {}, u.name), u.city ? h("span", { class: "small muted" }, ` · ${u.city}`) : null)))));
}

function lastResortTab(done, establishment) {
  const u = establishment;
  return h("div", { class: "stack" },
    h("p", { class: "small muted" }, "Seulement si le robot ne peut pas se connecter à ton service. C'est la seule option où tu fournis toi-même un lien ou un fichier."),
    u ? h("p", {}, icon("school"), " ", h("strong", {}, u.name),
      u.url ? [" · ", h("a", { href: u.url, target: "_blank", rel: "noopener" }, u.url.replace("https://", ""))] : null) : null,
    icsForm({
      steps: u ? u.steps || ICAL_STEPS_UNIVERSITY : ICAL_STEPS_PRONOTE,
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
    ["Je suis étudiant·e", () => universityTab((u) => { establishment = u; select(2); })],
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
    const preset = reconnectOf(s);
    openDialog("Mettre à jour ton emploi du temps", (close) => highSchoolTab((x) => { close(); afterImport(go)(x); }, preset));
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
