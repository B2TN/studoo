// Tableau de bord : les outils en post-it, les cours du jour, les cours, les fichiers récents.
import { h, mount } from "../lib/dom.js";
import { longDate, plural, relativeDate, time } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { drive, HIDDEN_KINDS, KINDS, kindOf } from "../lib/storage.js";
import { eventsOfDay, lessonAt, loadEvents, nextLesson } from "../lib/timetable-data.js";

const TOOLS = [
  ["/enregistrer", "pink", "microphone", "Enregistrer un cours", "Transcription avec « Prof : » / « Élève : »"],
  ["/numeriser", "yellow", "camera", "Numériser une feuille", "Photo → PDF tout propre"],
  ["/creer/fiche", "green", "notes", "Créer une fiche", "L'essentiel, rien que tes cours"],
  ["/creer/podcast", "blue", "headphones", "Faire un podcast", "10, 20 ou 30 min à écouter"],
  ["/creer/video", "orange", "movie", "Faire une vidéo", "Format TikTok, YouTube ou long"],
  ["/importer", "lilac", "file-upload", "Importer un PDF", "Range-le dans un chapitre"],
];

const firstName = (user) => (user.name || "").split(" ")[0] || "toi";

export function mascotSvg() {
  return h("img", { class: "mascot doodle", src: "/favicon.svg", alt: "", width: 74, height: 74 });
}

export function fileRow(file, { extra = [] } = {}) {
  const kind = kindOf(file);
  const meta = KINDS[kind] || { label: "Fichier", icon: "file", color: "yellow" };
  return h("li", {},
    ...extra,
    h("span", { class: `kind c-${meta.color}`, title: meta.label }, icon(meta.icon)),
    h("span", {}, h("a", { class: "name", href: `/fichier/${file.id}`, "data-link": "1" }, file.name.replace(/\.(md|json)$/i, "")),
      h("br"), h("small", { class: "muted" }, meta.label)),
    h("span", { class: "meta" }, relativeDate(file.modifiedTime)));
}

function todayCard(events) {
  const now = new Date();
  const today = eventsOfDay(events, now);
  const current = lessonAt(events, now);
  const list = today.length
    ? h("ol", { class: "timeline" }, today.map((e) => h("li", { class: [e === current ? "now" : "", e.cancelled ? "cancelled" : ""].join(" ") },
      h("time", { datetime: e.start }, time(e.start)), h("span", { class: "dot c-yellow" }),
      h("span", {}, e.subject, e === current ? h("span", { class: "badge", style: { marginLeft: "6px" } }, "maintenant") : null,
        e.cancelled ? h("span", { class: "badge", style: { marginLeft: "6px" } }, "annulé") : null,
        h("span", { class: "room" }, [e.location, e.title !== e.subject ? e.title.split(" - ").slice(1).join(" · ") : ""].filter(Boolean).join(" · "))))))
    : h("p", { class: "muted" }, events.length ? "Pas de cours aujourd'hui. Profites-en !" : "Ajoute ton emploi du temps pour voir tes cours ici.");
  return h("section", { class: "card sketch", "aria-labelledby": "t-today" },
    h("h3", { id: "t-today" }, icon("calendar-week", { doodle: true }), "Aujourd'hui",
      h("a", { href: "/emploi-du-temps", "data-link": "1" }, events.length ? "Toute la semaine" : "Ajouter")),
    list);
}

function coursesCard(tree) {
  return h("section", { class: "card sketch", "aria-labelledby": "t-courses" },
    h("span", { class: "tape" }),
    h("h3", { id: "t-courses" }, icon("folders", { doodle: true }), "Mes cours", h("a", { href: "/cours", "data-link": "1" }, "Tout voir")),
    tree.length
      ? h("div", { class: "folders" }, tree.slice(0, 6).map((c) => h("a", { class: "folder sketch", href: `/cours/${c.id}`, "data-link": "1" },
        h("span", { class: `spine c-${c.color}` }), h("strong", {}, c.name), h("span", {}, plural(c.chapters.length, "chapitre")))))
      : h("div", { class: "empty" }, h("p", {}, "Aucun cours pour l'instant."),
        h("a", { class: "btn primary", href: "/cours", "data-link": "1" }, icon("folder-plus"), "Créer mon premier cours")));
}

export async function render({ view, user }) {
  const [tree, recent, events] = await Promise.all([
    drive.tree(),
    drive.recent(14).then((list) => list.filter((f) => !HIDDEN_KINDS.has(kindOf(f))).slice(0, 6)),
    loadEvents().catch(() => []),
  ]);
  const next = nextLesson(events);
  const todayCount = eventsOfDay(events).filter((e) => !e.cancelled).length;
  const subtitle = [longDate(), events.length ? plural(todayCount, "cours") + " aujourd'hui" : null,
    next ? `prochain : ${next.subject} à ${time(next.start)}` : null].filter(Boolean).join(" · ");

  mount(view,
    h("section", { class: "hello" }, mascotSvg(),
      h("div", {}, h("h1", {}, "Salut ", h("span", { class: "hl" }, firstName(user)), " !"), h("p", {}, subtitle))),
    h("h2", { class: "section" }, "Qu'est-ce qu'on fait ?"),
    h("div", { class: "tools" }, TOOLS.map(([href, color, ic, title, sub]) =>
      h("a", { class: `postit c-${color}`, href, "data-link": "1" }, h("span", { class: "tape" }), icon(ic, { doodle: true }),
        h("strong", {}, title), h("small", {}, sub)))),
    h("div", { class: "cols" }, todayCard(events), coursesCard(tree)),
    h("h2", { class: "section" }, h("span", { class: "hl pink" }, "Récemment")),
    h("section", { class: "card sketch" }, recent.length
      ? h("ul", { class: "files" }, recent.map((f) => fileRow(f)))
      : h("p", { class: "empty" }, "Tes transcriptions, fiches, podcasts et vidéos apparaîtront ici.")));
}
