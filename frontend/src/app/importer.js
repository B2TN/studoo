// Import d'un PDF de cours depuis l'appareil.
import { h, mount } from "../lib/dom.js";
import { bytes } from "../lib/format.js";
import { icon } from "../lib/icons.js";
import { addPending } from "../lib/pending.js";
import { ocrImages, pdfText, pdfToImages, savePdfWithText } from "../lib/pdf-tools.js";
import { drive } from "../lib/storage.js";
import { errorToast, toast } from "../lib/ui.js";

const MAX = 40 * 1024 * 1024;

export async function render({ view, query, go }) {
  const dest = query.get("dest");
  const status = h("p", { role: "status", class: "muted" });
  const input = h("input", { type: "file", accept: "application/pdf,.pdf", id: "pdf-file", class: "sr-only" });
  const drop = h("label", { for: "pdf-file", class: "card sketch", style: { display: "block", textAlign: "center", padding: "40px 20px", cursor: "pointer", borderStyle: "dashed" } },
    icon("file-upload", { doodle: true }), h("p", { style: { fontSize: "24px", margin: "10px 0" } }, "Choisis un PDF de cours"),
    h("span", { class: "muted small" }, "ou glisse-le ici · 40 Mo maximum"));

  async function handle(file) {
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) { toast("Ce fichier n'est pas un PDF.", "error"); return; }
    if (file.size > MAX) { toast(`Fichier trop gros (${bytes(file.size)}).`, "error"); return; }
    status.textContent = "Lecture du PDF…";
    let text = "";
    try { text = await pdfText(file); } catch { toast("Ce PDF est illisible ou protégé.", "error"); status.textContent = ""; return; }
    let ocr = "";
    if (text.length < 40) {
      status.textContent = "Ce PDF est une image : Studoo lit le texte avec l'IA…";
      try { ocr = await ocrImages(await pdfToImages(file)); } catch (err) { toast(`Lecture IA impossible : ${err.message}`, "info"); }
    }
    const title = file.name.replace(/\.pdf$/i, "");
    const save = (folderId, t) => savePdfWithText({ folderId, title: t, pdfBlob: file, text: ocr, kind: "pdf" });
    if (dest) {
      const saved = await save(dest, title);
      toast("PDF importé", "success");
      go(`/fichier/${saved.id}`, { replace: true });
      return;
    }
    const id = addPending({ kind: "pdf", excerpt: (text || ocr || title).slice(0, 8000), save });
    go(`/confirmer?id=${id}`);
  }

  input.addEventListener("change", () => handle(input.files[0]).catch(errorToast));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.style.background = "var(--fluo-yellow)"; });
  drop.addEventListener("dragleave", () => { drop.style.background = ""; });
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.style.background = ""; handle(e.dataTransfer.files[0]).catch(errorToast); });

  const destName = dest ? (await drive.get(dest).catch(() => null))?.name : null;
  mount(view,
    h("h1", { class: "view-title" }, "Importer un ", h("span", { class: "hl" }, "PDF")),
    h("p", { class: "muted" }, destName ? `Il sera rangé dans « ${destName} ».` : "Studoo te proposera ensuite le bon cours et le bon chapitre."),
    input, drop, status);
}
