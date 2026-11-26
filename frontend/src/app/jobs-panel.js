// Bloc « Mes générations » du tableau de bord (5 lignes au plus) et page « Toutes mes générations ».
//
// Une seule vérité : le fichier dans le Drive. Une génération terminée dont le fichier a été supprimé (dans
// « Mes cours » ou directement dans Google Drive) disparaît de la liste et le serveur l'oublie.
// Supprimer depuis « Mes générations » : au choix, retirer la ligne seulement, ou mettre aussi le fichier à la
// corbeille du Drive (récupérable 30 jours) — toujours après confirmation.
import { h, mount } from "../lib/dom.js";
import { relativeDate } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import {
  cancelJob, deleteJob, etaText, isActive, listAllJobs, listJobs, retryJob, visibleJobs, withExistingFiles,
} from "../lib/jobs.js";
import { drive, trashFile } from "../lib/storage.js";
import { openDialog, store, toast } from "../lib/ui.js";

const KIND = { podcast: ["headphones", "blue"], video: ["movie", "orange"], fiche: ["notes", "green"], ocr: ["camera", "yellow"],
  exercices: ["pencil", "pink"], correction: ["check", "green"] };
const STATUS = { queued: "En file d'attente", running: "En cours", done: "Terminé", failed: "Échec", cancelled: "Annulé" };
const CACHE_KEY = "studoo-jobs-last";
const MAX = 5;

/** Retirer une génération : la ligne seule, ou aussi son fichier (corbeille du Drive). Confirmation obligatoire. */
function removeDialog(job) {
  return new Promise((resolve) => {
    const hasFile = job.status === "done" && job.result_file_id;
    openDialog("Retirer cette génération ?", (close) => h("div", { class: "stack" },
      h("p", {}, `« ${job.result_name || job.title} »`),
      hasFile ? h("p", { class: "small muted" }, "Retirer de la liste ne touche pas au fichier : il reste dans « Mes cours ». "
        + "Tu peux aussi le mettre à la corbeille de ton Google Drive (récupérable pendant 30 jours).") : null,
      h("div", { class: "row" },
        h("button", { class: "btn", type: "button", onclick: () => { resolve("list"); close(); } }, icon("x"), "Retirer de la liste"),
        hasFile ? h("button", { class: "btn danger", type: "button", onclick: () => { resolve("file"); close(); } }, icon("trash"), "Supprimer aussi le fichier") : null,
        h("button", { class: "btn ghost", type: "button", onclick: () => { resolve(null); close(); } }, "Annuler"))),
    { onClose: () => resolve(null) });
  });
}

export function row(job, refresh) {
  const [ic, color] = KIND[job.kind] || ["file", "yellow"];
  const bar = isActive(job) ? h("div", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100",
    "aria-valuenow": String(job.progress), "aria-label": `Progression : ${job.progress} %`, style: { marginTop: "6px" } },
  h("span", { style: { width: `${Math.max(3, job.progress)}%` } })) : null;
  const act = async (fn, msg) => { try { await fn(job.id); if (msg) toast(msg, "success"); refresh(); } catch (e) { toast(e.message, "error"); } };
  const remove = async () => {
    const choice = await removeDialog(job);
    if (!choice) return;
    try {
      if (choice === "file") {
        const file = await drive.get(job.result_file_id).catch(() => null);
        if (file) await trashFile(file); // met aussi la génération de côté sur le serveur
        toast("Fichier mis à la corbeille", "success");
      }
      await deleteJob(job.id).catch(() => {}); // déjà oubliée si le fichier vient d'être supprimé
      refresh();
    } catch (e) { toast(e.message, "error"); }
  };
  return h("li", { style: { alignItems: "flex-start" } },
    h("span", { class: `kind c-${color}` }, icon(ic)),
    h("span", { style: { flex: 1, minWidth: 0 } },
      job.status === "done" && job.result_file_id
        ? h("a", { class: "name", href: `/fichier/${job.result_file_id}`, "data-link": "1" }, job.result_name || job.title)
        : h("strong", {}, job.title),
      h("br"),
      h("small", { class: job.status === "failed" ? "error" : "muted" },
        `${STATUS[job.status] || job.status} · ${job.status === "failed" ? job.error : job.step} · ${relativeDate(job.created_at)}`),
      isActive(job) && job.eta ? h("small", { class: "eta", style: { display: "block" } }, icon("clock"), " ", etaText(job.eta)) : null,
      bar,
      job.status === "done" && job.note ? h("small", { class: "muted", style: { display: "block" } }, icon("info"), " ", job.note) : null),
    h("span", { class: "actions" },
      isActive(job) ? h("button", { class: "btn small", onclick: () => act(cancelJob, "Annulée") }, "Annuler") : null,
      job.status === "failed" ? h("button", { class: "btn small", onclick: () => act(retryJob, "Relancée") }, icon("refresh"), "Relancer") : null,
      !isActive(job) ? h("button", { class: "btn icon-btn ghost", "aria-label": "Retirer cette génération", title: "Retirer", onclick: remove }, icon("x")) : null));
}

/** Prévient (une fois) des tâches terminées depuis la dernière visite. */
function announce(jobs) {
  const seen = new Set(store.get("studoo-jobs-seen", []));
  const fresh = jobs.filter((j) => (j.status === "done" || j.status === "failed") && !seen.has(j.id));
  fresh.forEach((j) => seen.add(j.id));
  store.set("studoo-jobs-seen", [...seen].slice(-100));
  if (fresh.length > 2) { // plusieurs à la fois (retour après une absence) : une seule bulle, pas une pile
    const ok = fresh.filter((j) => j.status === "done").length;
    const ko = fresh.length - ok;
    toast([ok ? `${ok} génération${ok > 1 ? "s" : ""} prête${ok > 1 ? "s" : ""}` : "", ko ? `${ko} en échec` : ""].filter(Boolean).join(", ") + " : voir « Mes générations ».",
      ko ? "info" : "success", 7000);
    return;
  }
  for (const j of fresh) {
    toast(j.status === "done" ? `« ${j.title} » est prêt !` : `« ${j.title} » a échoué.`, j.status === "done" ? "success" : "error", 7000);
  }
}

function readCache() {
  try { return JSON.parse(sessionStorage.getItem(CACHE_KEY)) || null; } catch { return null; }
}
function writeCache(jobs) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(jobs.slice(0, 20))); } catch { /* ignoré */ }
}

/** Bloc du tableau de bord. Renvoie { el, refresh, stop } : il se met à jour seul tant qu'une tâche est en cours. */
export function jobsPanel() {
  const list = h("ul", { class: "files" });
  const more = h("p", { class: "small", style: { marginTop: "8px" } });
  const el = h("section", { class: "card sketch", hidden: true, "aria-labelledby": "t-jobs", style: { marginTop: "28px" } },
    h("div", { class: "row", style: { alignItems: "baseline" } },
      h("h3", { id: "t-jobs" }, icon("sparkles", { doodle: true }), "Mes générations"),
      h("span", { class: "spacer" }),
      h("a", { class: "small", href: "/generations", "data-link": "1" }, "Voir tout")),
    h("p", { class: "small muted" }, "Tu peux fermer la page : le serveur continue et te prévient à la fin."), list, more);
  let timer = 0;
  let stopped = false;

  function paint(jobs) {
    el.hidden = jobs.length === 0;
    const { shown, hidden } = visibleJobs(jobs, MAX);
    mount(list, shown.map((j) => row(j, refresh)));
    mount(more, hidden ? h("a", { href: "/generations", "data-link": "1" }, `+ ${hidden} plus ancienne${hidden > 1 ? "s" : ""} : voir tout`) : null);
  }

  async function refresh() {
    clearTimeout(timer);
    let jobs = [];
    try { jobs = await listJobs(); } catch { return; }
    if (stopped) return;
    jobs = await withExistingFiles(jobs, (id) => drive.exists(id));
    if (stopped) return;
    writeCache(jobs);
    paint(jobs);
    announce(jobs);
    if (jobs.some(isActive)) timer = setTimeout(refresh, 8000);
  }
  const cached = readCache();
  if (cached) paint(cached); // affichage immédiat (dernière liste connue), mis à jour juste après : pas de saut
  refresh();
  return { el, refresh, stop: () => { stopped = true; clearTimeout(timer); } };
}

/** Page « Toutes mes générations » (/generations). */
export async function render({ view }) {
  const list = h("ul", { class: "files" });
  const box = h("section", { class: "card sketch", "aria-busy": "true" }, h("div", { class: "sk sk-line" }), h("div", { class: "sk sk-line" }));
  let timer = 0;
  async function refresh() {
    clearTimeout(timer);
    let jobs = await listAllJobs();
    jobs = await withExistingFiles(jobs, (id) => drive.exists(id));
    jobs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    box.removeAttribute("aria-busy");
    mount(box, jobs.length ? list : h("p", { class: "empty" }, "Aucune génération pour l'instant. Crée un podcast, une vidéo, une fiche ou une feuille d'exercices depuis « Mes cours »."));
    mount(list, jobs.map((j) => row(j, refresh)));
    if (jobs.some(isActive)) timer = setTimeout(refresh, 8000);
  }
  mount(view,
    h("h1", { class: "view-title" }, "Toutes mes ", h("span", { class: "hl" }, "générations")),
    h("p", { class: "small muted" }, "Les générations dont le fichier a été supprimé de ton Drive disparaissent d'ici automatiquement."),
    box);
  await refresh();
  return () => clearTimeout(timer);
}
