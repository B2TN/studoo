// Tâches lourdes traitées par le serveur (podcasts, vidéos, lecture de copies).
// Le navigateur dépose la tâche puis peut être fermé : le résultat arrive dans le Drive
// et l'élève est prévenu (notification web, e-mail de secours, pastille sur le site).
import { api, getConfig } from "./api.js";

export const createJob = (job) => api("/api/jobs", { method: "POST", json: job }).then((r) => r.job);
export const listJobs = () => api("/api/jobs").then((r) => r.jobs);
export const cancelJob = (id) => api(`/api/jobs/${id}/cancel`, { method: "POST" });
export const retryJob = (id) => api(`/api/jobs/${id}/retry`, { method: "POST" });
export const deleteJob = (id) => api(`/api/jobs/${id}`, { method: "DELETE" });
export const listAllJobs = () => api("/api/jobs?limit=100").then((r) => r.jobs);
/** Le fichier d'une génération a été supprimé (dans « Mes cours ») : le serveur oublie cette génération. */
export const forgetFile = (fileId) => api("/api/jobs/forget-file", { method: "POST", json: { file_id: fileId } }).catch(() => {});

/**
 * « Mes générations » sur l'accueil : au plus `max` lignes, plus récentes d'abord. Les générations en cours ou en
 * attente sont TOUJOURS affichées (même s'il y en a plus de `max`) ; les terminées (réussies, échouées, annulées)
 * n'occupent que la place restante. Le reste est dans « Voir tout ».
 */
export function visibleJobs(jobs, max = 5) {
  const sorted = [...jobs].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const active = sorted.filter(isActive);
  const finished = sorted.filter((j) => !isActive(j)).slice(0, Math.max(0, max - active.length));
  const shown = sorted.filter((j) => active.includes(j) || finished.includes(j));
  return { shown, hidden: jobs.length - shown.length };
}

// Vérification de l'existence des fichiers (une fois par minute au plus pour un même fichier).
const checked = new Map(); // id → { ok, at }
/**
 * Retire les générations terminées dont le fichier n'existe plus dans le Drive (supprimé dans « Mes cours » ou
 * directement dans Google Drive) et demande au serveur de les oublier : une seule vérité, le fichier.
 */
export async function withExistingFiles(jobs, exists) {
  const now = Date.now();
  const toCheck = jobs.filter((j) => j.status === "done" && j.result_file_id
    && !(checked.has(j.result_file_id) && now - checked.get(j.result_file_id).at < 60_000));
  await Promise.all(toCheck.map(async (j) => {
    checked.set(j.result_file_id, { ok: await exists(j.result_file_id), at: now });
  }));
  const gone = jobs.filter((j) => j.status === "done" && j.result_file_id && checked.get(j.result_file_id)?.ok === false);
  gone.forEach((j) => forgetFile(j.result_file_id));
  return jobs.filter((j) => !gone.includes(j));
}

export const isActive = (job) => job.status === "queued" || job.status === "running";

/** Arrondi lisible : « moins d'une minute », « 2 », « 15 »… (minutes). */
function minutes(seconds) {
  const m = seconds / 60;
  return m < 1 ? 0 : m < 10 ? Math.round(m) : Math.round(m / 5) * 5;
}

/**
 * Temps restant estimé, en fourchette honnête : « environ 2 à 4 min ».
 * `eta` vient du serveur ({ low, high } en secondes, `ahead` tâches devant, `late` si plus long que prévu).
 */
export function etaText(eta) {
  if (!eta) return "";
  const lo = minutes(eta.low);
  let hi = Math.max(minutes(eta.high), lo + 1);
  if (hi === 0) hi = 1;
  const range = eta.high < 60 ? "moins d'une minute" : lo === 0 ? `moins de ${hi} min` : `environ ${lo} à ${hi} min`;
  const prefix = eta.late ? "Un peu plus long que prévu : encore " : "Encore ";
  const queue = eta.ahead > 0 ? ` (${eta.ahead} génération${eta.ahead > 1 ? "s" : ""} avant la tienne)` : "";
  return `${prefix}${range}${queue}`;
}

// ---------- Notifications web (PWA) ----------
export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** Sur iPhone, les notifications ne marchent que si Studoo est installé sur l'écran d'accueil. */
export function needsHomeScreen() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone;
  return ios && !standalone;
}

export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try { return await navigator.serviceWorker.register("/sw.js"); } catch { return null; }
}

function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function pushStatus() {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "off";
}

/** Demande l'autorisation et enregistre cet appareil pour recevoir les notifications. */
export async function enablePush() {
  const { vapidPublicKey } = await getConfig();
  if (!vapidPublicKey) throw new Error("Les notifications ne sont pas encore configurées sur le serveur.");
  if (!pushSupported()) throw new Error("Ce navigateur ne gère pas les notifications web.");
  if (needsHomeScreen()) throw new Error("Sur iPhone : ajoute d'abord Studoo à l'écran d'accueil (bouton Partager → « Sur l'écran d'accueil »), puis ouvre-le depuis là.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications refusées : tu recevras un e-mail à la place.");
  const reg = await registerServiceWorker();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) });
  const json = sub.toJSON();
  await api("/api/push/subscribe", { method: "POST", json: { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth } });
  return "on";
}

export async function disablePush() {
  const reg = await navigator.serviceWorker?.getRegistration("/sw.js");
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return "off";
  const json = sub.toJSON();
  await api("/api/push/unsubscribe", { method: "POST", json: { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth } }).catch(() => {});
  await sub.unsubscribe();
  return "off";
}
