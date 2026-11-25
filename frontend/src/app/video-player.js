// Lecteur des vidéos animées : la voix (MP3) mène, chaque image est dessinée à l'instant de la voix.
import { h } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { drawFrame, FORMATS, loadFonts, slideAt } from "../lib/video-anim.js";

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function videoPlayer(doc, audioUrl) {
  const { width: W, height: H } = FORMATS[doc.format] || FORMATS.medium;
  const k = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const canvas = h("canvas", { width: Math.round(W * k), height: Math.round(H * k), class: "anim-canvas",
    role: "img", "aria-label": `Vidéo : ${doc.title}` });
  const ctx = canvas.getContext("2d");
  const audio = h("audio", { src: audioUrl, preload: "auto" });
  const total = doc.duration || doc.slides[doc.slides.length - 1].end;
  let captions = true;
  let raf = 0;
  let destroyed = false;

  const draw = () => {
    ctx.setTransform(k, 0, 0, k, 0, 0);
    drawFrame(ctx, doc, audio.currentTime, { captions });
    seek.value = String(audio.currentTime);
    time.textContent = `${fmt(audio.currentTime)} / ${fmt(total)}`;
    chapter.textContent = doc.slides[slideAt(doc, audio.currentTime)].title;
  };
  const loop = () => { draw(); if (!audio.paused && !destroyed) raf = requestAnimationFrame(loop); };

  const playBtn = h("button", { class: "btn primary small", type: "button", "aria-label": "Lecture" }, icon("player-play"));
  const overlay = h("button", { class: "anim-overlay", type: "button", "aria-label": "Lancer la vidéo" }, icon("player-play"));
  const seek = h("input", { type: "range", min: "0", max: String(total), step: "0.1", value: "0", class: "anim-seek", "aria-label": "Position dans la vidéo" });
  const time = h("span", { class: "small mono" }, `0:00 / ${fmt(total)}`);
  const chapter = h("span", { class: "small muted anim-chapter" });
  const speed = h("select", { class: "input small", "aria-label": "Vitesse", style: { width: "auto" } },
    ["0.75", "1", "1.25", "1.5", "2"].map((v) => h("option", { value: v, selected: v === "1" }, `×${v.replace(".", ",")}`)));
  const ccBtn = h("button", { class: "btn small", type: "button", "aria-pressed": "true", title: "Sous-titres" }, icon("message"), "Sous-titres");
  const fullBtn = h("button", { class: "btn small", type: "button", title: "Plein écran" }, icon("maximize"));
  const stage = h("div", { class: `anim-stage ${H > W ? "vertical" : ""}` }, canvas, overlay);

  const toggle = () => (audio.paused ? audio.play() : audio.pause());
  const paint = () => {
    playBtn.replaceChildren(icon(audio.paused ? "player-play" : "player-pause"));
    playBtn.setAttribute("aria-label", audio.paused ? "Lecture" : "Pause");
    overlay.hidden = !audio.paused || audio.currentTime > 0.1;
  };
  playBtn.addEventListener("click", toggle);
  overlay.addEventListener("click", toggle);
  canvas.addEventListener("click", toggle);
  audio.addEventListener("play", () => { paint(); cancelAnimationFrame(raf); loop(); });
  audio.addEventListener("pause", () => { paint(); draw(); });
  audio.addEventListener("ended", () => { paint(); draw(); });
  audio.addEventListener("seeked", draw);
  seek.addEventListener("input", () => { audio.currentTime = Number(seek.value); draw(); paint(); });
  speed.addEventListener("change", () => { audio.playbackRate = Number(speed.value); });
  ccBtn.addEventListener("click", () => { captions = !captions; ccBtn.setAttribute("aria-pressed", String(captions)); draw(); });
  fullBtn.addEventListener("click", () => (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen?.()));
  const keys = (e) => {
    if (!document.body.contains(stage) || /input|select|textarea/i.test(document.activeElement?.tagName || "")) return;
    if (e.key === " ") { e.preventDefault(); toggle(); }
    if (e.key === "ArrowRight") audio.currentTime = Math.min(total, audio.currentTime + 5);
    if (e.key === "ArrowLeft") audio.currentTime = Math.max(0, audio.currentTime - 5);
  };
  document.addEventListener("keydown", keys);
  loadFonts().then(draw);
  draw();

  const el = h("div", { class: "anim-player stack" }, stage,
    h("div", { class: "row anim-controls" }, playBtn, seek, time),
    h("div", { class: "row" }, chapter, h("span", { style: { flex: "1" } }), speed, ccBtn, fullBtn));
  return {
    el,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      audio.pause();
      document.removeEventListener("keydown", keys);
    },
  };
}
