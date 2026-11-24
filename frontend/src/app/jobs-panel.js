// Bloc « Mes générations » du tableau de bord : progression des tâches serveur,
// annulation, relance, et pastille « Terminé » au retour sur le site.
import { h, mount } from "../lib/dom.js";
import { relativeDate } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { cancelJob, deleteJob, isActive, listJobs, retryJob } from "../lib/jobs.js";
import { store, toast } from "../lib/ui.js";

const KIND = { podcast: ["headphones", "blue"], video: ["movie", "orange"], fiche: ["notes", "green"], ocr: ["camera", "yellow"] };
const STATUS = { queued: "En attente", running: "En cours", done: "Terminé", failed: "Échec", cancelled: "Annulé" };

function row(job, refresh) {
  const [ic, color] = KIND[job.kind] || ["file", "yellow"];
  const bar = isActive(job) ? h("div", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100",
    "aria-valuenow": String(job.progress), "aria-label": `Progression : ${job.progress} %`, style: { marginTop: "6px" } },
  h("span", { style: { width: `${Math.max(3, job.progress)}%` } })) : null;
  const act = async (fn, msg) => { try { await fn(job.id); if (msg) toast(msg, "success"); refresh(); } catch (e) { toast(e.message, "error"); } };
  return h("li", { style: { alignItems: "flex-start" } },
    h("span", { class: `kind c-${color}` }, icon(ic)),
    h("span", { style: { flex: 1, minWidth: 0 } },
      job.status === "done" && job.result_file_id
        ? h("a", { class: "name", href: `/fichier/${job.result_file_id}`, "data-link": "1" }, job.result_name || job.title)
        : h("strong", {}, job.title),
      h("br"),
      h("small", { class: job.status === "failed" ? "error" : "muted" },
        `${STATUS[job.status] || job.status} · ${job.status === "failed" ? job.error : job.step} · ${relativeDate(job.created_at)}`),
      bar),
    h("span", { class: "actions" },
      isActive(job) ? h("button", { class: "btn small", onclick: () => act(cancelJob, "Annulée") }, "Annuler") : null,
      job.status === "failed" ? h("button", { class: "btn small", onclick: () => act(retryJob, "Relancée") }, icon("refresh"), "Relancer") : null,
      !isActive(job) ? h("button", { class: "btn icon-btn ghost", "aria-label": "Retirer de la liste", title: "Retirer de la liste", onclick: () => act(deleteJob) }, icon("x")) : null));
}

/** Prévient (une fois) des tâches terminées depuis la dernière visite. */
function announce(jobs) {
  const seen = new Set(store.get("studoo-jobs-seen", []));
  for (const j of jobs) {
    if ((j.status === "done" || j.status === "failed") && !seen.has(j.id)) {
      toast(j.status === "done" ? `« ${j.title} » est prêt !` : `« ${j.title} » a échoué.`, j.status === "done" ? "success" : "error", 7000);
      seen.add(j.id);
    }
  }
  store.set("studoo-jobs-seen", [...seen].slice(-50));
}

/** Renvoie { el, stop } : le bloc se met à jour seul tant qu'une tâche est en cours. */
export function jobsPanel() {
  const list = h("ul", { class: "files" });
  const el = h("section", { class: "card sketch", hidden: true, "aria-labelledby": "t-jobs", style: { marginTop: "28px" } },
    h("h3", { id: "t-jobs" }, icon("sparkles", { doodle: true }), "Mes générations"),
    h("p", { class: "small muted" }, "Tu peux fermer la page : le serveur continue et te prévient à la fin."), list);
  let timer = 0;
  let stopped = false;
  async function refresh() {
    clearTimeout(timer);
    let jobs = [];
    try { jobs = await listJobs(); } catch { return; }
    if (stopped) return;
    el.hidden = jobs.length === 0;
    mount(list, jobs.slice(0, 8).map((j) => row(j, refresh)));
    announce(jobs);
    if (jobs.some(isActive)) timer = setTimeout(refresh, 8000);
  }
  refresh();
  return { el, refresh, stop: () => { stopped = true; clearTimeout(timer); } };
}
