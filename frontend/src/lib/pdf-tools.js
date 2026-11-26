// Outils PDF partagés : lecture du texte, rendu en images (pour l'OCR), envoi OCR.
import { api } from "./api.js";
import { drive, pdfText, safeName } from "./storage.js";

export { pdfText };

async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

/** Rend les premières pages d'un PDF en JPEG (base64) pour les faire lire par l'IA. */
export async function pdfToImages(blob, { maxPages = 8, width = 1200 } = {}) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  const out = [];
  for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
    const page = await doc.getPage(i);
    const vp0 = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / vp0.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport, canvas }).promise;
    out.push(canvasToBase64(canvas, 0.72));
  }
  return out;
}

export function canvasToBase64(canvas, quality = 0.75) {
  return canvas.toDataURL("image/jpeg", quality).split(",")[1];
}

/** Lecture des pages scannées (Azure OpenAI par défaut, Gemini seulement si l'élève l'a choisi) : texte Markdown. */
export async function ocrImages(base64List) {
  const res = await api("/api/ai/ocr", { method: "POST", json: { images: base64List.slice(0, 8).map((data) => ({ data, mime: "image/jpeg" })) } });
  return res.text;
}

/** Enregistre un PDF (+ son texte lu par l'IA s'il y en a un) dans un dossier. */
export async function savePdfWithText({ folderId, title, pdfBlob, text, kind = "pdf" }) {
  const name = safeName(title);
  let textId = "";
  if (text) {
    const t = await drive.save({
      parentId: folderId, name: `${name} (texte).md`, mimeType: "text/markdown", kind: "scan-text",
      blob: new Blob([`# ${name}\n\n${text}`], { type: "text/markdown" }),
    });
    textId = t.id;
  }
  return drive.save({ parentId: folderId, name: `${name}.pdf`, mimeType: "application/pdf", kind, blob: pdfBlob, props: textId ? { textId } : {} });
}
