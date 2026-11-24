// Numérisation de cours papier : photo → page redressée et nettoyée → PDF.
import { h, mount } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { addPending } from "../lib/pending.js";
import { canvasToBase64, ocrImages, savePdfWithText } from "../lib/pdf-tools.js";
import { detectCorners, enhance, outputSize, warp } from "../lib/scan-core.js";
import { errorToast, toast } from "../lib/ui.js";

const MAX_SIDE = 2400;
const MAX_PAGES = 20;

async function loadImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

function rotate90(canvas) {
  const c = document.createElement("canvas");
  c.width = canvas.height;
  c.height = canvas.width;
  const ctx = c.getContext("2d");
  ctx.translate(c.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(canvas, 0, 0);
  return c;
}

function guessCorners(canvas) {
  const w = 300, hgt = Math.round((canvas.height / canvas.width) * 300);
  const small = document.createElement("canvas");
  small.width = w;
  small.height = hgt;
  const ctx = small.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, hgt);
  return detectCorners(ctx.getImageData(0, 0, w, hgt).data, w, hgt);
}

const tick = () => new Promise((r) => setTimeout(r, 20));

/** Redresse + embellit ; renvoie un canvas de la page finale. */
async function processPage(source, cornersNorm, mode) {
  const sw = source.width, sh = source.height;
  const ctx = source.getContext("2d", { willReadFrequently: true });
  const src = ctx.getImageData(0, 0, sw, sh).data;
  const cornersPx = cornersNorm.map(([x, y]) => [x * (sw - 1), y * (sh - 1)]);
  const { width, height } = outputSize(cornersPx, Math.min(1654, Math.round(Math.max(sw, sh) * 0.8)));
  await tick();
  const flat = warp(src, sw, sh, cornersPx, width, height);
  await tick();
  const clean = enhance(flat, width, height, mode);
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  out.getContext("2d").putImageData(new ImageData(clean, width, height), 0, 0);
  return out;
}

async function buildPdf(pages) {
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.setProducer("Studoo");
  pdf.setCreator("Studoo");
  for (const canvas of pages) {
    const jpg = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.82));
    const img = await pdf.embedJpg(await jpg.arrayBuffer());
    const A4W = 595.28, A4H = 841.89;
    const scale = Math.min(A4W / img.width, A4H / img.height);
    const page = pdf.addPage([A4W, A4H]);
    page.drawImage(img, { x: (A4W - img.width * scale) / 2, y: (A4H - img.height * scale) / 2, width: img.width * scale, height: img.height * scale });
  }
  return new Blob([await pdf.save()], { type: "application/pdf" });
}

function smallCopy(canvas, width = 1100) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = Math.round((canvas.height / canvas.width) * width);
  c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
  return c;
}

export async function render({ view, go, refreshQuota }) {
  const pages = []; // canvases des pages finales
  let current = null; // { canvas, corners }

  const camera = h("input", { type: "file", accept: "image/*", capture: "environment", hidden: true, id: "scan-camera", "aria-label": "Prendre une photo" });
  const gallery = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true, id: "scan-gallery", "aria-label": "Choisir des images" });
  const editor = h("section", { class: "card sketch", hidden: true, style: { marginTop: "20px" } });
  const pagesBox = h("div", { class: "pages", role: "group", "aria-label": "Pages numérisées" });
  const finishBtn = h("button", { class: "btn primary big", type: "button", hidden: true }, icon("check"), "Terminer et ranger");
  const status = h("p", { class: "muted", role: "status" });
  const queue = [];

  function paintPages() {
    mount(pagesBox, pages.map((p, i) => h("figure", {},
      h("img", { src: smallCopy(p, 240).toDataURL("image/jpeg", 0.7), alt: `Page ${i + 1}` }),
      h("figcaption", {}, `Page ${i + 1} `,
        h("button", { class: "btn icon-btn ghost", type: "button", "aria-label": `Retirer la page ${i + 1}`, onclick: () => { pages.splice(i, 1); paintPages(); } }, icon("x"))))));
    finishBtn.hidden = pages.length === 0;
  }

  function edit(canvas) {
    current = { canvas, corners: guessCorners(canvas) };
    const preview = smallCopy(canvas, Math.min(900, canvas.width));
    const stage = h("div", { class: "scan-stage" }, preview);
    const handles = current.corners.map((pt, i) => {
      const el = h("div", { class: "corner", role: "slider", tabindex: "0", "aria-label": ["Coin haut gauche", "Coin haut droit", "Coin bas droit", "Coin bas gauche"][i] });
      const place = () => { el.style.left = `${current.corners[i][0] * 100}%`; el.style.top = `${current.corners[i][1] * 100}%`; };
      place();
      el.addEventListener("pointerdown", (e) => {
        el.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const r = preview.getBoundingClientRect();
          current.corners[i] = [Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))];
          place();
          drawOutline();
        };
        const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      });
      el.addEventListener("keydown", (e) => {
        const step = e.shiftKey ? 0.05 : 0.01;
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (!d) return;
        e.preventDefault();
        current.corners[i] = [Math.min(1, Math.max(0, current.corners[i][0] + d[0])), Math.min(1, Math.max(0, current.corners[i][1] + d[1]))];
        place();
        drawOutline();
      });
      return el;
    });
    const base = preview.getContext("2d").getImageData(0, 0, preview.width, preview.height);
    function drawOutline() {
      const ctx = preview.getContext("2d");
      ctx.putImageData(base, 0, 0);
      ctx.strokeStyle = "#FF2E93";
      ctx.lineWidth = Math.max(3, preview.width / 200);
      ctx.beginPath();
      current.corners.forEach(([x, y], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, x * preview.width, y * preview.height));
      ctx.closePath();
      ctx.stroke();
    }
    drawOutline();
    stage.append(...handles);

    const mode = h("select", { class: "input", id: "scan-mode", style: { maxWidth: "240px" } },
      h("option", { value: "color" }, "Couleur"), h("option", { value: "gray" }, "Niveaux de gris"), h("option", { value: "bw" }, "Noir et blanc"));
    const validate = h("button", { class: "btn primary", type: "button" }, icon("check"), "Valider la page");
    validate.addEventListener("click", async () => {
      validate.disabled = true;
      validate.replaceChildren(h("span", { class: "spinner", style: { width: "22px", height: "22px" } }), "Nettoyage…");
      try {
        pages.push(await processPage(current.canvas, current.corners, mode.value));
        paintPages();
        editor.hidden = true;
        nextInQueue();
      } catch (err) {
        errorToast(err);
        validate.disabled = false;
        validate.replaceChildren(icon("check"), "Valider la page");
      }
    });
    mount(editor,
      h("h2", {}, "Ajuste les coins de la feuille"),
      h("p", { class: "small muted" }, "Fais glisser les ronds roses sur les coins (ou utilise les flèches du clavier)."),
      stage,
      h("div", { class: "row", style: { marginTop: "14px" } },
        h("label", { for: "scan-mode", class: "sr-only" }, "Rendu"), mode,
        h("button", { class: "btn", type: "button", onclick: () => edit(rotate90(current.canvas)) }, icon("rotate"), "Pivoter"),
        h("button", { class: "btn", type: "button", onclick: () => { editor.hidden = true; nextInQueue(); } }, "Ignorer"),
        validate));
    editor.hidden = false;
    editor.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function nextInQueue() {
    const file = queue.shift();
    if (!file) return;
    if (pages.length >= MAX_PAGES) { toast(`${MAX_PAGES} pages maximum par document.`, "info"); queue.length = 0; return; }
    try { edit(await loadImage(file)); } catch { toast("Image illisible.", "error"); nextInQueue(); }
  }

  function addFiles(files) {
    queue.push(...[...files].filter((f) => f.type.startsWith("image/")));
    if (editor.hidden) nextInQueue();
  }
  /** Affiche le texte lu à côté de la photo ; renvoie le texte corrigé (ou null si annulé). */
  function reviewText(text, shots) {
    return new Promise((resolve) => {
      const area = h("textarea", { class: "input", id: "ocr-text", rows: 14, spellcheck: true, style: { fontFamily: "var(--font-hand)", lineHeight: "1.6" } });
      area.value = text;
      const thumbs = h("div", { class: "pages" }, shots.slice(0, 8).map((p, i) =>
        h("figure", {}, h("img", { src: smallCopy(p, 240).toDataURL("image/jpeg", 0.7), alt: `Page ${i + 1}` }), h("figcaption", {}, `Page ${i + 1}`))));
      const card = h("section", { class: "card sketch stack", style: { marginTop: "20px" } },
        h("h2", {}, "Vérifie le texte lu"),
        h("p", { class: "small muted" }, "La lecture automatique peut se tromper, surtout sur l'écriture manuscrite. Corrige directement ci-dessous : c'est ce texte qui servira pour tes fiches, podcasts et corrections."),
        thumbs,
        h("div", { class: "field" }, h("label", { for: "ocr-text" }, "Texte lu (modifiable)"), area),
        h("div", { class: "row" },
          h("button", { class: "btn", type: "button", onclick: () => { card.remove(); resolve(null); } }, "Annuler"),
          h("button", { class: "btn primary", type: "button", onclick: () => { card.remove(); resolve(area.value.trim()); } }, icon("check"), "Le texte est bon, continuer")));
      finishBtn.after(card);
      area.focus();
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  camera.addEventListener("change", () => { addFiles(camera.files); camera.value = ""; });
  gallery.addEventListener("change", () => { addFiles(gallery.files); gallery.value = ""; });

  finishBtn.addEventListener("click", async () => {
    finishBtn.disabled = true;
    status.textContent = "Création du PDF…";
    try {
      const pdf = await buildPdf(pages);
      status.textContent = "Studoo lit tes pages pour deviner le cours (IA)…";
      let text = "";
      try {
        text = await ocrImages(pages.slice(0, 8).map((p) => canvasToBase64(smallCopy(p, 1100), 0.7)));
      } catch (err) {
        toast(`Lecture IA impossible (${err.message}). Tu peux taper le texte toi-même ou continuer sans.`, "info", 8000);
      }
      refreshQuota?.();
      status.textContent = "";
      // Étape de relecture : l'élève voit le texte lu et corrige les erreurs de lecture.
      const checked = await reviewText(text, pages);
      if (checked === null) { finishBtn.disabled = false; return; }
      const id = addPending({
        kind: "scan", excerpt: checked || "Cours numérisé (texte non lu)", startedAt: new Date().toISOString(),
        save: (folderId, title) => savePdfWithText({ folderId, title, pdfBlob: pdf, text: checked, kind: "scan" }),
      });
      go(`/confirmer?id=${id}`);
    } catch (err) {
      errorToast(err);
      finishBtn.disabled = false;
      status.textContent = "";
    }
  });

  mount(view,
    h("h1", { class: "view-title" }, "Numériser une ", h("span", { class: "hl" }, "feuille")),
    h("p", { class: "muted" }, "Pose ta feuille sur une surface sombre, bien éclairée, et prends-la en photo. Studoo la redresse, la recadre et la rend lisible comme un PDF imprimé."),
    camera, gallery,
    h("div", { class: "row" },
      h("button", { class: "btn primary big", type: "button", onclick: () => camera.click() }, icon("camera"), "Prendre une photo"),
      h("button", { class: "btn big", type: "button", onclick: () => gallery.click() }, icon("photo"), "Choisir des images")),
    editor, pagesBox, status, h("div", { style: { marginTop: "16px" } }, finishBtn),
    h("p", { class: "small muted", style: { marginTop: "18px" } }, icon("shield-lock"), " Le traitement de l'image se fait dans ton navigateur. Seule une copie réduite est envoyée à l'IA pour lire le texte."));
}
