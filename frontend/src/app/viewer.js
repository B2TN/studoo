// Affichage d'un fichier : transcription, fiche, podcast, vidéo, PDF.
import { speakLines } from "../lib/audio.js";
import { h, mount } from "../lib/dom.js";
import { bytes, relativeDate, renderMarkdown } from "../lib/format.js";
import { renderFiche } from "../lib/fiche-render.js";
import { icon } from "../lib/icons.js";
import { drive, KINDS, kindOf, SOURCE_KINDS } from "../lib/storage.js";
import { confirmDialog, errorToast, toast } from "../lib/ui.js";
import { askName } from "./explorer.js";

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function scriptPlayer(script) {
  const lines = script.lines;
  const rows = lines.map((l, i) => h("p", { dataset: { i: String(i) }, style: { cursor: "pointer" } },
    h("span", { class: "who" }, `${l.speaker === "A" ? script.host_a : script.host_b} :`), " ", l.text));
  const box = h("div", { class: "live-transcript card sketch", style: { maxHeight: "55vh" } }, rows);
  let ctrl = null;
  const highlight = (i) => rows.forEach((r, j) => { r.style.background = j === i ? "color-mix(in srgb, var(--fluo-yellow) 45%, transparent)" : ""; if (j === i) r.scrollIntoView({ block: "nearest" }); });
  const playBtn = h("button", { class: "btn primary", type: "button" }, icon("player-play"), "Écouter");
  const stopBtn = h("button", { class: "btn", type: "button" }, icon("player-stop"), "Arrêter");
  playBtn.addEventListener("click", () => {
    if (!window.speechSynthesis) { toast("Ton navigateur ne sait pas lire à voix haute.", "error"); return; }
    ctrl ||= speakLines(lines, { onLine: highlight });
    if (playBtn.dataset.state === "playing") { ctrl.pause(); playBtn.dataset.state = "paused"; playBtn.replaceChildren(icon("player-play"), "Reprendre"); }
    else { ctrl.play(); playBtn.dataset.state = "playing"; playBtn.replaceChildren(icon("player-pause"), "Pause"); }
  });
  stopBtn.addEventListener("click", () => { ctrl?.stop(); ctrl = null; highlight(-1); playBtn.dataset.state = ""; playBtn.replaceChildren(icon("player-play"), "Écouter"); });
  box.addEventListener("click", (e) => { const p = e.target.closest("p[data-i]"); if (p) { ctrl ||= speakLines(lines, { onLine: highlight }); ctrl.seek(Number(p.dataset.i)); playBtn.dataset.state = "playing"; playBtn.replaceChildren(icon("player-pause"), "Pause"); } });
  return { el: h("div", { class: "stack" }, h("p", { class: "small muted" }, "Lu par la voix de ton appareil (quota de voix Gemini épuisé ce jour-là). Clique sur une réplique pour y aller."),
    h("div", { class: "row" }, playBtn, stopBtn), box), stop: () => ctrl?.stop() };
}

export async function render({ view, params, go }) {
  const file = await drive.get(params.id);
  const kind = kindOf(file);
  const meta = KINDS[kind] || { label: "Fichier", icon: "file", color: "yellow" };
  const urls = [];
  let stopAudio = null;
  const objectUrl = (blob) => { const u = URL.createObjectURL(blob); urls.push(u); return u; };
  const title = file.name.replace(/\.(md|json|pdf|mp3|mp4)$/i, "");

  let body;
  if (kind === "transcript" || kind === "scan-text") {
    const text = await drive.readText(file.id);
    body = h("div", { class: "transcript-body" }, renderMarkdown(text.replace(/^# .*\n/, ""), h));
  } else if (kind === "fiche") {
    body = renderFiche(await drive.readJson(file.id));
  } else if (kind === "podcast") {
    body = h("audio", { controls: true, src: objectUrl(await drive.readBlob(file.id)), preload: "metadata" });
  } else if (kind === "podcast-script") {
    const player = scriptPlayer(await drive.readJson(file.id));
    stopAudio = player.stop;
    body = player.el;
  } else if (kind === "video") {
    body = h("video", { controls: true, playsinline: true, src: objectUrl(await drive.readBlob(file.id)), style: { maxHeight: "75vh", background: "#000" } });
  } else if (file.mimeType === "application/pdf") {
    body = h("iframe", { src: objectUrl(await drive.readBlob(file.id)), title: `Aperçu de ${title}` });
  } else {
    body = h("p", {}, "Aperçu indisponible pour ce type de fichier.");
  }

  const parentId = file.parents?.[0];
  const tree = await drive.tree();
  const course = tree.find((c) => c.id === parentId || c.chapters.some((ch) => ch.id === parentId));
  const chapter = course?.chapters.find((ch) => ch.id === parentId);
  const backHref = course ? (chapter ? `/cours/${course.id}/${chapter.id}` : `/cours/${course.id}`) : "/cours";

  const actions = [
    kind === "fiche" ? h("button", { class: "btn primary", onclick: () => window.print() }, icon("printer"), "Exporter en PDF") : null,
    SOURCE_KINDS.has(kind) ? [
      h("button", { class: "btn small c-green", onclick: () => go("/creer/fiche", { data: { fileIds: [file.id] } }) }, icon("notes"), "Fiche"),
      h("button", { class: "btn small c-blue", onclick: () => go("/creer/podcast", { data: { fileIds: [file.id] } }) }, icon("headphones"), "Podcast"),
      h("button", { class: "btn small c-orange", onclick: () => go("/creer/video", { data: { fileIds: [file.id] } }) }, icon("movie"), "Vidéo"),
    ] : null,
    h("button", { class: "btn small", onclick: async () => {
      try { download(await drive.readBlob(file.id), file.name); } catch (e) { errorToast(e); }
    } }, icon("download"), "Télécharger"),
    h("button", { class: "btn small", onclick: async () => {
      const res = await askName({ title: "Renommer", label: "Nouveau nom", value: title });
      if (!res) return;
      const ext = (file.name.match(/\.(md|json|pdf|mp3|mp4)$/i) || [""])[0];
      await drive.rename(file.id, res.name + ext).catch(errorToast);
      go(location.pathname, { replace: true });
    } }, icon("edit"), "Renommer"),
    h("button", { class: "btn small danger", onclick: async () => {
      if (!(await confirmDialog("Mettre à la corbeille ?", "Le fichier ira dans la corbeille de ton Google Drive (récupérable 30 jours).", { ok: "Supprimer", danger: true }))) return;
      await drive.trash(file.id);
      if (file.appProperties?.textId) await drive.trash(file.appProperties.textId).catch(() => {});
      toast("Mis à la corbeille", "success");
      go(backHref, { replace: true });
    } }, icon("trash"), "Supprimer"),
  ];

  mount(view,
    h("nav", { class: "crumbs", "aria-label": "Fil d'Ariane" },
      h("a", { href: "/cours", "data-link": "1" }, "Mes cours"),
      course ? [icon("chevron-right"), h("a", { href: `/cours/${course.id}`, "data-link": "1" }, course.name)] : null,
      chapter ? [icon("chevron-right"), h("a", { href: backHref, "data-link": "1" }, chapter.name)] : null),
    kind === "fiche" ? null : h("h1", { class: "view-title" }, title),
    h("p", { class: "small muted" }, h("span", { class: `badge c-${meta.color}`, style: { color: "var(--on-fluo)" } }, meta.label), " · modifié ", relativeDate(file.modifiedTime),
      file.size ? ` · ${bytes(file.size)}` : "", file.appProperties?.minutes ? ` · ${file.appProperties.minutes} min` : ""),
    h("div", { class: "row", style: { margin: "10px 0 18px" } }, actions),
    kind === "fiche" ? body : h("section", { class: "viewer card sketch" }, body));

  return () => {
    stopAudio?.();
    urls.forEach((u) => URL.revokeObjectURL(u));
  };
}
