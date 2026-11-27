# Services utilisés par Studoo

> Fichier généré par `frontend/scripts/services-doc.mjs` à partir de `frontend/src/lib/services.js`
> (la même liste que la section « Services » de la page admin). Ne pas modifier à la main.
> Aucune clé ni aucun secret ici : seulement à quoi sert chaque service et où trouver sa configuration.

## Comment tout le site fonctionne

1. **Navigateur de l'élève** — Pages et application (HTML/CSS/JS) servies par Vercel. Les cours ne passent jamais par nos serveurs pour être stockés.
2. **Connexion Google** — Google vérifie l'identité ; l'API garde la session dans un cookie chiffré (30 jours) et vérifie le compte à chaque requête.
3. **API Studoo (Vercel, Paris)** — Petites tâches en direct : transcription (Azure Speech), rangement, fiches, PDF (Azure OpenAI), robots d'emploi du temps.
4. **Base Neon** — Comptes, compteurs, tâches en attente (chiffrées), signalements, bannissements (empreintes).
5. **Serveur de tâches (Azure)** — Réveillé par la file Azure : écrit les scripts (Azure OpenAI), fait lire les voix (Azure Speech), lit les photos (Qwen3-VL), puis s'arrête.
6. **Google Drive de l'élève** — Destination finale de tout : transcriptions, PDF, fiches, podcasts, vidéos, exercices, dans le dossier « Studoo ».

## Inventaire

| Service | Rôle | Offre gratuite et limites |
|---|---|---|
| [Vercel](https://vercel.com/mailbastos-6808/studoo) | Hébergement du site et de l'API (région Paris) | Offre Hobby gratuite (usage non commercial) : 100 Go de bande passante/mois, fonctions jusqu'à 300 s, journaux gardés 1 h. |
| [Neon (Postgres)](https://console.neon.tech/app/projects) | Base de données : comptes, compteurs, tâches en cours, signalements, bannissements | Offre gratuite : 0,5 Go de stockage, mise en veille après 5 min d'inactivité (réveil en ~1 s), région Europe (Francfort). |
| [Google Cloud (connexion Google + API Drive)](https://console.cloud.google.com/auth/overview) | Se connecter avec Google ; ranger les cours dans le Drive de l'élève | Gratuit. Portées demandées : openid, email, profile et drive.file (non sensible : Studoo ne voit que ses propres fichiers). Quota Drive : 12 000 requêtes/min par projet. |
| [Microsoft Azure (crédit Azure for Students)](https://portal.azure.com/#browse/resourcegroups) | IA du site : transcription, voix, écriture ; serveur de tâches | Crédit Azure for Students : 100 $ par an, sans carte bancaire. Groupe de ressources « studoo », région Italy North. |
| [Azure AI Speech (studoo-voix)](https://portal.azure.com/#browse/Microsoft.CognitiveServices%2Faccounts) | Transcription des cours enregistrés ; voix des podcasts et vidéos | Offre F0 gratuite : 5 h de transcription et 500 000 caractères de voix par mois (≈ 55 podcasts de 10 min). |
| [Azure OpenAI (studoo-ecriture, GPT-4.1 mini)](https://ai.azure.com/) | Rangement automatique, fiches, lecture des PDF, scripts, exercices, corrections | Payé sur le crédit étudiant (≈ 0,40 $ / million de jetons lus, 1,60 $ / million écrits ; ≈ 1 centime par podcast). Quota : 100 000 jetons/min. Limites quotidiennes de Studoo pour protéger le crédit. |
| [Serveur de tâches (Azure Container Apps + file Azure Storage)](https://portal.azure.com/#browse/Microsoft.App%2Fjobs) | Fabrique podcasts, vidéos, exercices, corrections et lectures de photos pendant que l'élève est absent | Container Apps : 180 000 vCPU-s et 360 000 Go-s gratuits par mois (≈ 12 h de la machine 4 vCPU / 8 Go), puis sur le crédit. File Storage : quelques centimes par an. |
| [GitHub](https://github.com/B2TN/studoo) | Code (portfolio public), tests automatiques, image du serveur de tâches | Gratuit pour un dépôt public : Actions illimitées, Packages (ghcr.io) gratuits pour le public. |
| [Sentry](https://sentry.io/) | Suivi des erreurs du site, de l'API et du serveur de tâches | Offre Developer gratuite : 5 000 erreurs/mois, 1 utilisateur, historique de 30 jours. |
| [Google Search Console et Bing Webmaster Tools](https://search.google.com/search-console) | Référencement : indexation, sitemap, erreurs d'exploration | Gratuits. |
| [Notifications web (VAPID)](https://developer.mozilla.org/fr/docs/Web/API/Push_API) | Prévenir l'élève quand une génération est prête | Gratuit (services de notification des navigateurs : Google, Mozilla, Apple). |
| [Brevo (e-mail de secours) — non activé](https://app.brevo.com/) | E-mail « c'est prêt » si les notifications sont refusées | Offre gratuite : 300 e-mails/jour. Aujourd'hui NON configuré : aucun e-mail n'est envoyé. |
| [Annuaires publics (data.gouv)](https://data.education.gouv.fr/explore/dataset/fr-en-annuaire-education/) | Trouver son lycée ou son université | Gratuits, sans clé (licence ouverte). |
| [Hugging Face (modèles open source)](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct) | Téléchargement des modèles Qwen3-VL (lecture des photos) et Qwen3-4B (secours) | Gratuit, sans compte (licence Apache 2.0 des modèles). |
| [Google Gemini (clés personnelles des élèves)](https://aistudio.google.com/apikey) | Option : un élève peut utiliser SA clé pour certaines fonctionnalités | Gratuit pour l'élève (quota de son compte Google). Aucune clé du site. |

## Vercel

- **Rôle :** Hébergement du site et de l'API (région Paris)
- **Fonctionnement :** Chaque envoi sur la branche main de GitHub déclenche un déploiement : Vercel construit le site (Vite) et lance l'API Python (FastAPI) comme fonction. Le navigateur charge les pages depuis Vercel et appelle /api/… sur le même domaine.
- **Offre gratuite :** Offre Hobby gratuite (usage non commercial) : 100 Go de bande passante/mois, fonctions jusqu'à 300 s, journaux gardés 1 h.
- **Configuration (sans secrets) :** Variables : Vercel → Settings → Environment Variables (APP_URL, SESSION_SECRET, GOOGLE_CLIENT_ID/SECRET, DATABASE_URL, SPEECH_KEY/REGION, AZURE_OPENAI_KEY/URL, JOB_SECRET, WORKER_QUEUE_URL, VAPID_PUBLIC_KEY, ADMIN_EMAILS, SENTRY_DSN). Fichier vercel.json (redirections, en-têtes de sécurité, cache).
- **Où trouver quoi :** [Journaux (erreurs de l'API)](https://vercel.com/mailbastos-6808/studoo/logs) · [Déploiements (revenir en arrière)](https://vercel.com/mailbastos-6808/studoo/deployments) · [Variables d'environnement](https://vercel.com/mailbastos-6808/studoo/settings/environment-variables) · [Consommation](https://vercel.com/mailbastos-6808/~/usage)
- **En cas de panne :** Site inaccessible : regarde vercel-status.com. Mauvais déploiement : Deployments → l'avant-dernier → « Promote to Production » (retour arrière en 1 clic).

## Neon (Postgres)

- **Rôle :** Base de données : comptes, compteurs, tâches en cours, signalements, bannissements
- **Fonctionnement :** L'API et le serveur de tâches y lisent et écrivent les données de service. Les cours ne sont jamais dans la base : ils sont dans le Drive de chaque élève.
- **Offre gratuite :** Offre gratuite : 0,5 Go de stockage, mise en veille après 5 min d'inactivité (réveil en ~1 s), région Europe (Francfort).
- **Configuration (sans secrets) :** DATABASE_URL (Vercel et serveur de tâches). Les tables se créent toutes seules au premier lancement (backend/studoo/db.py).
- **Où trouver quoi :** [Console (tables, requêtes SQL)](https://console.neon.tech/app/projects) · [Consommation et limites](https://console.neon.tech/app/billing)
- **En cas de panne :** Erreurs 500 partout : vérifie la console Neon (projet en pause ? quota dépassé ?) et la variable DATABASE_URL.

## Google Cloud (connexion Google + API Drive)

- **Rôle :** Se connecter avec Google ; ranger les cours dans le Drive de l'élève
- **Fonctionnement :** Le bouton « Se connecter avec Google » ouvre la fenêtre de Google ; l'API échange le code contre des jetons (le secret reste côté serveur). Le navigateur parle ensuite directement à Google Drive avec un jeton court.
- **Offre gratuite :** Gratuit. Portées demandées : openid, email, profile et drive.file (non sensible : Studoo ne voit que ses propres fichiers). Quota Drive : 12 000 requêtes/min par projet.
- **Configuration (sans secrets) :** GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET (Vercel). Console : Google Auth Platform → Clients (origines autorisées), Branding (nom, logo, liens), Audience (production), Data access (portées).
- **Où trouver quoi :** [Écran de consentement / Branding](https://console.cloud.google.com/auth/branding) · [Identifiants OAuth](https://console.cloud.google.com/auth/clients) · [Quotas de l'API Drive](https://console.cloud.google.com/apis/api/drive.googleapis.com/quotas)
- **En cas de panne :** « Accès bloqué » à la connexion : vérifie l'audience (production) et les origines autorisées. Drive en erreur : google.com/appsstatus.

## Microsoft Azure (crédit Azure for Students)

- **Rôle :** IA du site : transcription, voix, écriture ; serveur de tâches
- **Fonctionnement :** Voir les quatre services ci-dessous. Tout est dans le même abonnement étudiant.
- **Offre gratuite :** Crédit Azure for Students : 100 $ par an, sans carte bancaire. Groupe de ressources « studoo », région Italy North.
- **Configuration (sans secrets) :** Ressources : studoo-voix (Speech), studoo-ecriture-… (OpenAI), studoo-worker (Container Apps job), studoob… (Storage, file « studoo-jobs »). Clés : portail Azure → ressource → Clés et point de terminaison ; serveur de tâches : worker/azure/deploy.ps1 et .env.worker (jamais dans Git).
- **Où trouver quoi :** [Crédit restant](https://www.microsoftazuresponsorships.com/Balance) · [Coûts par service](https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/costanalysis)
- **En cas de panne :** Si le crédit est épuisé, tout ce qui est Azure s'arrête : la transcription, l'IA et le serveur de tâches renvoient des erreurs claires ; le reste du site marche.

## Azure AI Speech (studoo-voix)

- **Rôle :** Transcription des cours enregistrés ; voix des podcasts et vidéos
- **Fonctionnement :** L'API envoie chaque morceau de 5 min d'audio, reçoit le texte avec les voix séparées, puis oublie l'audio. Le serveur de tâches y fait lire les scripts par Vivienne et Henri.
- **Offre gratuite :** Offre F0 gratuite : 5 h de transcription et 500 000 caractères de voix par mois (≈ 55 podcasts de 10 min).
- **Configuration (sans secrets) :** SPEECH_KEY et SPEECH_REGION (Vercel pour la transcription, .env.worker pour les voix).
- **Où trouver quoi :** [Ressource (clés, métriques, quotas)](https://portal.azure.com/#browse/Microsoft.CognitiveServices%2Faccounts)
- **En cas de panne :** « Transcription pas encore configurée » : clé absente sur Vercel. Erreur 429 : quota F0 du mois atteint ou trop de demandes à la fois.

## Azure OpenAI (studoo-ecriture, GPT-4.1 mini)

- **Rôle :** Rangement automatique, fiches, lecture des PDF, scripts, exercices, corrections
- **Fonctionnement :** L'API (rangement, fiches, PDF) et le serveur de tâches (podcasts, vidéos, exercices, corrections) envoient le texte des cours ; la réponse JSON est rangée dans le Drive de l'élève.
- **Offre gratuite :** Payé sur le crédit étudiant (≈ 0,40 $ / million de jetons lus, 1,60 $ / million écrits ; ≈ 1 centime par podcast). Quota : 100 000 jetons/min. Limites quotidiennes de Studoo pour protéger le crédit.
- **Configuration (sans secrets) :** AZURE_OPENAI_KEY et AZURE_OPENAI_URL (Vercel et .env.worker), déploiement « gpt-4.1-mini » (GlobalStandard).
- **Où trouver quoi :** [Azure AI Foundry (déploiements, quotas, métriques)](https://ai.azure.com/) · [Ressources OpenAI du portail](https://portal.azure.com/#browse/Microsoft.CognitiveServices%2Faccounts)
- **En cas de panne :** « L'IA de Studoo n'est pas encore configurée » : variables absentes. 429 : quota par minute ; 401 : clé régénérée sans mise à jour des variables.

## Serveur de tâches (Azure Container Apps + file Azure Storage)

- **Rôle :** Fabrique podcasts, vidéos, exercices, corrections et lectures de photos pendant que l'élève est absent
- **Fonctionnement :** L'API dépose une tâche chiffrée dans la base et un message de réveil dans la file ; Azure démarre le conteneur, qui traite la tâche, écrit le résultat dans le Drive de l'élève, le prévient, puis s'arrête.
- **Offre gratuite :** Container Apps : 180 000 vCPU-s et 360 000 Go-s gratuits par mois (≈ 12 h de la machine 4 vCPU / 8 Go), puis sur le crédit. File Storage : quelques centimes par an.
- **Configuration (sans secrets) :** Déploiement : worker/azure/deploy.ps1 (lancé par toi) ; image publiée par GitHub Actions sur ghcr.io/b2tn/studoo-worker ; secrets dans .env.worker (jamais dans Git) ; WORKER_QUEUE_URL sur Vercel.
- **Où trouver quoi :** [Job studoo-worker (exécutions, journaux)](https://portal.azure.com/#browse/Microsoft.App%2Fjobs) · [File de réveil (Storage)](https://portal.azure.com/#browse/Microsoft.Storage%2FStorageAccounts) · [Image du conteneur (GitHub Packages)](https://github.com/B2TN?tab=packages)
- **En cas de panne :** Générations bloquées « en file d'attente » : regarde les exécutions du job (erreur de démarrage ? crédit ?) ; relance avec deploy.ps1 si l'image a changé.

## GitHub

- **Rôle :** Code (portfolio public), tests automatiques, image du serveur de tâches
- **Fonctionnement :** Chaque envoi lance les tests ; Vercel déploie la branche main ; le serveur de tâches utilise l'image construite par Actions.
- **Offre gratuite :** Gratuit pour un dépôt public : Actions illimitées, Packages (ghcr.io) gratuits pour le public.
- **Configuration (sans secrets) :** .github/workflows/tests.yml (tests à chaque envoi), worker-image.yml (image du serveur de tâches). Aucun secret dans le dépôt.
- **Où trouver quoi :** [Tests (Actions)](https://github.com/B2TN/studoo/actions) · [Alertes de sécurité](https://github.com/B2TN/studoo/security) · [Réglages du dépôt](https://github.com/B2TN/studoo/settings)
- **En cas de panne :** Tests rouges : ouvre le dernier run dans Actions pour voir le test qui échoue.

## Sentry

- **Rôle :** Suivi des erreurs du site, de l'API et du serveur de tâches
- **Fonctionnement :** Quand un bug inattendu se produit, une fiche technique (type d'erreur, fichier, ligne, page sans identifiants) part chez Sentry ; jamais de contenu de cours, de mot de passe, d'identité ni d'adresse IP.
- **Offre gratuite :** Offre Developer gratuite : 5 000 erreurs/mois, 1 utilisateur, historique de 30 jours.
- **Configuration (sans secrets) :** SENTRY_DSN (Vercel ; .env.worker pour le serveur de tâches). Vide = désactivé. Réglage du projet : « Prevent Storing of IP Addresses » activé.
- **Où trouver quoi :** [Erreurs (Issues)](https://sentry.io/issues/) · [Quotas et facturation](https://sentry.io/settings/billing/)
- **En cas de panne :** Sentry en panne : aucun effet sur le site (l'envoi des erreurs est simplement perdu).

## Google Search Console et Bing Webmaster Tools

- **Rôle :** Référencement : indexation, sitemap, erreurs d'exploration
- **Fonctionnement :** Ils indiquent quelles pages sont indexées, avec quelles recherches on arrive sur Studoo, et signalent les erreurs.
- **Offre gratuite :** Gratuits.
- **Configuration (sans secrets) :** Vérification par balise <meta> dans les pages (google-site-verification, msvalidate.01) ; sitemap : /sitemap.xml.
- **Où trouver quoi :** [Google Search Console](https://search.google.com/search-console) · [Bing Webmaster Tools](https://www.bing.com/webmasters)
- **En cas de panne :** Pages non indexées : Search Console → Inspection de l'URL → Demander l'indexation.

## Notifications web (VAPID)

- **Rôle :** Prévenir l'élève quand une génération est prête
- **Fonctionnement :** Avec l'accord de l'élève, son navigateur donne une adresse d'abonnement ; le serveur de tâches y envoie « c'est prêt ».
- **Offre gratuite :** Gratuit (services de notification des navigateurs : Google, Mozilla, Apple).
- **Configuration (sans secrets) :** VAPID_PUBLIC_KEY (Vercel) ; VAPID_PRIVATE_KEY et VAPID_SUBJECT (.env.worker).
- **Où trouver quoi :** [Aucun tableau de bord](https://developer.mozilla.org/fr/docs/Web/API/Push_API)
- **En cas de panne :** Plus de notifications : vérifie que les clés VAPID n'ont pas changé (sinon chaque élève doit réactiver).

## Brevo (e-mail de secours) — non activé

- **Rôle :** E-mail « c'est prêt » si les notifications sont refusées
- **Fonctionnement :** Le serveur de tâches envoie l'e-mail par l'API de Brevo quand l'élève n'a pas de notification active.
- **Offre gratuite :** Offre gratuite : 300 e-mails/jour. Aujourd'hui NON configuré : aucun e-mail n'est envoyé.
- **Configuration (sans secrets) :** Pour l'activer : BREVO_API_KEY et MAIL_FROM dans .env.worker, puis EMAIL_NOTIFICATIONS=1 sur Vercel (le site promet alors l'e-mail).
- **Où trouver quoi :** [Tableau de bord Brevo](https://app.brevo.com/)
- **En cas de panne :** —

## Annuaires publics (data.gouv)

- **Rôle :** Trouver son lycée ou son université
- **Fonctionnement :** Seul le nom tapé dans la recherche y est envoyé.
- **Offre gratuite :** Gratuits, sans clé (licence ouverte).
- **Configuration (sans secrets) :** Adresses dans backend/studoo/routes/timetable.py (lycées) et services/higher.py (supérieur).
- **Où trouver quoi :** [Annuaire de l'Éducation nationale](https://data.education.gouv.fr/explore/dataset/fr-en-annuaire-education/) · [Établissements du supérieur](https://data.enseignementsup-recherche.gouv.fr/explore/dataset/fr-esr-principaux-etablissements-enseignement-superieur/)
- **En cas de panne :** Recherche d'établissement vide : le service public est peut-être en maintenance ; le dernier recours (.ics) marche toujours.

## Hugging Face (modèles open source)

- **Rôle :** Téléchargement des modèles Qwen3-VL (lecture des photos) et Qwen3-4B (secours)
- **Fonctionnement :** Téléchargés une seule fois par le serveur de tâches, puis exécutés sur sa propre machine : aucune donnée n'est envoyée à Hugging Face.
- **Offre gratuite :** Gratuit, sans compte (licence Apache 2.0 des modèles).
- **Configuration (sans secrets) :** OCR_MODEL, LLM_REPO, LLM_FILE (worker/studoo_worker/settings.py) ; modèles gardés dans MODELS_DIR sur le serveur de tâches.
- **Où trouver quoi :** [Qwen3-VL-2B-Instruct](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct) · [Qwen3-4B (GGUF)](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF)
- **En cas de panne :** Premier téléchargement impossible : la lecture des photos échoue avec un message ; réessaie plus tard.

## Google Gemini (clés personnelles des élèves)

- **Rôle :** Option : un élève peut utiliser SA clé pour certaines fonctionnalités
- **Fonctionnement :** Utilisé seulement pour les fonctionnalités cochées par l'élève dans ses réglages.
- **Offre gratuite :** Gratuit pour l'élève (quota de son compte Google). Aucune clé du site.
- **Configuration (sans secrets) :** Clés chiffrées dans la table user_keys (jamais lisibles sans SESSION_SECRET).
- **Où trouver quoi :** [Google AI Studio (pour les élèves)](https://aistudio.google.com/apikey)
- **En cas de panne :** Erreur Gemini : l'élève peut repasser sur les outils de Studoo dans Réglages.
