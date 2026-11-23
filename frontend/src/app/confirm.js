// Page de confirmation : « De quel cours s'agit-il ? »
// Studoo propose une estimation (emploi du temps + IA) et un titre automatique ;
// l'élève valide ou choisit / crée un autre cours et chapitre.
import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { longDate } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { dropPending, getPending } from "../lib/pending.js";
import { COLORS, drive, safeName } from "../lib/storage.js";
import { lessonAt, loadEvents } from "../lib/timetable-data.js";
import { errorToast, toast } from "../lib/ui.js";

const NEW = "__new__";
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/** Trouve le cours existant le plus proche d'un nom (ex. « Maths » ≈ « Mathématiques »). */
export function findCourse(tree, name) {
  const n = norm(name);
  if (!n) return null;
  return tree.find((c) => norm(c.name) === n)
    || tree.find((c) => norm(c.name).startsWith(n.slice(0, 5)) || n.startsWith(norm(c.name).slice(0, 5)))
    || null;
}

export async function estimate(doc, tree) {
  let hint = "";
  try {
    const events = await loadEvents();
    const lesson = lessonAt(events, doc.startedAt ? new Date(doc.startedAt) : new Date());
    if (lesson) hint = lesson.subject;
  } catch { /* pas d'emploi du temps */ }
  let ai = null;
  try {
    ai = await api("/api/ai/classify", { method: "POST", json: {
      excerpt: doc.excerpt.slice(0, 8000), kind: doc.kind, hint,
      tree: tree.slice(0, 80).map((c) => ({ course: c.name, chapters: c.chapters.map((ch) => ch.name).slice(0, 60) })),
    } });
  } catch (err) {
    toast(`Estimation automatique indisponible : ${err.message}`, "info");
  }
  const course = findCourse(tree, hint) || findCourse(tree, ai?.course);
  const chapter = course ? course.chapters.find((ch) => norm(ch.name) === norm(ai?.chapter)) : null;
  return {
    course, chapter,
    newCourse: course ? "" : (ai?.course || hint || ""),
    newChapter: chapter ? "" : (ai?.chapter || ""),
    title: ai?.title || `Cours du ${longDate(doc.startedAt ? new Date(doc.startedAt) : new Date()).toLowerCase()}`,
    fromTimetable: Boolean(hint && course && norm(course.name) === norm(findCourse(tree, hint)?.name)),
    confidence: ai?.confidence ?? null,
  };
}

export async function render({ view, query, go }) {
  const doc = getPending(query.get("id"));
  if (!doc) {
    mount(view, h("div", { class: "empty" }, h("p", {}, "Rien à ranger pour l'instant."), h("a", { class: "btn", href: "/", "data-link": "1" }, "Retour")));
    return;
  }
  mount(view, h("div", { class: "loading" }, h("div", { class: "spinner" }), "Studoo devine de quel cours il s'agit…"));
  const tree = await drive.tree();
  const guess = await estimate(doc, tree);

  const courseSel = h("select", { class: "input", id: "c-course", required: true },
    tree.map((c) => h("option", { value: c.id, selected: guess.course?.id === c.id }, c.name)),
    h("option", { value: NEW, selected: !guess.course }, "+ Nouveau cours…"));
  const newCourse = h("input", { class: "input", id: "c-newcourse", maxlength: 80, value: guess.newCourse, placeholder: "Mathématiques" });
  const chapterSel = h("select", { class: "input", id: "c-chapter" });
  const newChapter = h("input", { class: "input", id: "c-newchapter", maxlength: 80, value: guess.newChapter, placeholder: "Ch. 3 — Les suites" });
  const title = h("input", { class: "input", id: "c-title", maxlength: 90, required: true, value: guess.title });
  const errors = h("p", { class: "error", role: "alert" });
  const newCourseField = h("div", { class: "field" }, h("label", { for: "c-newcourse" }, "Nom du nouveau cours"), newCourse);
  const newChapterField = h("div", { class: "field" }, h("label", { for: "c-newchapter" }, "Nom du nouveau chapitre"), newChapter);

  const fillChapters = () => {
    const course = tree.find((c) => c.id === courseSel.value);
    newCourseField.hidden = Boolean(course);
    const chapters = course?.chapters || [];
    mount(chapterSel,
      chapters.map((ch) => h("option", { value: ch.id, selected: guess.chapter?.id === ch.id }, ch.name)),
      h("option", { value: NEW, selected: !guess.chapter || !course || guess.course?.id !== course.id }, "+ Nouveau chapitre…"));
    newChapterField.hidden = chapterSel.value !== NEW;
  };
  courseSel.addEventListener("change", fillChapters);
  chapterSel.addEventListener("change", () => { newChapterField.hidden = chapterSel.value !== NEW; });
  fillChapters();

  const submit = h("button", { class: "btn primary big", type: "submit" }, icon("check"), "Ranger dans mon Drive");
  const form = h("form", { class: "card sketch stack", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    errors.textContent = "";
    const courseIsNew = courseSel.value === NEW;
    const chapterIsNew = chapterSel.value === NEW;
    if (courseIsNew && !newCourse.value.trim()) { errors.textContent = "Donne un nom au nouveau cours."; newCourse.focus(); return; }
    if (chapterIsNew && !newChapter.value.trim()) { errors.textContent = "Donne un nom au nouveau chapitre."; newChapter.focus(); return; }
    if (!title.value.trim()) { errors.textContent = "Le titre ne peut pas être vide."; title.focus(); return; }
    submit.disabled = true;
    submit.replaceChildren(h("span", { class: "spinner", style: { width: "22px", height: "22px" } }), "Enregistrement…");
    try {
      const course = courseIsNew
        ? await drive.createCourse(safeName(newCourse.value, 80), COLORS[tree.length % COLORS.length])
        : tree.find((c) => c.id === courseSel.value);
      const chapter = chapterIsNew ? await drive.createChapter(course.id, safeName(newChapter.value, 80)) : { id: chapterSel.value };
      const file = await doc.save(chapter.id, safeName(title.value));
      dropPending(doc.id);
      toast("Rangé dans ton Drive !", "success");
      go(`/fichier/${file.id}`, { replace: true });
    } catch (err) {
      errorToast(err);
      submit.disabled = false;
      submit.replaceChildren(icon("check"), "Réessayer");
    }
  } },
    h("div", { class: "field" }, h("label", { for: "c-course" }, "Cours"), courseSel,
      guess.fromTimetable ? h("span", { class: "hint" }, "Proposé d'après ton emploi du temps") : guess.confidence !== null ? h("span", { class: "hint" }, "Proposé par l'IA") : null),
    newCourseField,
    h("div", { class: "field" }, h("label", { for: "c-chapter" }, "Chapitre"), chapterSel),
    newChapterField,
    h("div", { class: "field" }, h("label", { for: "c-title" }, "Titre (généré automatiquement)"), title),
    errors,
    h("div", { class: "row" }, submit));

  mount(view,
    h("h1", { class: "view-title" }, "De quel cours ", h("span", { class: "hl" }, "s'agit-il"), " ?"),
    h("p", { class: "muted" }, "Vérifie l'estimation de Studoo, ou choisis un autre cours et chapitre."),
    form,
    h("details", { class: "card sketch", style: { marginTop: "20px" } },
      h("summary", {}, "Aperçu du contenu"), h("p", { class: "small", style: { whiteSpace: "pre-wrap", marginTop: "10px" } }, doc.excerpt.slice(0, 1500))));
}
