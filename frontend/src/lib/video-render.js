// Fabrication d'une vidéo MP4 « diaporama dessiné + voix » dans le navigateur.
//
// 1. Chaque diapo est dessinée sur un <canvas> (papier quadrillé, titre surligné,
//    puces qui apparaissent, pictogramme, sous-titres).
// 2. Les images sont encodées en H.264 avec WebCodecs (accélération matérielle),
//    l'audio en AAC ou Opus, puis assemblées en MP4 (bibliothèque mp4-muxer).
import { toFloat32 } from "./audio.js";

export const FORMATS = {
  short: { width: 720, height: 1280, label: "Vertical (TikTok)" },
  medium: { width: 1280, height: 720, label: "Horizontal (YouTube)" },
  long: { width: 1280, height: 720, label: "Horizontal (long)" },
};
const FPS = 15;
const COLORS = ["#F7EF5A", "#FF9CCB", "#8BEA9F", "#9FD3FF", "#FFC27A", "#CDB8FF"];
const INK = "#16296E";

export const DOODLES = {
  idea: "bulb", book: "book", formula: "math-function", chart: "chart-line", globe: "world", atom: "atom",
  clock: "clock", warning: "alert-triangle", check: "circle-check", question: "help", people: "users",
  arrow: "arrow-big-right", heart: "heart", star: "star", flask: "flask", pencil: "pencil",
};

export function supportsWebCodecs() {
  return typeof window.VideoEncoder === "function" && typeof window.VideoFrame === "function";
}

/** Charge les pictogrammes (SVG Tabler) en images utilisables sur le canvas. */
async function loadDoodles() {
  const mods = import.meta.glob("/node_modules/@tabler/icons/icons/outline/{bulb,book,math-function,chart-line,world,atom,clock,alert-triangle,circle-check,help,users,arrow-big-right,heart,star,flask,pencil}.svg", { query: "?raw", import: "default" });
  const images = {};
  await Promise.all(Object.entries(mods).map(async ([path, load]) => {
    const name = path.split("/").pop().replace(".svg", "");
    const svg = (await load()).replace(/stroke="currentColor"/g, `stroke="${INK}"`).replace(/stroke-width="2"/, 'stroke-width="1.6"');
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode().catch(() => {});
    images[name] = img;
  }));
  return images;
}

function wrap(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function paper(ctx, W, H) {
  ctx.fillStyle = "#FBF6E9";
  ctx.fillRect(0, 0, W, H);
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 24) { ctx.strokeStyle = x % 96 === 0 ? "#B9C9EA" : "#D7E1F3"; ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 24) { ctx.strokeStyle = y % 96 === 0 ? "#B9C9EA" : "#D7E1F3"; ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(W, y + .5); ctx.stroke(); }
  ctx.strokeStyle = "#E8848C"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(56, 0); ctx.lineTo(56, H); ctx.stroke();
}

/** Dessine la diapo `slide` à l'instant `p` (0 → 1) de sa durée. */
export function drawSlide(ctx, W, H, slide, index, total, p, doodles, caption) {
  const vertical = H > W;
  const pad = vertical ? 80 : 110;
  const color = COLORS[index % COLORS.length];
  paper(ctx, W, H);

  // Titre surligné (le surligneur « glisse » au début)
  ctx.font = `${vertical ? 64 : 62}px "Gochi Hand", cursive`;
  ctx.textBaseline = "alphabetic";
  const titleLines = wrap(ctx, slide.title, W - pad * 2);
  let y = vertical ? 190 : 140;
  for (const line of titleLines) {
    const w = ctx.measureText(line).width;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.95;
    ctx.fillRect(pad - 10, y - 50, (w + 20) * Math.min(1, p * 6), 64);
    ctx.globalAlpha = 1;
    ctx.fillStyle = INK;
    ctx.fillText(line, pad, y);
    y += 76;
  }

  // Pictogramme qui « pousse »
  const img = doodles[DOODLES[slide.doodle] || "bulb"];
  if (img) {
    const size = (vertical ? 260 : 220) * Math.min(1, 0.6 + p * 4);
    const ix = vertical ? W / 2 - size / 2 : W - pad - size;
    const iy = vertical ? H - 560 - size / 2 : H / 2 - size / 2 + 20;
    ctx.save();
    ctx.translate(ix + size / 2, iy + size / 2);
    ctx.rotate(Math.sin(p * Math.PI * 2) * 0.04);
    ctx.drawImage(img, -size / 2, -size / 2, size, size);
    ctx.restore();
  }

  // Puces : apparaissent une à une pendant les 60 premiers % de la diapo
  ctx.font = `${vertical ? 44 : 40}px "Patrick Hand", cursive`;
  const bullets = slide.bullets || [];
  const bulletWidth = vertical ? W - pad * 2 : W * 0.55;
  y += 30;
  bullets.forEach((b, i) => {
    const appear = (i + 1) / (bullets.length + 1) * 0.6;
    if (p < appear) return;
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(pad + 12, y - 14, 8, 0, Math.PI * 2);
    ctx.fill();
    for (const line of wrap(ctx, b, bulletWidth - 40)) {
      ctx.fillText(line, pad + 40, y);
      y += vertical ? 58 : 52;
    }
    y += 12;
  });

  // Sous-titres (accessibilité) en bas, sur un post-it
  if (caption) {
    ctx.font = `${vertical ? 38 : 32}px "Patrick Hand", cursive`;
    const lines = wrap(ctx, caption, W - pad * 2 - 40).slice(0, 3);
    const lh = vertical ? 48 : 40;
    const boxH = lines.length * lh + 30;
    const by = H - boxH - (vertical ? 120 : 40);
    ctx.fillStyle = "rgba(255, 253, 246, .93)";
    ctx.strokeStyle = INK; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.roundRect(pad - 20, by, W - pad * 2 + 40, boxH, 14); ctx.fill(); ctx.stroke();
    ctx.fillStyle = INK;
    lines.forEach((l, i) => ctx.fillText(l, pad, by + 40 + i * lh));
  }

  // Progression + logo
  ctx.fillStyle = "rgba(22, 41, 110, .15)";
  ctx.fillRect(0, H - 10, W, 10);
  ctx.fillStyle = "#FF9CCB";
  ctx.fillRect(0, H - 10, W * ((index + p) / total), 10);
  ctx.font = '28px "Gochi Hand", cursive';
  ctx.fillStyle = INK;
  ctx.fillText("Studoo", W - 130, 50);
}

/** Découpe la narration d'une diapo en sous-titres successifs (≈ 12 mots). */
export function captionAt(text, p) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const per = 12;
  const chunks = Math.ceil(words.length / per);
  const i = Math.min(chunks - 1, Math.floor(p * chunks));
  return words.slice(i * per, (i + 1) * per).join(" ");
}

/**
 * Fabrique le MP4.
 * @param {object} opts
 * @param {{slides: object[]}} opts.script
 * @param {number[]} opts.durations  durée de chaque diapo (s)
 * @param {Int16Array|null} opts.pcm  voix complète (ou null : vidéo sous-titrée sans voix)
 */
export async function renderMp4({ script, format, durations, pcm, rate, onProgress, signal }) {
  const { Muxer, ArrayBufferTarget } = await import("mp4-muxer");
  await Promise.all([document.fonts.load('60px "Gochi Hand"'), document.fonts.load('40px "Patrick Hand"')]);
  const doodles = await loadDoodles();
  const { width: W, height: H } = FORMATS[format];
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");

  let audioCodec = null;
  if (pcm && typeof window.AudioEncoder === "function") {
    for (const [codec, name] of [["mp4a.40.2", "aac"], ["opus", "opus"]]) {
      const ok = await AudioEncoder.isConfigSupported({ codec, sampleRate: rate, numberOfChannels: 1, bitrate: 64000 }).catch(() => ({ supported: false }));
      if (ok.supported) { audioCodec = { codec, name }; break; }
    }
  }
  const videoCodec = "avc1.42001f";
  const support = await VideoEncoder.isConfigSupported({ codec: videoCodec, width: W, height: H, bitrate: 1_200_000, framerate: FPS });
  if (!support.supported) throw new Error("Ton navigateur ne sait pas encoder de vidéo H.264. Essaie avec Chrome ou Edge sur ordinateur.");

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: W, height: H, frameRate: FPS },
    audio: audioCodec ? { codec: audioCodec.name, numberOfChannels: 1, sampleRate: rate } : undefined,
    fastStart: "in-memory",
  });
  let encodeError = null;
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encodeError = e; } });
  venc.configure({ codec: videoCodec, width: W, height: H, bitrate: 1_200_000, framerate: FPS, latencyMode: "quality" });

  const total = durations.reduce((a, b) => a + b, 0);
  const totalFrames = Math.ceil(total * FPS);
  let frame = 0;
  for (let s = 0; s < script.slides.length; s++) {
    const slide = script.slides[s];
    const frames = Math.max(1, Math.round(durations[s] * FPS));
    for (let f = 0; f < frames; f++) {
      if (signal?.aborted) throw new DOMException("Annulé", "AbortError");
      if (encodeError) throw encodeError;
      const p = f / frames;
      drawSlide(ctx, W, H, slide, s, script.slides.length, p, doodles, captionAt(slide.narration, p));
      const vf = new VideoFrame(canvas, { timestamp: Math.round((frame * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
      venc.encode(vf, { keyFrame: frame % (FPS * 4) === 0 });
      vf.close();
      frame++;
      if (venc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
      if (frame % 30 === 0) { onProgress?.(frame / totalFrames); await new Promise((r) => setTimeout(r)); }
    }
  }
  await venc.flush();

  if (audioCodec) {
    const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { encodeError = e; } });
    aenc.configure({ codec: audioCodec.codec, sampleRate: rate, numberOfChannels: 1, bitrate: 64000 });
    const floats = toFloat32(pcm);
    const block = rate; // 1 s
    for (let i = 0; i < floats.length; i += block) {
      const data = floats.subarray(i, i + block);
      const ad = new AudioData({ format: "f32", sampleRate: rate, numberOfFrames: data.length, numberOfChannels: 1, timestamp: Math.round((i / rate) * 1e6), data });
      aenc.encode(ad);
      ad.close();
    }
    await aenc.flush();
  }
  if (encodeError) throw encodeError;
  muxer.finalize();
  onProgress?.(1);
  return new Blob([muxer.target.buffer], { type: "video/mp4" });
}

/** Durées des diapos : proportionnelles au texte, calées sur la durée réelle de la voix si elle existe. */
export function slideDurations(slides, audioSeconds = null) {
  const lengths = slides.map((s) => Math.max(20, s.narration.length));
  if (audioSeconds) {
    const sum = lengths.reduce((a, b) => a + b, 0);
    return lengths.map((l) => Math.max(2, (l / sum) * audioSeconds));
  }
  return lengths.map((l) => Math.max(4, l / 14)); // ≈ 14 caractères lus par seconde
}
