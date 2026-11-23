// Explorateur de fichiers : cours → chapitres → fichiers (dans le Google Drive).
import { h, mount } from "../lib/dom.js";
import { plural } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { COLORS, drive, isFolder, kindOf, safeName, SOURCE_KINDS } from "../lib/storage.js";
import { loadEvents, subjectsOf } from "../lib/timetable-data.js";
import { confirmDialog, errorToast, openDialog, toast } from "../lib/ui.js";
import { fileRow } from "./dashboard.js";

const COLOR_NAMES = { yellow: "Jaune", pink: "Rose", green: "Vert", blue: "Bleu", orange: "Orange", lilac: "Lilas" };

/** Fenêtre « nom (+ couleur) » réutilisée pour créer / renommer. */
export function askName({ title, label, value = "", withColor = false, color = "yellow", ok = "Valider" }) {
  return new Promise((resolve) => {
    openDialog(title, (close) => {
      const input = h("input", { class: "input", id: "dlg-name", value, maxlength: 80, required: true, autocomplete: "off" });
      const err = h("p", { class: "error", id: "dlg-err", "aria-live": "polite" });
      let picked = color;
      const swatches = withColor ? h("fieldset", { class: "field", style: { border: "none", padding: 0 } },
        h("legend", { class: "label" }, "Couleur"),
        h("div", { class: "row" }, COLORS.map((c) => {
          const id = `col-${c}`;
          return h("span", { class: "choice" },
            h("input", { type: "radio", name: "color", id, value: c, checked: c === color, onchange: () => { picked = c; } }),
            h("label", { for: id, class: `c-${c}`, style: { color: "var(--on-fluo)", padding: "6px 12px" } }, COLOR_NAMES[c]));
        }))) : null;
      const form = h("form", { class: "stack", novalidate: true, onsubmit: (e) => {
        e.preventDefault();
        const name = safeName(input.value, 80);
        if (!input.value.trim()) { err.textContent = "Donne un nom."; input.setAttribute("aria-invalid", "true"); input.focus(); return; }
        close({ name, color: picked });
      } },
        h("div", { class: "field" }, h("label", { for: "dlg-name" }, label), input, err),
        swatches,
        h("div", { class: "row", style: { justifyContent: "flex-end" } }, h("button", { class: "btn primary", type: "submit" }, ok)));
      setTimeout(() => input.focus(), 30);
      return form;
    }, { onClose: resolve });
  });
}

function folderCard(href, color, name, sub) {
  return h("a", { class: "folder sketch", href, "data-link": "1" }, h("span", { class: `spine c-${color}` }), h("strong", {}, name), h("span", {}, sub));
}

async function createCourseFlow(go) {
  const res = await askName({ title: "Nouveau cours", label: "Nom de la matière", withColor: true, ok: "Créer" });
  if (!res) return;
  const c = await drive.createCourse(res.name, res.color);
  toast(`Cours « ${c.name} » créé`, "success");
  go(`/cours/${c.id}`);
}

async function importSubjects(tree, rerender) {
  let events = [];
  try { events = await loadEvents({ force: true }); } catch (err) { errorToast(err); return; }
  const existing = new Set(tree.map((c) => c.name.toLowerCase()));
  const subjects = subjectsOf(events).filter((s) => !existing.has(s.toLowerCase()));
  if (!events.length) { toast("Ajoute d'abord ton emploi du temps.", "info"); return; }
  if (!subjects.length) { toast("Toutes tes matières ont déjà un dossier.", "success"); return; }
  openDialog("Créer les dossiers des matières", (close) => {
    const boxes = subjects.map((s, i) => h("label", { class: "check" }, h("input", { type: "checkbox", value: s, checked: true, id: `sub-${i}` }), s));
    return h("form", { class: "stack", onsubmit: async (e) => {
      e.preventDefault();
      const chosen = boxes.map((b) => b.querySelector("input")).filter((i) => i.checked).map((i) => i.value);
      close(null);
      for (const [i, name] of chosen.entries()) await drive.createCourse(name, COLORS[i % COLORS.length]);
      toast(`${plural(chosen.length, "dossier")} créé${chosen.length > 1 ? "s" : ""}`, "success");
      rerender();
    } }, h("p", {}, "Matières trouvées dans ton emploi du temps :"), ...boxes,
    h("div", { class: "row", style: { justifyContent: "flex-end" } }, h("button", { class: "btn primary", type: "submit" }, "Créer les dossiers")));
  });
}

async function renderCourses(ctx) {
  const { view, go, query } = ctx;
  const q = query.get("q");
  const tree = await drive.tree();
  const results = q ? await drive.search(q) : null;
  mount(view,
    h("h1", { class: "view-title" }, q ? h("span", {}, "Recherche : ", h("span", { class: "hl" }, q)) : "Mes cours"),
    results ? h("section", { class: "card sketch", style: { marginBottom: "24px" } },
      results.length ? h("ul", { class: "files" }, results.map((f) => fileRow(f))) : h("p", { class: "empty" }, "Aucun fichier ne correspond.")) : null,
    h("div", { class: "row", style: { margin: "10px 0 22px" } },
      h("button", { class: "btn primary", onclick: () => createCourseFlow(go).catch(errorToast) }, icon("folder-plus"), "Nouveau cours"),
      h("button", { class: "btn", onclick: () => importSubjects(tree, () => renderCourses(ctx)).catch(errorToast) }, icon("calendar-week"), "Créer depuis l'emploi du temps"),
      h("a", { class: "btn", href: "/importer", "data-link": "1" }, icon("file-upload"), "Importer un PDF")),
    tree.length
      ? h("div", { class: "folders" }, tree.map((c) => folderCard(`/cours/${c.id}`, c.color, c.name, plural(c.chapters.length, "chapitre"))))
      : h("div", { class: "empty card sketch" }, h("p", {}, "Crée un dossier par matière (Maths, Histoire…), puis des chapitres dedans."),
        h("p", { class: "small" }, "Astuce : si tu as ajouté ton emploi du temps, Studoo peut créer tous les dossiers d'un coup.")));
}

function selectionBar(selected, files, { go, course, chapter }) {
  const bar = h("div", { class: "selection-bar card sketch", hidden: true, role: "region", "aria-label": "Actions sur la sélection" });
  const update = () => {
    const chosen = files.filter((f) => selected.has(f.id));
    const sources = chosen.filter((f) => SOURCE_KINDS.has(kindOf(f)));
    bar.hidden = chosen.length === 0;
    const toCreate = (type) => go(`/creer/${type}`, { data: { fileIds: sources.map((f) => f.id), courseId: course.id, chapterId: chapter?.id } });
    mount(bar,
      h("strong", {}, plural(chosen.length, "sélectionné")), h("span", { class: "spacer" }),
      sources.length ? [
        h("button", { class: "btn small c-green", onclick: () => toCreate("fiche") }, icon("notes"), "Fiche"),
        h("button", { class: "btn small c-blue", onclick: () => toCreate("podcast") }, icon("headphones"), "Podcast"),
        h("button", { class: "btn small c-orange", onclick: () => toCreate("video") }, icon("movie"), "Vidéo"),
      ] : null,
      h("button", { class: "btn small danger", onclick: async () => {
        if (!(await confirmDialog("Mettre à la corbeille ?", `${plural(chosen.length, "fichier")} ira dans la corbeille de ton Google Drive (récupérable pendant 30 jours).`, { ok: "Mettre à la corbeille", danger: true }))) return;
        for (const f of chosen) await drive.trash(f.id);
        toast("Mis à la corbeille", "success");
        go(location.pathname, { replace: true });
      } }, icon("trash"), "Supprimer"));
  };
  return { bar, update };
}

async function fileActions(file, ctx, tree) {
  const rename = async () => {
    const res = await askName({ title: "Renommer", label: "Nouveau nom", value: file.name.replace(/\.(md|json|pdf|mp3|mp4)$/i, "") });
    if (!res) return;
    const ext = (file.name.match(/\.(md|json|pdf|mp3|mp4)$/i) || [""])[0];
    await drive.rename(file.id, res.name + ext);
    ctx.go(location.pathname, { replace: true });
  };
  const move = () => openDialog("Déplacer vers…", (close) => h("div", { class: "stack" },
    ...tree.map((c) => h("div", {}, h("strong", {}, c.name),
      h("div", { class: "row", style: { marginTop: "6px" } }, [{ id: c.id, name: "(racine du cours)" }, ...c.chapters].map((ch) =>
        h("button", { class: "btn small", disabled: file.parents?.[0] === ch.id, onclick: async () => {
          await drive.move(file.id, file.parents[0], ch.id);
          close(null); toast("Déplacé", "success"); ctx.go(location.pathname, { replace: true });
        } }, ch.name)))))));
  return h("span", { class: "actions" },
    h("button", { class: "btn icon-btn ghost", title: "Renommer", "aria-label": `Renommer ${file.name}`, onclick: () => rename().catch(errorToast) }, icon("edit")),
    h("button", { class: "btn icon-btn ghost", title: "Déplacer", "aria-label": `Déplacer ${file.name}`, onclick: move }, icon("arrow-right")));
}

async function renderFolder(ctx) {
  const { view, params, go } = ctx;
  const tree = await drive.tree();
  const course = tree.find((c) => c.id === params.courseId);
  if (!course) throw new Error("Ce cours n'existe plus (il a peut-être été supprimé du Drive).");
  const chapter = params.chapterId ? course.chapters.find((ch) => ch.id === params.chapterId) : null;
  if (params.chapterId && !chapter) throw new Error("Ce chapitre n'existe plus.");
  const folderId = chapter ? chapter.id : course.id;
  const files = (await drive.listFiles(folderId)).filter((f) => !isFolder(f) && kindOf(f) !== "scan-text" && kindOf(f) !== "settings");

  const selected = new Set();
  const { bar, update } = selectionBar(selected, files, { go, course, chapter });

  const renameFolder = async () => {
    const target = chapter || course;
    const res = await askName({ title: chapter ? "Renommer le chapitre" : "Renommer le cours", label: "Nom", value: target.name });
    if (res) { await drive.rename(target.id, res.name); go(location.pathname, { replace: true }); }
  };
  const trashFolder = async () => {
    const target = chapter || course;
    if (!(await confirmDialog(`Supprimer « ${target.name} » ?`, "Le dossier et tout son contenu iront dans la corbeille de ton Google Drive (récupérables 30 jours).", { ok: "Supprimer", danger: true }))) return;
    await drive.trash(target.id);
    toast("Mis à la corbeille", "success");
    go(chapter ? `/cours/${course.id}` : "/cours", { replace: true });
  };
  const newChapter = async () => {
    const res = await askName({ title: "Nouveau chapitre", label: "Nom du chapitre", ok: "Créer" });
    if (res) { const ch = await drive.createChapter(course.id, res.name); go(`/cours/${course.id}/${ch.id}`); }
  };

  const rows = await Promise.all(files.map(async (f) => {
    const box = h("input", { type: "checkbox", "aria-label": `Sélectionner ${f.name}`, onchange: (e) => { if (e.target.checked) selected.add(f.id); else selected.delete(f.id); update(); } });
    const row = fileRow(f, { extra: [box] });
    row.append(await fileActions(f, ctx, tree));
    return row;
  }));

  mount(view,
    h("nav", { class: "crumbs", "aria-label": "Fil d'Ariane" },
      h("a", { href: "/cours", "data-link": "1" }, "Mes cours"), icon("chevron-right"),
      chapter ? [h("a", { href: `/cours/${course.id}`, "data-link": "1" }, course.name), icon("chevron-right"), h("span", {}, chapter.name)] : h("span", {}, course.name)),
    h("div", { class: "row" },
      h("h1", { class: "view-title" }, h("span", { class: "hl", style: { background: `var(--fluo-${course.color})` } }, chapter ? chapter.name : course.name)),
      h("span", { class: "spacer" }),
      h("button", { class: "btn icon-btn", title: "Renommer", "aria-label": "Renommer ce dossier", onclick: () => renameFolder().catch(errorToast) }, icon("edit")),
      h("button", { class: "btn icon-btn danger", title: "Supprimer", "aria-label": "Supprimer ce dossier", onclick: () => trashFolder().catch(errorToast) }, icon("trash"))),
    h("div", { class: "row", style: { margin: "12px 0 20px" } },
      !chapter ? h("button", { class: "btn primary", onclick: () => newChapter().catch(errorToast) }, icon("folder-plus"), "Nouveau chapitre") : null,
      h("a", { class: "btn", href: `/enregistrer`, "data-link": "1" }, icon("microphone"), "Enregistrer"),
      h("a", { class: "btn", href: `/importer?dest=${folderId}`, "data-link": "1" }, icon("file-upload"), "Importer un PDF")),
    !chapter && course.chapters.length ? [h("h2", { class: "section" }, "Chapitres"),
      h("div", { class: "folders" }, course.chapters.map((ch) => folderCard(`/cours/${course.id}/${ch.id}`, course.color, ch.name, "Ouvrir")))] : null,
    h("h2", { class: "section" }, "Fichiers"),
    h("section", { class: "card sketch" }, rows.length
      ? h("ul", { class: "files" }, rows)
      : h("p", { class: "empty" }, chapter ? "Ce chapitre est vide : enregistre un cours, numérise une feuille ou importe un PDF." : "Range tes fichiers dans un chapitre.")),
    rows.length ? h("p", { class: "small muted" }, "Coche des fichiers pour créer une fiche, un podcast ou une vidéo à partir d'eux.") : null,
    bar);
}

export async function render(ctx) {
  if (ctx.params.courseId) return renderFolder(ctx);
  return renderCourses(ctx);
}
