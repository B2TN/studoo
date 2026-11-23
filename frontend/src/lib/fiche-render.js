// Affiche une fiche de révision (JSON produit par l'IA) dans le style cahier.
import { h } from "./dom.js";

const BLOCK_LABEL = {
  definition: "Définition", formula: "Formule", example: "Exemple", warning: "Attention", tip: "Astuce", date: "Date",
};
const COLORS = new Set(["yellow", "pink", "green", "blue", "orange", "lilac"]);

function block(b, color) {
  const label = b.title || BLOCK_LABEL[b.type] || "";
  const items = (b.items || []).filter(Boolean);
  const body = [
    b.text ? h("p", {}, b.text) : null,
    items.length ? h("ul", {}, items.map((it) => h("li", {}, it))) : null,
  ];
  switch (b.type) {
    case "definition":
      return h("div", { class: "f-def" }, h("span", { class: `hl ${color === "yellow" ? "" : color}` }, label), body);
    case "formula":
      return h("div", { class: "f-formula" }, label ? h("span", { class: "f-label" }, label) : null, h("p", { class: "f-math" }, b.text), items.length ? body[1] : null);
    case "warning":
      return h("div", { class: "f-warn" }, h("strong", {}, "⚠ ", label), body);
    case "tip":
      return h("div", { class: "f-tip c-lilac" }, h("strong", {}, "💡 ", label), body);
    case "example":
      return h("div", { class: "f-example" }, h("em", {}, label, " : "), body);
    case "date":
      return h("div", { class: "f-date" }, h("span", { class: "f-pill" }, label || "Date"), body);
    default:
      return h("div", { class: "f-par" }, label ? h("strong", {}, label, " — ") : null, body);
  }
}

export function renderFiche(fiche) {
  const sections = (fiche.sections || []).map((s, i) => {
    const color = COLORS.has(s.color) ? s.color : "yellow";
    return h("section", { class: `f-section f-${color}`, style: { "--rot": `${i % 2 ? 0.4 : -0.4}deg` } },
      h("h2", {}, h("span", { class: `hl ${color === "yellow" ? "" : color}` }, s.heading)),
      (s.blocks || []).map((b) => block(b, color)));
  });
  return h("article", { class: "fiche", "aria-label": `Fiche : ${fiche.title}` },
    h("header", { class: "f-head" },
      h("h1", {}, fiche.title),
      fiche.subtitle ? h("p", { class: "f-sub" }, fiche.subtitle) : null),
    h("div", { class: "f-grid" }, sections),
    fiche.key_points?.length ? h("section", { class: "f-keys c-yellow" }, h("span", { class: "tape" }),
      h("h2", {}, "À retenir"), h("ol", {}, fiche.key_points.map((k) => h("li", {}, k)))) : null,
    fiche.mnemonic ? h("p", { class: "f-mnemo" }, h("strong", {}, "Moyen mnémotechnique : "), fiche.mnemonic) : null,
    fiche.quiz?.length ? h("section", { class: "f-quiz" }, h("h2", {}, "Mini-quiz"),
      fiche.quiz.map((q, i) => h("details", {}, h("summary", {}, `${i + 1}. ${q.question}`), h("p", {}, q.answer)))) : null,
    h("footer", { class: "f-foot" }, "Fiche générée par Studoo à partir de tes cours."));
}
