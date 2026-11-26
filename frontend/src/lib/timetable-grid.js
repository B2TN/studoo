// Placement des cours sur une grille horaire (itération 6).
//
// Chaque cours est placé à SON heure réelle : on travaille en « minutes de l'horloge » du jour (heure locale
// de l'appareil, comme l'affiche l'heure du téléphone). Les changements d'heure été/hiver sont donc gérés :
// un cours de 14 h à 15 h 30 reste à 14 h – 15 h 30 même le jour du changement, et un cours à 8 h 15 ou de
// 45 min tombe au quart d'heure près. Les cours qui se chevauchent sont mis côte à côte.

export const DEFAULT_RANGE = { start: 8 * 60, end: 18 * 60 }; // journée vide : 8 h – 18 h
const DAY = 24 * 60;

/** Minutes écoulées depuis minuit, à l'horloge locale (indépendant des changements d'heure). */
export function wallMinutes(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** Clé « AAAA-MM-JJ » du jour local d'une date. */
export function dayKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Évènement « toute la journée » (date sans heure dans le .ics : minuit → minuit). */
export function isAllDay(event) {
  const s = new Date(event.start);
  const e = new Date(event.end);
  return wallMinutes(s) === 0 && wallMinutes(e) === 0 && e > s;
}

/**
 * Les cours d'un jour local, en blocs { event, start, end } (minutes de l'horloge), coupés à minuit si un
 * cours déborde sur la veille ou le lendemain. Les évènements « toute la journée » sont à part (`allDay`).
 */
export function blocksOfDay(events, day) {
  const key = dayKey(day);
  const blocks = [];
  const allDay = [];
  for (const event of events) {
    const s = new Date(event.start);
    const e = new Date(event.end > event.start ? event.end : event.start);
    if (Number.isNaN(s.getTime())) continue;
    const sKey = dayKey(s);
    const eKey = dayKey(e);
    if (key < sKey || key > eKey || (key === eKey && key !== sKey && wallMinutes(e) === 0)) continue;
    if (isAllDay(event)) { allDay.push(event); continue; }
    const start = key === sKey ? wallMinutes(s) : 0;
    let end = key === eKey ? wallMinutes(e) : DAY;
    if (end <= start) end = Math.min(DAY, start + 30); // cours sans fin ou fin avant le début : 30 min visibles
    blocks.push({ event, start, end });
  }
  blocks.sort((a, b) => a.start - b.start || b.end - a.end);
  return { blocks, allDay };
}

/**
 * Plage horaire affichée : du premier début au dernier fin de tous les blocs donnés, avec une marge
 * (30 min par défaut), arrondie à l'heure. Journée/semaine sans cours : 8 h – 18 h.
 */
export function visibleRange(blocks, { margin = 30, minSpan = 4 * 60 } = {}) {
  if (!blocks.length) return { ...DEFAULT_RANGE };
  let start = Math.min(...blocks.map((b) => b.start));
  let end = Math.max(...blocks.map((b) => b.end));
  start = Math.max(0, Math.floor((start - margin) / 60) * 60);
  end = Math.min(DAY, Math.ceil((end + margin) / 60) * 60);
  if (end - start < minSpan) { // évite une grille minuscule pour un seul cours
    const missing = minSpan - (end - start);
    start = Math.max(0, start - Math.ceil(missing / 120) * 60);
    end = Math.min(DAY, start + minSpan);
  }
  return { start, end };
}

/**
 * Colonnes pour les cours qui se chevauchent : chaque bloc reçoit `col` (sa colonne) et `cols` (nombre de
 * colonnes de son groupe de chevauchement). Deux cours qui se touchent (fin = début) ne se chevauchent pas.
 */
export function layoutColumns(blocks) {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let group = [];
  let columns = []; // fin du dernier cours de chaque colonne
  let groupEnd = -1;
  const close = () => {
    for (const b of group) b.cols = columns.length;
    out.push(...group);
    group = [];
    columns = [];
  };
  for (const b of sorted) {
    if (group.length && b.start >= groupEnd) close();
    let col = columns.findIndex((end) => end <= b.start);
    if (col < 0) { col = columns.length; columns.push(b.end); } else columns[col] = b.end;
    group.push({ ...b, col });
    groupEnd = Math.max(groupEnd, b.end);
    if (group.length === 1) groupEnd = b.end;
  }
  if (group.length) close();
  return out;
}

/** « 14 h », « 8 h 15 » : heure lisible depuis des minutes. */
export function hourLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

/** Jours à afficher dans une semaine : lundi → vendredi, plus samedi/dimanche s'il y a cours (ou si c'est aujourd'hui). */
export function weekDays(monday, events, today = new Date()) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    const weekend = i >= 5;
    if (!weekend || blocksOfDay(events, d).blocks.length || blocksOfDay(events, d).allDay.length || dayKey(d) === dayKey(today)) {
      days.push({ index: i, date: d });
    }
  }
  return days;
}
