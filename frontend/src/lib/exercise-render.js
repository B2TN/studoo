// Feuilles d'exercices et corrections, dans le style cahier dessiné à la main.
// Le corrigé est MASQUÉ par défaut : l'élève le révèle question par question, ou en entier.
import { h } from "./dom.js";
import { icon } from "./icons.js";

export const SHEET_TYPES = [
  ["entrainement", "Exercices d'entraînement", "Des exercices progressifs pour appliquer le cours (comme un TD). ≈ 45 min."],
  ["pratique", "Mise en pratique", "Des problèmes concrets à résoudre étape par étape (comme un TP). ≈ 1 h."],
  ["controle", "Contrôle blanc", "Un vrai sujet de contrôle noté sur 20, à faire en temps limité (comme un DST). ≈ 1 h."],
  ["flash", "Questions flash", "15 questions à choix multiples pour vérifier l'essentiel (QCM). ≈ 10 min."],
];
export const DIFFICULTIES = [
  ["progressif", "Progressive", "Du plus facile au plus difficile"],
  ["facile", "Facile", "Applications directes du cours"],
  ["moyen", "Moyenne", "Il faut combiner deux notions"],
  ["difficile", "Difficile", "Raisonnements en plusieurs étapes"],
];
const DIFFICULTY_LABEL = Object.fromEntries(DIFFICULTIES.map(([v, l]) => [v, l]));
const LETTERS = ["A", "B", "C", "D", "E", "F"];
/**
 * Indices et exposants écrits « à la calculatrice » par l'IA → vraie mise en forme :
 * u_n, u_{n+1}, 2^n, q^(n+1) → u<sub>n</sub>, u<sub>n+1</sub>, 2<sup>n</sup>, q<sup>n+1</sup> (sans HTML injecté).
 */
export function math(text) {
  const out = [];
  const re = /([_^])(\{([^}]*)\}|\(([^)]*)\)|([A-Za-z0-9+\-]+))/g;
  let last = 0;
  for (let m; (m = re.exec(String(text ?? ""))); ) {
    out.push(String(text).slice(last, m.index));
    out.push(h(m[1] === "_" ? "sub" : "sup", {}, m[3] ?? m[4] ?? m[5]));
    last = re.lastIndex;
  }
  out.push(String(text ?? "").slice(last));
  return out.filter((x) => x !== "");
}

const pts = (n) => `${String(n).replace(".", ",")} pt${n > 1 ? "s" : ""}`;

function question(q, reveal) {
  const answer = h("div", { class: "x-answer", hidden: true },
    h("p", {}, h("strong", {}, "Réponse : "), math(q.short_answer)),
    h("p", { class: "x-steps" }, math(q.answer)),
    q.notion ? h("p", { class: "small muted" }, "Notion : ", q.notion) : null);
  const btn = h("button", { class: "btn small ghost x-toggle", type: "button", "aria-expanded": "false", onclick: () => {
    answer.hidden = !answer.hidden;
    btn.setAttribute("aria-expanded", String(!answer.hidden));
    btn.lastChild.textContent = answer.hidden ? "Voir le corrigé" : "Cacher le corrigé";
    btn.firstChild.replaceWith(icon(answer.hidden ? "eye" : "eye-off"));
  } }, icon("eye"), "Voir le corrigé");
  reveal.push((show) => {
    if (answer.hidden === show) btn.click();
  });
  return h("li", { class: "x-q" },
    h("div", { class: "x-q-head" }, h("strong", { class: "x-label" }, q.label), h("span", { class: "x-pts" }, pts(q.points))),
    h("p", {}, math(q.statement)),
    q.choices?.length ? h("ol", { class: "x-choices", type: "A" }, q.choices.map((c, i) => h("li", {}, h("span", { class: "x-letter" }, LETTERS[i]), math(c)))) : null,
    h("div", { class: "x-lines", "aria-hidden": "true" }),
    btn, answer);
}

/** Feuille d'exercices. Renvoie { el, revealAll(show) }. */
export function renderSheet(doc) {
  const reveal = [];
  const exercises = (doc.exercises || []).map((ex, i) => h("section", { class: "x-ex", style: { "--rot": `${i % 2 ? 0.3 : -0.3}deg` } },
    h("h2", {}, h("span", { class: "hl" }, ex.title)),
    ex.intro ? h("p", { class: "x-intro" }, math(ex.intro)) : null,
    h("ol", { class: "x-qs" }, ex.questions.map((q) => question(q, reveal)))));
  const el = h("article", { class: "fiche sheet", "aria-label": `Feuille d'exercices : ${doc.title}` },
    h("header", { class: "f-head" },
      h("p", { class: "x-kicker" }, h("span", { class: "badge c-pink", style: { color: "var(--on-fluo)" } }, doc.type_label || "Exercices"),
        ` · ${DIFFICULTY_LABEL[doc.difficulty] || ""} · ≈ ${doc.duration_minutes} min · noté sur ${doc.total}`),
      h("h1", {}, doc.title),
      doc.instructions ? h("p", { class: "f-sub" }, doc.instructions) : null,
      h("p", { class: "x-name", "aria-hidden": "true" }, "Nom : ……………………  Date : ……………")),
    exercises,
    h("footer", { class: "f-foot" }, "Feuille générée par Studoo à partir de tes cours. Réponds sur papier, puis prends ta copie en photo pour la faire corriger."));
  return { el, revealAll: (show) => reveal.forEach((fn) => fn(show)) };
}

const VERDICT = { juste: ["Juste", "green", "check"], partiel: ["En partie", "yellow", "alert-triangle"], faux: ["Faux", "pink", "x"], absent: ["Pas de réponse", "lilac", "x"] };

/** Correction d'une copie : note, erreurs question par question, notions à revoir (avec liens vers les cours). */
export function renderCorrection(doc, { tree = [] } = {}) {
  const chapterHref = (id) => {
    for (const c of tree) {
      if (c.id === id) return `/cours/${c.id}`;
      const ch = c.chapters.find((x) => x.id === id);
      if (ch) return `/cours/${c.id}/${ch.id}`;
    }
    return null;
  };
  const ratio = doc.total ? doc.grade / doc.total : 0;
  return h("article", { class: "fiche correction", "aria-label": `Correction : ${doc.sheet_title}` },
    h("header", { class: "f-head x-grade-head" },
      h("div", { class: `x-grade c-${ratio >= 0.7 ? "green" : ratio >= 0.5 ? "yellow" : "pink"}`, role: "img",
        "aria-label": `Note : ${doc.grade} sur ${doc.total}` },
      h("strong", {}, String(doc.grade).replace(".", ",")), h("span", {}, `/ ${doc.total}`)),
      h("div", {},
        h("h1", {}, "Correction"),
        h("p", { class: "f-sub" }, doc.sheet_title),
        doc.sheet_id ? h("a", { href: `/fichier/${doc.sheet_id}`, "data-link": "1", class: "small" }, "Revoir la feuille et son corrigé") : null)),
    !doc.readable ? h("p", { class: "notice", role: "alert" }, icon("alert-triangle"),
      " Ta copie était difficile à lire (ou ne correspond pas à cette feuille) : la note peut être fausse. Reprends une photo bien nette, à plat et éclairée.") : null,
    doc.general_comment ? h("p", { class: "x-comment" }, doc.general_comment) : null,
    h("section", { class: "x-ex" }, h("h2", {}, h("span", { class: "hl" }, "Question par question")),
      h("ol", { class: "x-qs" }, (doc.questions || []).map((q) => {
        const [label, color, ic] = VERDICT[q.verdict] || VERDICT.faux;
        return h("li", { class: "x-q" },
          h("div", { class: "x-q-head" }, h("strong", { class: "x-label" }, q.label),
            h("span", { class: `badge c-${color}`, style: { color: "var(--on-fluo)" } }, icon(ic), " ", label),
            h("span", { class: "x-pts" }, `${String(q.points_obtained).replace(".", ",")} / ${pts(q.points_max)}`)),
          q.read_answer ? h("p", {}, h("em", {}, "Ta réponse : "), math(q.read_answer)) : null,
          q.errors?.length ? h("ul", { class: "x-errors" }, q.errors.map((e) => h("li", {}, math(e)))) : null,
          q.comment ? h("p", { class: "small muted" }, q.comment) : null);
      }))),
    doc.to_review?.length ? h("section", { class: "f-keys c-yellow" }, h("span", { class: "tape" }),
      h("h2", {}, "À revoir"),
      h("ul", {}, doc.to_review.map((r) => {
        const href = r.source_id ? `/fichier/${r.source_id}` : null;
        const chap = r.chapter_id ? chapterHref(r.chapter_id) : null;
        return h("li", {}, h("strong", {}, r.notion), " — ", r.why, " ",
          href ? h("a", { href, "data-link": "1" }, `(cours : ${r.source_title || "ouvrir"})`) : null,
          chap ? [" ", h("a", { href: chap, "data-link": "1" }, "(chapitre)")] : null);
      }))) : null,
    h("footer", { class: "f-foot" }, doc.read_by === "lecteur local"
      ? "Copie lue par le lecteur automatique de Studoo puis corrigée par l'IA : vérifie les réponses mal lues."
      : "Copie lue et corrigée par l'IA (GPT-4.1 mini) : si une réponse a été mal lue, fie-toi au corrigé de la feuille."));
}
