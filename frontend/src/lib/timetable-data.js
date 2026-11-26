// Récupération des cours de l'emploi du temps, quelle que soit la source.
import { api } from "./api.js";
import { drive, getSettings, saveSettings } from "./storage.js";

const CACHE_KEY = "studoo-edt-cache";
const CACHE_MS = 15 * 60 * 1000;

function readCache() {
  try {
    const c = JSON.parse(sessionStorage.getItem(CACHE_KEY));
    if (c && Date.now() - c.at < CACHE_MS) return c.events;
  } catch { /* ignoré */ }
  return null;
}
function writeCache(events) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), events })); } catch { /* ignoré */ }
}
export function clearTimetableCache() {
  try { sessionStorage.removeItem(CACHE_KEY); } catch { /* ignoré */ }
}

/** Jours au bout desquels on rappelle de se reconnecter (établissements sans lien iCal durable). */
export const RECONNECT_DAYS = 14;

/**
 * Le robot : identifiant + mot de passe → emploi du temps. Le mot de passe n'est envoyé qu'une fois et
 * n'est gardé nulle part. On range ensuite :
 * - un lien iCal durable, chiffré (mise à jour automatique pour toujours) ;
 * - sinon une copie des cours dans le Drive + un rappel de reconnexion toutes les 2 semaines.
 */
export async function robotConnect(body, school) {
  const res = await api("/api/timetable/connect", { method: "POST", json: body });
  const settings = await getSettings();
  const others = (settings.timetable?.sources || []).filter((src) => src.uai !== school.uai); // une seule source par lycée
  await saveSettings({ timetable: { ...settings.timetable, sources: others } });
  const where = { uai: school.uai, school: school.name, city: school.city || "" };
  if (res.sealed) {
    await addSource({ type: "sealed", sealed: res.sealed, label: `Pronote · ${school.name}`, ...where });
  } else {
    const root = await drive.init();
    const saved = await drive.save({ parentId: root, name: `Emploi du temps — ${school.name}.json`, mimeType: "application/json",
      kind: "timetable", blob: new Blob([JSON.stringify({ events: res.events })], { type: "application/json" }) });
    await addSource({ type: "snapshot", fileId: saved.id, label: `Pronote · ${school.name}`, syncedAt: new Date().toISOString(), ...where });
  }
  return res;
}

// ---------- Robot ADE (universités) ----------
// La session ADE (chiffrée par le serveur) ne vit que dans la mémoire de la page, le temps de choisir sa classe.
export const adeLogin = (body) => api("/api/timetable/ade/login", { method: "POST", json: body });
export const higherSearch = (q) => api(`/api/timetable/higher?q=${encodeURIComponent(q)}`).then((r) => r.schools);
export const higherDetect = (domain) => api("/api/timetable/higher/detect", { method: "POST", json: { domain } }).then((r) => r.systems);
export const celcatLogin = (body) => api("/api/timetable/celcat/login", { method: "POST", json: body }).then((r) => r.session);
export const celcatGroups = (base, q, session = "") => api("/api/timetable/celcat/groups", { method: "POST", json: { base, q, session } }).then((r) => r.groups);

/** Groupe Celcat choisi : lien relu sans identifiant (Celcat public) ou copie + rappel (Celcat protégé). */
export async function celcatChoose(base, group, session, school) {
  const res = await api("/api/timetable/celcat/choose", { method: "POST", json: { base, group: group.id, session, label: group.name } });
  if (res.sealed) {
    await addSource({ type: "sealed", sealed: res.sealed, label: `Celcat · ${group.name}`, establishment: school.name });
  } else {
    const root = await drive.init();
    const saved = await drive.save({ parentId: root, name: `Emploi du temps — ${group.name}.json`, mimeType: "application/json",
      kind: "timetable", blob: new Blob([JSON.stringify({ events: res.events })], { type: "application/json" }) });
    await addSource({ type: "snapshot", fileId: saved.id, label: `Celcat · ${group.name}`, syncedAt: new Date().toISOString(),
      establishment: school.name, higher: { domain: school.domain, name: school.name, city: school.city || "" } });
  }
  return res;
}
export const adeTree = (session, project, node = null) => api("/api/timetable/ade/tree", { method: "POST", json: { session, project, node } });

export async function adeChoose(session, project, node, university) {
  const res = await api("/api/timetable/ade/choose", { method: "POST", json: { session, project, resource: node.id, label: node.path || node.name } });
  // (le lien d'export ADE se lit sans identifiant : mise à jour automatique, aucun rappel nécessaire)
  await addSource({ type: "sealed", sealed: res.sealed, label: `ADE · ${node.name}`, establishment: university });
  return res;
}

/** L'année ADE la plus probable : celle de l'année scolaire en cours, sans les copies de travail (« HS », « planté »…). */
export function guessProject(projects, now = new Date()) {
  const y = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  const years = [`${y}-${y + 1}`, `${y}/${y + 1}`, `${y}-${String(y + 1).slice(2)}`];
  const score = (p) => (years.some((t) => p.name.includes(t)) ? 10 : 0)
    - (/plant|hs_|suppression|test|futur|archive|copie|old/i.test(p.name) ? 5 : 0) + (/restaur/i.test(p.name) ? 0 : 1);
  return [...projects].sort((a, b) => score(b) - score(a))[0] || null;
}

/** Sources « copie » à rafraîchir (plus de RECONNECT_DAYS jours). */
export function staleSources(sources, now = Date.now()) {
  return sources.filter((src) => src.type === "snapshot" && now - new Date(src.syncedAt).getTime() > RECONNECT_DAYS * 86400e3);
}

/** Emploi du temps fictif (mode démo local uniquement). */
export function demoEvents(now = new Date()) {
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const plan = [
    [["Anglais", 8, 9, "B12"], ["Mathématiques", 10, 12, "A03"], ["Histoire-Géographie", 14, 15, "C21"]],
    [["Physique-Chimie", 8, 10, "Labo 2"], ["Mathématiques", 13, 14, "A03"]],
    [["Histoire-Géographie", 9, 11, "C21"], ["Anglais", 11, 12, "B12"]],
    [["Mathématiques", 8, 10, "A03"], ["Physique-Chimie", 14, 16, "Labo 2"]],
    [["Anglais", 10, 11, "B12"], ["Histoire-Géographie", 13, 15, "C21"]],
  ];
  const iso = (d, hh) => { const x = new Date(d); x.setHours(hh, 0, 0, 0); return x.toISOString(); };
  return plan.flatMap((day, i) => day.map(([subject, a, b, room]) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    return { uid: `demo-${i}-${a}`, title: subject, subject, start: iso(d, a), end: iso(d, b), location: room, description: "", cancelled: false };
  }));
}

async function fromSource(src) {
  if (src.type === "demo") {
    // Démo locale : simule l'aller-retour serveur + ENT (≈ 4 × la latence choisie).
    let ms = 0;
    try { ms = Number(localStorage.getItem("studoo-latence") || 0) * 4; } catch { /* indisponible */ }
    if (ms) await new Promise((r) => setTimeout(r, ms));
    return demoEvents();
  }
  if (src.type === "sealed") {
    // Source chiffrée : seul le serveur sait la lire.
    const res = await api("/api/timetable/sync", { method: "POST", json: { sealed: src.sealed } });
    if (res.sealed) await updateSource(src.id, { sealed: res.sealed }); // Pronote renouvelle son jeton à chaque connexion
    return res.events;
  }
  if (src.type === "ics-url" || (src.type === "pronote" && src.icalUrl)) {
    // Ancien format (lien en clair) : on le remplace par sa version scellée.
    const res = await api("/api/timetable/ics-url", { method: "POST", json: { url: src.url || src.icalUrl } });
    await updateSource(src.id, { type: "sealed", sealed: res.sealed, url: undefined, icalUrl: undefined });
    return res.events;
  }
  if (src.type === "pronote" && src.blob) {
    throw new Error("Ta connexion Pronote doit être refaite (nouvelle méthode plus sûre). Va dans « Emploi du temps ».");
  }
  if (src.type === "snapshot" && src.fileId) {
    return (await drive.readJson(src.fileId)).events || [];
  }
  if (src.type === "ics-file" && src.fileId) {
    const content = await drive.readText(src.fileId);
    return (await api("/api/timetable/ics-file", { method: "POST", json: { content } })).events;
  }
  return [];
}

/** Tous les cours connus (toutes sources), triés. */
export async function loadEvents({ force = false } = {}) {
  if (!force) {
    const cached = readCache();
    if (cached) return cached;
  }
  const settings = await getSettings();
  const sources = settings.timetable?.sources || [];
  const results = await Promise.allSettled(sources.map(fromSource));
  const events = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason);
  events.sort((a, b) => a.start.localeCompare(b.start));
  writeCache(events);
  if (errors.length && !events.length) throw errors[0];
  return events;
}

export async function addSource(source) {
  const settings = await getSettings();
  const sources = (settings.timetable?.sources || []).filter((s) => s.id !== source.id);
  sources.push({ id: crypto.randomUUID(), addedAt: new Date().toISOString(), ...source });
  await saveSettings({ timetable: { ...settings.timetable, sources } });
  clearTimetableCache();
}

async function updateSource(id, patch) {
  const settings = await getSettings();
  const sources = (settings.timetable?.sources || []).map((s) => {
    if (s.id !== id) return s;
    const next = { ...s, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    return next;
  });
  await saveSettings({ timetable: { ...settings.timetable, sources } });
}

/** Retirer une source = révoquer son jeton : il est supprimé du Drive et n'est plus utilisable. */
export async function removeSource(id) {
  const settings = await getSettings();
  await saveSettings({ timetable: { ...settings.timetable, sources: (settings.timetable?.sources || []).filter((s) => s.id !== id) } });
  clearTimetableCache();
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function eventsOfDay(events, day = new Date()) {
  return events.filter((e) => sameDay(new Date(e.start), day));
}

/** Le cours en cours (ou qui vient de finir il y a moins de 20 min) à l'instant `at`. */
export function lessonAt(events, at = new Date()) {
  const t = at.getTime();
  return events.find((e) => !e.cancelled && new Date(e.start).getTime() - 10 * 60e3 <= t && t <= new Date(e.end).getTime() + 20 * 60e3) || null;
}

export function nextLesson(events, at = new Date()) {
  return events.find((e) => !e.cancelled && new Date(e.start) > at) || null;
}

export function subjectsOf(events) {
  return [...new Set(events.map((e) => e.subject).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
}
