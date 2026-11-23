// Services d'emploi du temps pris en charge.
//
// Honnêteté : aucun de ces services n'a d'API publique officielle.
// - Pronote : connecteur non officiel (Pawnote) par QR code, ou lien iCal.
// - Universités : l'emploi du temps (ADE, Celcat, HyperPlanning…) propose presque
//   toujours un lien iCal personnel. Studoo guide l'étudiant pour le récupérer, puis
//   le synchronise en continu (les dates des liens ADE sont mises à jour automatiquement).

export const HIGH_SCHOOL_SERVICES = [
  { id: "pronote", name: "Pronote", connector: "pronote", note: "Connexion par QR code (recommandé) ou lien iCal." },
  { id: "monlycee", name: "Monlycée.net (Île-de-France)", connector: "pronote", note: "L'emploi du temps vient de Pronote : utilise le QR code Pronote." },
  { id: "mbn", name: "Mon Bureau Numérique (Grand Est)", connector: "pronote", note: "Ouvre Pronote depuis l'ENT, puis utilise le QR code." },
  { id: "skolengo", name: "Skolengo / ENT régionaux", connector: "pronote", note: "Si ton établissement utilise Pronote : QR code. Sinon, lien iCal s'il est proposé." },
  { id: "hdf", name: "ENT Hauts-de-France", connector: "pronote", note: "Ouvre Pronote depuis l'ENT, puis utilise le QR code." },
  { id: "toutatice", name: "Toutatice (Bretagne)", connector: "pronote", note: "Ouvre Pronote depuis Toutatice, puis utilise le QR code." },
  { id: "ecoledirecte", name: "ÉcoleDirecte", connector: "ics", note: "ÉcoleDirecte ne propose pas d'export iCal : importe un fichier .ics si ton établissement en fournit un." },
];

// Les 20 plus grands établissements d'enseignement supérieur (par nombre d'étudiants).
export const UNIVERSITIES = [
  { name: "Aix-Marseille Université", city: "Marseille", url: "https://www.univ-amu.fr" },
  { name: "Université de Lorraine", city: "Nancy / Metz", url: "https://www.univ-lorraine.fr" },
  { name: "Université de Lille", city: "Lille", url: "https://www.univ-lille.fr" },
  { name: "Université Paris Cité", city: "Paris", url: "https://u-paris.fr" },
  { name: "Sorbonne Université", city: "Paris", url: "https://www.sorbonne-universite.fr" },
  { name: "Université Paris 1 Panthéon-Sorbonne", city: "Paris", url: "https://www.pantheonsorbonne.fr" },
  { name: "Université de Bordeaux", city: "Bordeaux", url: "https://www.u-bordeaux.fr" },
  { name: "Université Grenoble Alpes", city: "Grenoble", url: "https://www.univ-grenoble-alpes.fr" },
  { name: "Université Côte d'Azur", city: "Nice", url: "https://univ-cotedazur.fr" },
  { name: "Université de Strasbourg", city: "Strasbourg", url: "https://www.unistra.fr" },
  { name: "Université de Montpellier", city: "Montpellier", url: "https://www.umontpellier.fr" },
  { name: "Nantes Université", city: "Nantes", url: "https://www.univ-nantes.fr" },
  { name: "Université Claude Bernard Lyon 1", city: "Lyon", url: "https://www.univ-lyon1.fr" },
  { name: "Université Paris-Saclay", city: "Saclay", url: "https://www.universite-paris-saclay.fr" },
  { name: "Université Toulouse III – Paul Sabatier", city: "Toulouse", url: "https://www.univ-tlse3.fr" },
  { name: "Université Paris Nanterre", city: "Nanterre", url: "https://www.parisnanterre.fr" },
  { name: "Université Paris-Est Créteil", city: "Créteil", url: "https://www.u-pec.fr" },
  { name: "Université de Rennes", city: "Rennes", url: "https://www.univ-rennes.fr" },
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

export const QR_STEPS_PRONOTE = [
  "Ouvre Pronote sur un ordinateur (directement ou depuis ton ENT).",
  "Clique sur l'icône QR code en haut de la page (« Accès mobile »).",
  "Choisis un code à 4 chiffres de ton choix : un QR code s'affiche (valable 10 minutes).",
  "Scanne ce QR code avec la caméra ci-dessous (ou importe une capture d'écran), puis tape ton code à 4 chiffres.",
];
