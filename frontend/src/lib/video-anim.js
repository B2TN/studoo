// Vidéos « dessinées à la main » animées dans le navigateur, calées sur la voix.
//
// Le serveur fournit seulement le script des diapos (avec le moment où chacune commence
// dans la voix) et la voix en MP3. Ici on DESSINE chaque image à l'instant t de la voix :
// page qui tourne, titre qui s'écrit, surligneur, pictogramme tracé au stylo, puces qui
// arrivent quand la voix en parle, sous-titres avec le mot prononcé surligné.
// Le même dessin sert à la lecture (en direct) et à l'export MP4 (WebCodecs).
import bulb from "@tabler/icons/outline/bulb.svg?raw";
import book from "@tabler/icons/outline/book.svg?raw";
import mathFunction from "@tabler/icons/outline/math-function.svg?raw";
import chartLine from "@tabler/icons/outline/chart-line.svg?raw";
import world from "@tabler/icons/outline/world.svg?raw";
import atom from "@tabler/icons/outline/atom.svg?raw";
import clock from "@tabler/icons/outline/clock.svg?raw";
import alertTriangle from "@tabler/icons/outline/alert-triangle.svg?raw";
import circleCheck from "@tabler/icons/outline/circle-check.svg?raw";
import help from "@tabler/icons/outline/help.svg?raw";
import users from "@tabler/icons/outline/users.svg?raw";
import arrowBigRight from "@tabler/icons/outline/arrow-big-right.svg?raw";
import heart from "@tabler/icons/outline/heart.svg?raw";
import star from "@tabler/icons/outline/star.svg?raw";
import flask from "@tabler/icons/outline/flask.svg?raw";
import pencil from "@tabler/icons/outline/pencil.svg?raw";

export const FORMATS = {
  short: { width: 720, height: 1280, label: "Vertical (TikTok)" },
  medium: { width: 1280, height: 720, label: "Horizontal (YouTube)" },
  long: { width: 1280, height: 720, label: "Horizontal (long)" },
};
const DOODLE_SVG = {
  idea: bulb, book, formula: mathFunction, chart: chartLine, globe: world, atom, clock, warning: alertTriangle,
  check: circleCheck, question: help, people: users, arrow: arrowBigRight, heart, star, flask, pencil,
};
const FLUO = ["#F7EF5A", "#FF9CCB", "#8BEA9F", "#9FD3FF", "#FFC27A", "#CDB8FF"];
const INK = "#16296E";
const PAPER = "#FBF6E9";
const TURN = 0.55; // durée de la page qui tourne (s)

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (x) => { x = clamp(x); return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2; };
const easeOut = (x) => 1 - (1 - clamp(x)) ** 3;
const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// ---------- Calage sur la voix (fonctions pures, testées) ----------

/** Diapo affichée à l'instant t (s) de la voix. */
export function slideAt(doc, t) {
  const slides = doc.slides;
  let i = 0;
  while (i + 1 < slides.length && slides[i + 1].start <= t) i++;
  return i;
}

/** Mots de la narration avec leur moment (s, relatif au début de la diapo), au prorata des lettres et des pauses. */
export function wordTimes(slide) {
  if (slide._words) return slide._words;
  const words = String(slide.narration || "").split(/\s+/).filter(Boolean);
  const weight = (w) => w.length + 2 + (/[.!?…]$/.test(w) ? 7 : /[,;:]$/.test(w) ? 3 : 0); // pauses de ponctuation
  const total = words.reduce((s, w) => s + weight(w), 0) || 1;
  const dur = Math.max(0.5, slide.end - slide.start);
  let acc = 0;
  slide._words = words.map((w) => {
    const t0 = (acc / total) * dur;
    acc += weight(w);
    return { w, t0, t1: (acc / total) * dur };
  });
  return slide._words;
}

/** Sous-titre à l'instant lt : morceau de phrase (≤ 9 mots, coupé aux ponctuations) et mot en cours. */
export function captionAt(slide, lt) {
  const words = wordTimes(slide);
  if (!words.length) return { words: [], active: -1 };
  const chunks = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= 9 || (/[.!?…;:]$/.test(w.w) && cur.length >= 4)) { chunks.push(cur); cur = []; }
  }
  if (cur.length) chunks.push(cur);
  const chunk = chunks.find((c) => lt < c[c.length - 1].t1) || chunks[chunks.length - 1];
  const active = chunk.findIndex((w) => lt >= w.t0 && lt < w.t1);
  return { words: chunk.map((w) => w.w), active };
}

/** Moment où chaque puce apparaît : quand la voix prononce son mot principal (sinon réparties régulièrement). */
export function bulletTimes(slide) {
  if (slide._bullets) return slide._bullets;
  const bullets = slide.bullets || [];
  const words = wordTimes(slide);
  const dur = Math.max(0.5, slide.end - slide.start);
  let from = 0;
  let last = 0.6;
  slide._bullets = bullets.map((b, i) => {
    const fallback = Math.max(last, 0.6 + ((i + 0.3) / (bullets.length + 0.3)) * dur * 0.75);
    const keys = norm(b).split(/[^a-z0-9]+/).filter((k) => k.length > 3);
    let at = null;
    for (let j = from; j < words.length && at === null; j++) {
      const spoken = norm(words[j].w).replace(/^[a-z]['’]/, "").replace(/[^a-z0-9]/g, ""); // « l'oxygène » → oxygene
      if (keys.some((k) => spoken.startsWith(k.slice(0, Math.max(4, k.length - 2))))) { at = words[j].t0; from = j + 1; }
    }
    last = Math.min(dur - 0.3, Math.max(last + 0.4, at ?? fallback));
    return last;
  });
  return slide._bullets;
}

// ---------- Pictogrammes tracés au stylo ----------
const pathCache = new Map();
function doodlePaths(name) {
  const svg = DOODLE_SVG[name] || bulb;
  if (!pathCache.has(svg)) {
    const paths = [...svg.matchAll(/<path([^>]*)\/?>/g)]
      .filter((m) => !/stroke="none"/.test(m[1]))
      .map((m) => (m[1].match(/\sd="([^"]+)"/) || [])[1])
      .filter(Boolean)
      .map((d) => (typeof Path2D === "function" ? new Path2D(d) : null))
      .filter(Boolean);
    pathCache.set(svg, paths);
  }
  return pathCache.get(svg);
}

// ---------- Dessin ----------
const wrapCache = new Map();
function wrap(ctx, text, maxWidth) {
  const key = `${ctx.font}|${maxWidth}|${text}`;
  if (wrapCache.has(key)) return wrapCache.get(key);
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else line = test;
  }
  if (line) lines.push(line);
  if (wrapCache.size > 2000) wrapCache.clear();
  wrapCache.set(key, lines);
  return lines;
}

function paper(ctx, W, H) {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 24) { ctx.strokeStyle = x % 96 === 0 ? "#C9D6EF" : "#E1E8F5"; ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 24) { ctx.strokeStyle = y % 96 === 0 ? "#C9D6EF" : "#E1E8F5"; ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke(); }
  ctx.strokeStyle = "#E8848C"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(56, 0); ctx.lineTo(56, H); ctx.stroke();
}

/** Trait de surligneur un peu irrégulier, qui « glisse » de gauche à droite (p de 0 à 1). */
function highlighter(ctx, x, y, w, h, color, p, seed) {
  if (p <= 0) return;
  const len = w * easeOut(p);
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = color;
  ctx.beginPath();
  const tilt = Math.sin(seed * 7.3) * 3;
  ctx.moveTo(x, y + 4);
  ctx.quadraticCurveTo(x + len / 2, y - 2 + tilt, x + len, y + 2);
  ctx.lineTo(x + len + 4, y + h - 3);
  ctx.quadraticCurveTo(x + len / 2, y + h + 3 - tilt, x - 2, y + h - 1);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Texte qui s'écrit de gauche à droite (p de 0 à 1). */
function writtenText(ctx, text, x, y, p, lineHeight) {
  if (p <= 0) return;
  const w = ctx.measureText(text).width;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x - 4, y - lineHeight, (w + 8) * clamp(p), lineHeight * 1.6);
  ctx.clip();
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawDoodle(ctx, name, cx, cy, size, p, color, lt) {
  // tache de couleur derrière, puis le pictogramme tracé au stylo, puis il « respire » doucement
  ctx.save();
  ctx.globalAlpha = 0.55 * easeOut(p * 2);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(cx + size * 0.04, cy + size * 0.05, size * 0.5 * easeOut(p * 2), size * 0.44 * easeOut(p * 2), -0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  const paths = doodlePaths(name);
  if (!paths.length) return;
  ctx.save();
  const s = size / 24;
  const bob = p >= 1 ? Math.sin(lt * 1.6) * 0.03 : 0;
  ctx.translate(cx, cy);
  ctx.rotate(bob);
  ctx.scale(s, s);
  ctx.translate(-12, -12);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const L = 90; // longueur de tiret > longueur de chaque tracé : le trait « avance »
  ctx.setLineDash([L, L]);
  ctx.lineDashOffset = L * (1 - easeOut(p));
  for (const path of paths) ctx.stroke(path);
  ctx.restore();
}

/** Contenu d'une diapo (sans le papier) à l'instant lt (s) depuis son début. */
function drawSlideContent(ctx, W, H, slide, index, lt) {
  const vertical = H > W;
  const pad = vertical ? 84 : 110;
  const color = FLUO[index % FLUO.length];
  const dur = Math.max(0.5, slide.end - slide.start);

  // Titre : s'écrit, puis le surligneur passe dessous
  ctx.font = `${vertical ? 62 : 60}px "Gochi Hand", cursive`;
  ctx.textBaseline = "alphabetic";
  const titleLines = wrap(ctx, slide.title, (vertical ? W : W * 0.62) - pad * 1.2);
  let y = vertical ? 200 : 150;
  const writeDur = Math.min(1.1, dur * 0.25);
  titleLines.forEach((line, k) => {
    const w = ctx.measureText(line).width;
    const pLine = (lt - 0.15 - (k * writeDur) / titleLines.length) / (writeDur / titleLines.length);
    highlighter(ctx, pad - 12, y - 50, w + 24, 64, color, (lt - writeDur * 0.6 - k * 0.15) / 0.6, index + k);
    ctx.fillStyle = INK;
    writtenText(ctx, line, pad, y, pLine, 64);
    y += 76;
  });

  // Pictogramme
  const size = vertical ? 300 : 250;
  const cx = vertical ? W / 2 : W - pad - size / 2 + 10;
  const cy = vertical ? H - 600 : H / 2 + 40;
  drawDoodle(ctx, slide.doodle, cx, cy, size, (lt - 0.35) / 1.3, FLUO[(index + 2) % FLUO.length], lt);

  // Puces : arrivent quand la voix en parle ; la puce en cours est soulignée
  ctx.font = `${vertical ? 44 : 40}px "Patrick Hand", cursive`;
  const bullets = slide.bullets || [];
  const times = bulletTimes(slide);
  const maxW = vertical ? W - pad * 2 : W * 0.56 - pad;
  y += vertical ? 34 : 26;
  bullets.forEach((b, i) => {
    const p = (lt - times[i]) / 0.55;
    if (p <= 0) return;
    const lh = vertical ? 58 : 50;
    ctx.save();
    ctx.translate(0, (1 - easeOut(p)) * 14);
    ctx.globalAlpha = clamp(p * 2);
    // pastille dessinée à la main
    ctx.strokeStyle = INK; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(pad + 12, y - 13, 9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * easeOut(p * 1.6)); ctx.stroke();
    ctx.fillStyle = INK;
    const lines = wrap(ctx, b, maxW - 44);
    const current = i === bullets.length - 1 ? lt < dur : lt < times[i + 1];
    lines.forEach((line, k) => {
      if (current && p >= 1) highlighter(ctx, pad + 36, y - 30 + k * lh + 22, ctx.measureText(line).width + 8, 14, color, 1, i + k);
      ctx.fillStyle = INK;
      writtenText(ctx, line, pad + 40, y + k * lh, p * 1.4 - k * 0.3, lh);
    });
    ctx.restore();
    y += lines.length * lh + 14;
  });
}

function drawCaption(ctx, W, H, slide, lt) {
  const vertical = H > W;
  const { words, active } = captionAt(slide, lt);
  if (!words.length) return;
  ctx.font = `${vertical ? 40 : 34}px "Patrick Hand", cursive`;
  const space = ctx.measureText(" ").width;
  const maxW = W - (vertical ? 120 : 260);
  // mise en lignes en gardant la position de chaque mot pour surligner le mot prononcé
  const rows = [[]];
  let x = 0;
  words.forEach((w, i) => {
    const ww = ctx.measureText(w).width;
    if (x + ww > maxW && rows[rows.length - 1].length) { rows.push([]); x = 0; }
    rows[rows.length - 1].push({ w, i, x, ww });
    x += ww + space;
  });
  const lh = vertical ? 52 : 44;
  const boxH = rows.length * lh + 26;
  const boxW = Math.max(...rows.map((r) => r[r.length - 1].x + r[r.length - 1].ww)) + 40;
  const bx = (W - boxW) / 2;
  const by = H - boxH - (vertical ? 130 : 42);
  ctx.save();
  ctx.fillStyle = "rgba(255, 253, 246, .94)";
  ctx.strokeStyle = INK; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.roundRect(bx, by, boxW, boxH, 14); ctx.fill(); ctx.stroke();
  rows.forEach((row, r) => {
    const rowW = row[row.length - 1].x + row[row.length - 1].ww;
    const ox = (W - rowW) / 2;
    const ty = by + 13 + lh * (r + 1) - lh * 0.28;
    for (const cell of row) {
      if (cell.i === active) {
        ctx.fillStyle = "#F7EF5A";
        ctx.beginPath(); ctx.roundRect(ox + cell.x - 5, ty - lh * 0.72, cell.ww + 10, lh * 0.86, 8); ctx.fill();
      }
      ctx.fillStyle = INK;
      ctx.fillText(cell.w, ox + cell.x, ty);
    }
  });
  ctx.restore();
}

function drawChrome(ctx, W, H, doc, index, t) {
  const total = doc.duration || doc.slides[doc.slides.length - 1].end;
  ctx.fillStyle = "rgba(22, 41, 110, .13)";
  ctx.fillRect(0, H - 9, W, 9);
  ctx.fillStyle = "#FF9CCB";
  ctx.fillRect(0, H - 9, W * clamp(t / total), 9);
  // post-it « Studoo » et numéro de diapo
  ctx.save();
  ctx.translate(W - 150, 26);
  ctx.rotate(0.04);
  ctx.fillStyle = "#FF9CCB";
  ctx.fillRect(0, 0, 124, 50);
  ctx.fillStyle = INK;
  ctx.font = '30px "Gochi Hand", cursive';
  ctx.fillText("Studoo", 14, 36);
  ctx.restore();
  ctx.font = '24px "Patrick Hand", cursive';
  ctx.fillStyle = "rgba(22, 41, 110, .6)";
  ctx.fillText(`${index + 1} / ${doc.slides.length}`, 74, H - 24);
}

/**
 * Dessine l'image de la vidéo à l'instant t (s). Le contexte doit être à l'échelle du format (W × H).
 * @param {{captions?: boolean}} opts
 */
export function drawFrame(ctx, doc, t, opts = {}) {
  const { width: W, height: H } = FORMATS[doc.format] || FORMATS.medium;
  const i = slideAt(doc, t);
  const slide = doc.slides[i];
  const lt = Math.max(0, t - slide.start);
  paper(ctx, W, H);
  const turn = i > 0 ? lt / TURN : 1;
  const zoom = 1 + 0.018 * clamp(lt / Math.max(1, slide.end - slide.start));
  const withZoom = (fn) => { ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(zoom, zoom); ctx.translate(-W / 2, -H / 2); fn(); ctx.restore(); };
  if (turn < 1) {
    // la page précédente part vers la gauche, la nouvelle arrive de la droite (avec son ombre)
    const e = ease(turn);
    const prev = doc.slides[i - 1];
    ctx.save();
    ctx.translate(-W * 0.35 * e, 0);
    ctx.globalAlpha = 1 - e;
    drawSlideContent(ctx, W, H, prev, i - 1, prev.end - prev.start + 1);
    ctx.restore();
    ctx.save();
    ctx.translate(W * (1 - e), 0);
    ctx.shadowColor = "rgba(22, 41, 110, .25)"; ctx.shadowBlur = 30; ctx.shadowOffsetX = -12;
    ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
    ctx.shadowColor = "transparent";
    paper(ctx, W, H);
    drawSlideContent(ctx, W, H, slide, i, lt);
    ctx.restore();
  } else {
    withZoom(() => drawSlideContent(ctx, W, H, slide, i, lt));
  }
  if (opts.captions !== false && lt < slide.end - slide.start + 0.2) drawCaption(ctx, W, H, slide, lt);
  drawChrome(ctx, W, H, doc, i, t);
}

export async function loadFonts() {
  if (!document.fonts?.load) return;
  await Promise.all([document.fonts.load('60px "Gochi Hand"'), document.fonts.load('40px "Patrick Hand"')]).catch(() => {});
}

export function supportsMp4Export() {
  return typeof window.VideoEncoder === "function" && typeof window.VideoFrame === "function" && typeof OffscreenCanvas === "function";
}

/** Fabrique le MP4 (image dessinée ici + voix) sur l'appareil. */
export async function renderMp4(doc, audioBlob, { onProgress, signal } = {}) {
  const { Muxer, ArrayBufferTarget } = await import("mp4-muxer");
  await loadFonts();
  const FPS = 25;
  const { width: W, height: H } = FORMATS[doc.format] || FORMATS.medium;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Voix : décodée puis réencodée en AAC (ou Opus) pour le MP4
  const rate = 48000;
  const decoded = await new OfflineAudioContext(1, 1, rate).decodeAudioData(await audioBlob.arrayBuffer());
  const pcm = decoded.getChannelData(0);
  let audioCodec = null;
  if (typeof window.AudioEncoder === "function") {
    for (const [codec, name] of [["mp4a.40.2", "aac"], ["opus", "opus"]]) {
      const ok = await AudioEncoder.isConfigSupported({ codec, sampleRate: rate, numberOfChannels: 1, bitrate: 96000 }).catch(() => ({ supported: false }));
      if (ok.supported) { audioCodec = { codec, name }; break; }
    }
  }
  const videoCodec = "avc1.42001f";
  const config = { codec: videoCodec, width: W, height: H, bitrate: 1_500_000, framerate: FPS }; // images surtout fixes : suffisant
  if (!(await VideoEncoder.isConfigSupported(config)).supported) {
    throw new Error("Ton navigateur ne sait pas fabriquer de MP4. Essaie avec Chrome ou Edge sur ordinateur.");
  }
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: W, height: H, frameRate: FPS },
    audio: audioCodec ? { codec: audioCodec.name, numberOfChannels: 1, sampleRate: rate } : undefined,
    fastStart: "in-memory",
  });
  let failure = null;
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failure = e; } });
  venc.configure({ ...config, latencyMode: "quality" });
  const duration = Math.max(doc.duration || 0, pcm.length / rate);
  const frames = Math.ceil(duration * FPS);
  for (let f = 0; f < frames; f++) {
    if (signal?.aborted) throw new DOMException("Annulé", "AbortError");
    if (failure) throw failure;
    drawFrame(ctx, doc, f / FPS);
    const vf = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
    venc.encode(vf, { keyFrame: f % (FPS * 4) === 0 });
    vf.close();
    if (venc.encodeQueueSize > 10) await new Promise((r) => setTimeout(r, 4));
    if (f % 25 === 0) { onProgress?.(0.95 * (f / frames)); await new Promise((r) => setTimeout(r)); }
  }
  await venc.flush();
  if (audioCodec) {
    const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { failure = e; } });
    aenc.configure({ codec: audioCodec.codec, sampleRate: rate, numberOfChannels: 1, bitrate: 96000 });
    for (let i = 0; i < pcm.length; i += rate) {
      const data = pcm.subarray(i, i + rate);
      const ad = new AudioData({ format: "f32", sampleRate: rate, numberOfFrames: data.length, numberOfChannels: 1, timestamp: Math.round((i / rate) * 1e6), data });
      aenc.encode(ad);
      ad.close();
    }
    await aenc.flush();
  }
  if (failure) throw failure;
  muxer.finalize();
  onProgress?.(1);
  return new Blob([muxer.target.buffer], { type: "video/mp4" });
}
