// Génère docs/SERVICES.md à partir de src/lib/services.js (une seule source pour l'admin et la documentation).
// Usage : node scripts/services-doc.mjs   (depuis le dossier frontend)
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FLOW, SERVICES } from "../src/lib/services.js";

export function servicesMarkdown() {
  const lines = [
    "# Services utilisés par Studoo",
    "",
    "> Fichier généré par `frontend/scripts/services-doc.mjs` à partir de `frontend/src/lib/services.js`",
    "> (la même liste que la section « Services » de la page admin). Ne pas modifier à la main.",
    "> Aucune clé ni aucun secret ici : seulement à quoi sert chaque service et où trouver sa configuration.",
    "",
    "## Comment tout le site fonctionne",
    "",
    ...FLOW.map(([title, text], i) => `${i + 1}. **${title}** — ${text}`),
    "",
    "## Inventaire",
    "",
    "| Service | Rôle | Offre gratuite et limites |",
    "|---|---|---|",
    ...SERVICES.map((s) => `| [${s.name}](${s.url}) | ${s.role} | ${s.free} |`),
    "",
  ];
  for (const s of SERVICES) {
    lines.push(`## ${s.name}`, "", `- **Rôle :** ${s.role}`, `- **Fonctionnement :** ${s.how}`, `- **Offre gratuite :** ${s.free}`,
      `- **Configuration (sans secrets) :** ${s.config}`, `- **Où trouver quoi :** ${s.where.map(([l, u]) => `[${l}](${u})`).join(" · ")}`,
      `- **En cas de panne :** ${s.outage}`, "");
  }
  return lines.join("\n").replace(/\|(?=[^|\n]*\n)/g, "|");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL("../../docs/SERVICES.md", import.meta.url), servicesMarkdown(), "utf8");
  console.log("docs/SERVICES.md à jour");
}
