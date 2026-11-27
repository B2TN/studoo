// Pages publiques de contenu (itération 7, L3) : une page par outil, en HTML pré-généré (lisible par les
// moteurs de recherche et les IA sans exécuter de JavaScript), + sitemap.xml et llms.txt.
// Usage : node scripts/seo-pages.mjs   (depuis le dossier frontend). Un test vérifie que les fichiers sont à jour.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SITE = "https://studoo-app.vercel.app";
export const UPDATED = "2026-11-27";

export const TOOLS = [
  {
    slug: "transcrire-un-cours", color: "pink", short: "Transcrire un cours",
    title: "Transcrire un cours enregistré en texte, gratuitement · Studoo",
    h1: ["Transcrire un cours ", "en texte", ", avec qui parle"],
    description: "Enregistre ton cours au micro : Studoo le transcrit en texte avec « Professeur : » et « Élève : », puis efface l'audio. Gratuit, rangé dans ton Google Drive.",
    intro: "Le micro de ton téléphone ou de ton ordinateur enregistre le cours. Toutes les 5 minutes, le morceau est envoyé à Azure AI Speech, qui le transcrit en reconnaissant les différentes voix. Studoo écrit qui parle (« Professeur : », « Élève : »), range la transcription dans ton Google Drive, puis efface l'audio.",
    steps: ["Accepte l'engagement (accord du professeur et des personnes enregistrées).", "Appuie sur le micro au début du cours ; le texte apparaît au fil de l'eau.",
      "À la fin, Studoo devine le cours et le chapitre (grâce à ton emploi du temps) et propose un titre.", "La transcription est rangée dans le dossier « Studoo » de ton Drive."],
    limits: ["Il faut l'accord du professeur et des personnes enregistrées (article 226-1 du Code pénal).", "Aucun fichier audio n'est conservé, même si la transcription échoue.",
      "Limites quotidiennes par élève : voir la page Données personnelles (section « Limites »)."],
    faq: [["La transcription est-elle gratuite ?", "Oui. Studoo est gratuit, sans abonnement ni publicité. Une limite quotidienne par élève protège le service."],
      ["Mon audio est-il gardé ?", "Non. Chaque morceau est transcrit puis effacé de la mémoire du serveur ; il n'est enregistré nulle part, ni chez Studoo, ni dans ton Drive."],
      ["Le cours peut-il être dans une autre langue ?", "Oui, la transcription suit la langue parlée."]],
  },
  {
    slug: "fiche-de-revision-automatique", color: "green", short: "Fiche de révision automatique",
    title: "Fiche de révision automatique à partir de tes cours · Studoo",
    h1: ["Une fiche de révision ", "automatique", ", à partir de TES cours"],
    description: "Choisis tes cours (transcriptions, PDF, photos) : Studoo crée une fiche de révision dessinée à la main avec définitions, formules, pièges et mini-quiz. Uniquement à partir de ton contenu.",
    intro: "Studoo lit les documents que tu choisis et en tire une fiche claire : sections colorées, définitions surlignées, formules encadrées, pièges à éviter, astuces et un mini-quiz. L'IA a une règle absolue : n'utiliser que ce qui est écrit dans tes cours, sans rien inventer.",
    steps: ["Ouvre « Créer une fiche » et coche les cours à utiliser.", "Choisis où ranger la fiche (cours, chapitre).", "La fiche s'affiche en quelques secondes ; exporte-la en PDF si tu veux l'imprimer."],
    limits: ["Une IA peut se tromper : vérifie la fiche avec ton cours.", "L'IA du site tourne sur Microsoft Azure ; rien n'est envoyé à Google Gemini, sauf si tu choisis d'utiliser ta propre clé."],
    faq: [["La fiche peut-elle contenir des erreurs ?", "Oui, comme tout contenu généré par une IA. Elle n'utilise que tes documents, mais relis-la avec ton cours."],
      ["Puis-je l'imprimer ?", "Oui : chaque fiche s'exporte en PDF."], ["Où est-elle enregistrée ?", "Dans ton Google Drive, dossier « Studoo », dans le cours et le chapitre choisis."]],
  },
  {
    slug: "podcast-de-revision", color: "blue", short: "Podcast de révision",
    title: "Transformer ses cours en podcast de révision · Studoo",
    h1: ["Transforme tes cours en ", "podcast", " de révision"],
    description: "Studoo transforme tes cours en podcast de 10, 20 ou 30 minutes : deux voix (Vivienne et Henri) t'expliquent ton chapitre comme une émission de radio. À écouter dans le bus ou au sport.",
    intro: "Le serveur de Studoo écrit un dialogue à deux voix uniquement à partir des cours choisis, puis le fait lire par des voix de synthèse (Vivienne et Henri) au rythme d'une émission de radio. Tu peux fermer la page : le podcast arrive dans ton Drive et Studoo te prévient.",
    steps: ["Ouvre « Faire un podcast » et coche tes cours.", "Choisis la durée : 10, 20 ou 30 minutes.", "Ferme la page si tu veux : le MP3 arrive dans ton Drive."],
    limits: ["Les voix sont des voix de synthèse générées par une IA, pas des voix humaines.", "Nombre de générations par jour limité (voir la page Données personnelles)."],
    faq: [["Combien de temps faut-il attendre ?", "Le temps estimé s'affiche au lancement ; en général quelques minutes."], ["Le podcast invente-t-il des choses ?", "Le script n'utilise que tes cours ; relis tout de même ton cours en cas de doute."]],
  },
  {
    slug: "video-de-revision", color: "orange", short: "Vidéo explicative",
    title: "Créer une vidéo explicative de révision à partir de ses cours · Studoo",
    h1: ["Une ", "vidéo explicative", " de ton chapitre"],
    description: "Studoo crée une vidéo de révision animée et commentée à partir de tes cours : format TikTok (2 min), YouTube (10 min) ou long (30 min), exportable en MP4.",
    intro: "Studoo prépare un diaporama dessiné à la main, commenté par une voix de synthèse (Vivienne), avec sous-titres. La vidéo est animée directement dans ton navigateur et peut être exportée en MP4.",
    steps: ["Ouvre « Faire une vidéo » et coche tes cours.", "Choisis le format : court, moyen ou long.", "Regarde la vidéo dans Studoo ou exporte-la en MP4."],
    limits: ["L'export MP4 est plus lent sur téléphone que sur ordinateur.", "Voix de synthèse générée par une IA."],
    faq: [["Puis-je la partager ?", "Les cours sont des œuvres protégées : les contenus créés sont réservés à ton usage personnel."]],
  },
  {
    slug: "exercices-et-correction", color: "pink", short: "Exercices et correction de copie",
    title: "Feuille d'exercices et correction de copie en photo · Studoo",
    h1: ["Des ", "exercices", " tirés de tes cours, et ta copie corrigée"],
    description: "Studoo crée des feuilles d'exercices (TD, TP, contrôle blanc, QCM) à partir de tes cours, puis corrige ta copie en photo : note sur 20, erreurs et notions à revoir.",
    intro: "Choisis un type de feuille (entraînement, mise en pratique, contrôle blanc, questions flash) et une difficulté. Le corrigé reste caché. Quand tu as fini, prends ta copie en photo : Studoo la lit et la corrige avec tolérance (points partiels, orthographe), puis te dit quoi revoir.",
    steps: ["Ouvre « Feuille d'exercices », coche tes cours, choisis le type et la difficulté.", "Fais les exercices sur papier.", "Prends ta copie en photo depuis la feuille : la correction arrive dans ton Drive."],
    limits: ["Une copie mal lue ou une note inexacte reste possible : vérifie avec ton professeur.", "Évite d'écrire ton nom complet sur la copie photographiée."],
    faq: [["La note est-elle fiable ?", "Elle donne une indication ; la correction explique chaque point pour que tu puisses vérifier."]],
  },
  {
    slug: "emploi-du-temps", color: "lilac", short: "Emploi du temps",
    title: "Récupérer son emploi du temps Pronote, ADE ou Celcat · Studoo",
    h1: ["Ton ", "emploi du temps", " récupéré tout seul"],
    description: "Studoo récupère ton emploi du temps Pronote (lycée), ADE ou Celcat (université) avec un robot qui oublie ton mot de passe, et l'affiche aux vraies heures, semaine ou jour.",
    intro: "Choisis ton lycée ou ton université : le robot de Studoo trouve le bon logiciel (Pronote et ENT régionaux, ADE, Celcat), se connecte une seule fois avec tes identifiants, récupère ton emploi du temps puis les oublie. HyperPlanning et Aurion ont des robots expérimentaux ; sinon, un lien ou un fichier .ics suffit.",
    steps: ["Ouvre « Emploi du temps » et choisis ton établissement.", "Connecte-toi une fois : le robot récupère tes cours.", "Ton emploi du temps se met à jour tout seul quand ton établissement le permet."],
    limits: ["Connecteurs non officiels : ils peuvent cesser de marcher après une mise à jour du logiciel.", "La double authentification n'est pas prise en charge par les robots : utilise alors le lien .ics.",
      "Robots HyperPlanning, Aurion et ADE à identifiants propres : expérimentaux, jamais testés sur un vrai compte."],
    faq: [["Mon mot de passe est-il enregistré ?", "Non. Il ne sert qu'à la connexion, dans la mémoire du serveur, puis il est supprimé dans tous les cas, sans jamais être écrit dans un journal."],
      ["Mon établissement n'est pas reconnu ?", "Utilise le dernier recours (.ics) et signale-nous ton établissement en un clic : les plus demandés sont pris en charge en premier."]],
  },
];

export const FAQ = [
  ["Studoo est-il gratuit ?", "Oui, entièrement : pas d'abonnement, pas de publicité, pas de revente de données. Des limites quotidiennes par élève protègent le service (détail dans la page Données personnelles)."],
  ["Où sont stockés mes cours ?", "Dans ton propre Google Drive, dossier « Studoo ». Studoo ne voit que les fichiers qu'il a créés, jamais le reste de ton Drive."],
  ["Quelle IA utilise Studoo ?", "Les outils de Studoo sur Microsoft Azure (Azure AI Speech pour la transcription et les voix, Azure OpenAI GPT-4.1 mini pour l'écriture) et un modèle open source sur son propre serveur pour lire les photos. Google Gemini n'est utilisé que si tu choisis d'ajouter ta propre clé."],
  ["Faut-il créer un compte ?", "Non : on se connecte avec son compte Google, qui sert aussi au stockage dans le Drive."],
  ["Pour qui est Studoo ?", "Pour les lycéens et les étudiants qui veulent réviser à partir de leurs propres cours."],
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
export const PUBLISHER = { "@type": "Organization", name: "BastosDev", url: SITE, logo: `${SITE}/icon-512.png` };

function head({ title, description, path, extra = "" }) {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${SITE}${path}">
  <meta name="theme-color" content="#FBF6E9">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Studoo">
  <meta property="og:locale" content="fr_FR">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${SITE}${path}">
  <meta property="og:image" content="${SITE}/og-image.png">
  <meta property="og:image:alt" content="Logo Studoo : un post-it rose avec deux yeux, sur une page de cahier">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="preload" href="/fonts/patrick-hand.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/fonts/gochi-hand.woff2" as="font" type="font/woff2" crossorigin>
  <script src="/boot.js"></script>
  <script type="module" src="/src/static.js"></script>
  ${extra}
</head>`;
}

const FOOTER = `  <footer class="site-footer">
    <nav aria-label="Liens légaux">
      <a href="/rgpd">Données personnelles (RGPD)</a>
      <a href="/cgu">Conditions d'utilisation</a>
      <a href="/contact">Contact</a>
    </nav>
    <p class="small muted">Studoo · BastosDev · <a href="https://github.com/B2TN/studoo">code sur GitHub</a></p>
  </footer>`;

export function toolPage(t) {
  const path = `/outils/${t.slug}`;
  const crumbs = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Studoo", item: `${SITE}/` },
    { "@type": "ListItem", position: 2, name: "Outils", item: `${SITE}/#outils` },
    { "@type": "ListItem", position: 3, name: t.short, item: `${SITE}${path}` }] };
  const faq = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: t.faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) };
  const page = { "@context": "https://schema.org", "@type": "WebPage", name: t.title, description: t.description, url: `${SITE}${path}`,
    inLanguage: "fr", dateModified: UPDATED, isPartOf: { "@type": "WebSite", name: "Studoo", url: `${SITE}/` }, publisher: PUBLISHER };
  const others = TOOLS.filter((x) => x.slug !== t.slug);
  return `${head({ title: t.title, description: t.description, path, extra: [ld(page), ld(crumbs), ld(faq)].join("\n  ") })}
<body data-page="outil">
  <a class="skip-link" href="#contenu">Aller au contenu</a>
  <header class="l-top">
    <a class="logo" href="/" aria-label="Studoo, accueil"><img src="/favicon.svg" alt="" width="46" height="46"><span>Studoo</span></a>
    <span class="spacer"></span>
    <div class="theme-slot"></div>
  </header>
  <main id="contenu" class="page">
    <nav class="crumbs small" aria-label="Fil d'Ariane"><a href="/">Studoo</a> › <a href="/#outils">Outils</a> › <span aria-current="page">${esc(t.short)}</span></nav>
    <h1>${esc(t.h1[0])}<span class="hl">${esc(t.h1[1])}</span>${esc(t.h1[2])}</h1>
    <p class="lead">${esc(t.intro)}</p>
    <p><a class="btn primary" href="/">Essayer gratuitement avec Google</a></p>
    <h2>Comment ça marche</h2>
    <ol class="steps-list">${t.steps.map((s) => `\n      <li>${esc(s)}</li>`).join("")}
    </ol>
    <h2>Bon à savoir</h2>
    <ul>${t.limits.map((s) => `\n      <li>${esc(s)}</li>`).join("")}
      <li>Tout est rangé dans <strong>ton</strong> Google Drive ; Studoo est gratuit, sans publicité. <a href="/rgpd">Tes données</a> · <a href="/rgpd#limites">Limites d'utilisation</a>.</li>
    </ul>
    <h2>Questions fréquentes</h2>${t.faq.map(([q, a]) => `\n    <h3>${esc(q)}</h3>\n    <p>${esc(a)}</p>`).join("")}
    <h2>Les autres outils de Studoo</h2>
    <ul class="tool-links">${others.map((x) => `\n      <li><a href="/outils/${x.slug}">${esc(x.short)}</a></li>`).join("")}
    </ul>
  </main>
${FOOTER}
</body>
</html>
`;
}

export function sitemap() {
  const urls = [["/", "weekly", "1.0"], ...TOOLS.map((t) => [`/outils/${t.slug}`, "monthly", "0.8"]),
    ["/rgpd", "monthly", "0.3"], ["/cgu", "yearly", "0.3"], ["/contact", "yearly", "0.4"]];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([p, f, pr]) => `  <url><loc>${SITE}${p}</loc><lastmod>${UPDATED}</lastmod><changefreq>${f}</changefreq><priority>${pr}</priority></url>`).join("\n")}
</urlset>
`;
}

export function llms() {
  return `# Studoo

> Studoo est un site gratuit d'aide à la révision pour lycéens et étudiants francophones : il transcrit les cours enregistrés au micro, numérise les feuilles, range tout dans le Google Drive de l'élève, et crée des fiches de révision, des podcasts, des vidéos et des feuilles d'exercices UNIQUEMENT à partir des propres cours de l'élève.

- Adresse : ${SITE}/
- Prix : gratuit, sans abonnement ni publicité ; limites quotidiennes par élève (détail à jour : ${SITE}/rgpd#limites).
- Connexion : compte Google (le stockage se fait dans le Google Drive de l'élève, autorisation « drive.file » : Studoo ne voit que ses propres fichiers).
- IA : Microsoft Azure (Azure AI Speech pour la transcription et les voix, Azure OpenAI GPT-4.1 mini pour l'écriture) et un modèle open source (Qwen3-VL) sur le serveur de Studoo pour lire les photos. Google Gemini seulement avec la clé personnelle d'un élève qui le choisit.
- Langue : français.
- Éditeur : BastosDev (projet étudiant, code source public : https://github.com/B2TN/studoo).

## Outils
${TOOLS.map((t) => `- [${t.short}](${SITE}/outils/${t.slug}) : ${t.description}`).join("\n")}

## Limites honnêtes
- Les contenus générés par une IA peuvent contenir des erreurs : à vérifier avec le cours et le professeur.
- Enregistrer un cours exige l'accord du professeur et des personnes enregistrées.
- Les connecteurs d'emploi du temps (Pronote, ENT, ADE, Celcat) sont non officiels ; HyperPlanning et Aurion sont expérimentaux.

## Questions fréquentes
${FAQ.map(([q, a]) => `- **${q}** ${a}`).join("\n")}

## Pages utiles
- [Données personnelles (RGPD)](${SITE}/rgpd)
- [Conditions d'utilisation](${SITE}/cgu)
- [Contact](${SITE}/contact)
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL("../", import.meta.url);
  mkdirSync(new URL("outils/", root), { recursive: true });
  for (const t of TOOLS) writeFileSync(new URL(`outils/${t.slug}.html`, root), toolPage(t), "utf8");
  writeFileSync(new URL("public/sitemap.xml", root), sitemap(), "utf8");
  writeFileSync(new URL("public/llms.txt", root), llms(), "utf8");
  console.log(`${TOOLS.length} pages outils, sitemap.xml et llms.txt à jour`);
}
