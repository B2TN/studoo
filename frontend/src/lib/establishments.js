// Établissements et aides pour l'emploi du temps.
//
// Itération 4 :
// - lycées : le robot de Studoo se connecte à Pronote (avec ou sans ENT régional) à partir du code officiel
//   du lycée (UAI) et des identifiants de l'élève : plus aucun lien ni QR code ;
// - universités sous ADE (champ `robot`) : le robot se connecte par la page de l'université, puis l'étudiant
//   choisit son année, sa filière et sa classe dans l'arborescence d'ADE ; testé sur Paris Cité (IUT) ;
// - autres : les étapes ci-dessous guident le « dernier recours » (lien iCal à coller).

// Les 20 plus grands établissements d'enseignement supérieur (par nombre d'étudiants).
const STEPS_PARIS_CITE = [
  "Clique sur « Ouvrir l'emploi du temps ADE » : la page officielle de l'Université Paris Cité s'ouvre (connexion avec ton identifiant ENT habituel).",
  "Choisis ta formation / ton groupe dans l'arborescence (IUT de Paris – Rives de Seine → ton BUT → ton groupe).",
  "Clique sur « Export Agenda », choisis une date de début et de fin, puis « Générer URL ».",
  "Copie le lien généré (il contient « anonymous_cal.jsp ») et colle-le ci-dessous.",
];

/** Universités dont le robot a été testé avec un vrai compte (les autres sont « en test »). */
export const ROBOT_TESTED = new Set(["paris-cite"]);

export const UNIVERSITIES = [
  { name: "IUT de Paris – Rives de Seine", city: "Université Paris Cité", url: "https://iutparis-seine.u-paris.fr", ade: "https://adeconsult.app.u-pariscite.fr/direct/", steps: STEPS_PARIS_CITE, robot: "paris-cite" },
  { name: "Aix-Marseille Université", city: "Marseille", url: "https://www.univ-amu.fr", robot: "amu" },
  { name: "Université de Lorraine", city: "Nancy / Metz", url: "https://www.univ-lorraine.fr" },
  { name: "Université de Lille", city: "Lille", url: "https://www.univ-lille.fr" },
  { name: "Université Paris Cité", city: "Paris", url: "https://u-paris.fr", ade: "https://adeconsult.app.u-pariscite.fr/direct/", steps: STEPS_PARIS_CITE, robot: "paris-cite" },
  { name: "Sorbonne Université", city: "Paris", url: "https://www.sorbonne-universite.fr" },
  { name: "Université Paris 1 Panthéon-Sorbonne", city: "Paris", url: "https://www.pantheonsorbonne.fr" },
  { name: "Université de Bordeaux", city: "Bordeaux", url: "https://www.u-bordeaux.fr" },
  { name: "Université Grenoble Alpes", city: "Grenoble", url: "https://www.univ-grenoble-alpes.fr" },
  { name: "Université Côte d'Azur", city: "Nice", url: "https://univ-cotedazur.fr" },
  { name: "Université de Strasbourg", city: "Strasbourg", url: "https://www.unistra.fr" },
  { name: "Université de Montpellier", city: "Montpellier", url: "https://www.umontpellier.fr" },
  { name: "Nantes Université", city: "Nantes", url: "https://www.univ-nantes.fr" },
  { name: "Université Claude Bernard Lyon 1", city: "Lyon", url: "https://www.univ-lyon1.fr", robot: "lyon1" },
  { name: "Université Paris-Saclay", city: "Saclay", url: "https://www.universite-paris-saclay.fr" },
  { name: "Université Toulouse III – Paul Sabatier", city: "Toulouse", url: "https://www.univ-tlse3.fr" },
  { name: "Université Paris Nanterre", city: "Nanterre", url: "https://www.parisnanterre.fr" },
  { name: "Université Paris-Est Créteil", city: "Créteil", url: "https://www.u-pec.fr" },
  { name: "Université de Rennes", city: "Rennes", url: "https://www.univ-rennes.fr", robot: "rennes" },
  { name: "Université Lumière Lyon 2", city: "Lyon", url: "https://www.univ-lyon2.fr" },
  { name: "Université Clermont Auvergne", city: "Clermont-Ferrand", url: "https://www.uca.fr" },
];

/** Reconnaît le logiciel d'emploi du temps à partir du lien collé. */
export function detectSoftware(url) {
  const u = String(url).toLowerCase();
  if (u.includes("anonymous_cal.jsp") || /\bade\b|ade[-.]|\/ade\//.test(u)) return "ADE Campus";
  if (u.includes("celcat")) return "Celcat";
  if (u.includes("hyperplanning") || u.includes("/hp/") || u.includes("hpcal")) return "HyperPlanning";
  if (u.includes("index-education") || u.includes("pronote")) return "Pronote";
  if (u.includes("calendar.google")) return "Google Agenda";
  if (u.endsWith(".ics") || u.startsWith("webcal://")) return "iCal";
  return null;
}

export const ICAL_STEPS_UNIVERSITY = [
  "Connecte-toi à ton ENT (le site de ton université → « ENT » ou « Intranet »).",
  "Ouvre ton emploi du temps (souvent appelé ADE, Celcat, HyperPlanning ou « Planning »).",
  "Cherche un bouton « Exporter », « Synchroniser », « iCal » ou une icône de calendrier, puis « Générer l'URL ».",
  "Copie le lien proposé (il finit souvent par .ics ou contient « anonymous_cal ») et colle-le ci-dessous.",
];

export const ICAL_STEPS_PRONOTE = [
  "Ouvre Pronote sur un ordinateur (directement ou depuis ton ENT).",
  "Va dans « Emploi du temps », puis clique sur l'icône « Exporter » (calendrier avec une flèche).",
  "Choisis « Exporter au format iCal » et copie le lien affiché.",
  "Colle-le ci-dessous : ton emploi du temps se mettra à jour tout seul.",
];
