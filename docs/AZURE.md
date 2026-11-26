# Mettre en ligne le serveur de tâches (Azure for Students — gratuit, sans carte)

Le serveur de tâches fabrique les podcasts, vidéos, feuilles d'exercices, corrections et lectures de copies :

| Étape | Service (gratuit) | Secours 1 | Secours 2 |
|---|---|---|---|
| Écrire le script | **Azure OpenAI** (GPT-4.1 mini, payé par le crédit étudiant : ≈ 1 centime par podcast ; ou Groq si une clé `GROQ_API_KEY` est fournie) | Gemini avec la clé **de l'élève** (s'il en a mis une dans ses réglages) | Qwen3-4B sur le serveur (≈ 1 h par podcast) |
| Voix | **Azure AI Speech** : podcasts = Vivienne + Henri, vidéos = Vivienne, allure radio (−5 %, pauses, volume égalisé) ; offre F0 : 500 000 caractères/mois ≈ 55 podcasts de 10 min | Denise + Henri (Azure), signalé à l'élève | Gemini TTS (clé de l'élève) puis Kokoro/Piper, signalé |
| Vidéo | animée **dans le navigateur** (rien à monter sur le serveur), export MP4 sur l'appareil | | |
| Feuille d'exercices | Azure OpenAI (GPT-4.1 mini) | Gemini (clé de l'élève) | Qwen3-4B sur le serveur |
| Corriger une copie (photo) | Azure OpenAI (GPT-4.1 mini, lit l'écriture manuscrite) ≈ 7 s | Gemini (clé de l'élève) | Qwen3-VL lit la copie puis l'IA corrige le texte |
| Lire une copie (numérisation) | Qwen3-VL sur le serveur | | |

## Comment ça marche
```
Studoo (Vercel) ── nouvelle tâche ──► base Neon (contenu chiffré)
       │
       └── message « studoo » (aucune donnée) ──► file Azure « studoo-jobs »
                                                        │  Azure regarde la file toutes les 30 s
                                                        ▼
                                   job « studoo-worker » (4 vCPU / 8 Go) démarre,
                                   vide la file, traite TOUTES les tâches en attente,
                                   range les fichiers dans ton Google Drive, prévient, s'éteint.
```
- Rien ne tourne (et rien n'est compté) quand il n'y a pas de travail.
- L'image du serveur est construite par GitHub Actions et publiée sur **ghcr.io** (gratuit) à chaque modification
  du code du worker ; elle ne contient aucune clé.
- Si un réveil se perd, la page « Mes générations » relance le réveil d'elle-même (au plus une fois toutes les 5 min).
- Région : Azure for Students n'autorise que 5 régions par abonnement (pour nous : Norvège, Italie, Espagne,
  Danemark, Suisse ; pas la France). Le script choisit tout seul la plus proche dans l'Union européenne :
  **Italy North** (Milan).

## 1. Activer Azure for Students (à faire toi-même)
1. <https://azure.microsoft.com/free/students> → **Commencer gratuitement** → connecte-toi avec ton
   **adresse e-mail de l'école** (IUT). Aucune carte n'est demandée sur ce parcours : si une page te demande
   une carte, c'est que tu es sur l'essai gratuit classique, reviens au lien ci-dessus.
2. Tu reçois **100 $ de crédit pour 12 mois**, renouvelables chaque année tant que tu es étudiant.
   Quand le crédit est épuisé, Azure **arrête** les services : aucune facture possible.

## 2. L'image du serveur (rien à faire)
L'action GitHub **« Image du serveur de tâches »** la publie sur `ghcr.io/b2tn/studoo-worker` à chaque
modification du worker (≈ 4 min). Elle est publique, comme le dépôt (vérifié le 24/11/2026 : 0,8 Go compressé) ;
elle ne contient que le code. Si un jour Azure n'arrive pas à la télécharger : GitHub → **Packages** →
`studoo-worker` → **Package settings** → **Change visibility** → **Public**.

## 3. Installer l'outil Azure et se connecter (une seule fois)

```powershell
winget install --exact --id Microsoft.AzureCLI
```

Ferme puis rouvre le terminal, puis :

```powershell
az login
```

## 4. Compléter `.env.worker`
Ce fichier (à la racine, jamais envoyé sur GitHub) contient déjà `JOB_SECRET` et les clés `VAPID_*`.
Complète `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (les mêmes valeurs que dans Vercel).
Facultatif : `BREVO_API_KEY` et `MAIL_FROM` pour l'e-mail de secours.

Rien d'autre à copier pour les podcasts et vidéos : le script crée lui-même, sur ton abonnement étudiant,
le service de voix « studoo-voix » (Azure AI Speech, gratuit) et le service d'écriture « studoo-ecriture-… »
(Azure OpenAI, modèle GPT-4.1 mini), et récupère leurs clés.
Facultatif : une clé Groq (`GROQ_API_KEY=gsk_…`) sert d'écrivain de réserve. L'inscription Groq peut être refusée
(« signup_blocked », par exemple avec un VPN ou une adresse Proton) : ce n'est pas grave, Azure OpenAI suffit.

## 5. Lancer le script de mise en place
À la racine du projet :

```powershell
powershell -ExecutionPolicy Bypass -File worker\azure\deploy.ps1
```

Il crée tout (file, service de voix gratuit « studoo-voix », service d'écriture « studoo-ecriture-… », environnement, job) et transforme les lignes de
`.env.worker` en secrets Azure, sans les afficher.
À la fin, il affiche la valeur de **`WORKER_QUEUE_URL`** à copier dans Vercel.
On peut le relancer sans risque (par exemple après avoir changé `.env.worker`).

## 6. Brancher le site (Vercel → studoo → Settings → Environment Variables)
- `WORKER_QUEUE_URL` = la valeur affichée par le script (elle permet seulement d'**ajouter** un message vide) ;
- `JOB_SECRET` = la valeur de `JOB_SECRET` dans `.env.worker` (type *Sensitive*) ;
- `VAPID_PUBLIC_KEY` = la valeur de `VAPID_PUBLIC_KEY` dans `.env.worker`.

Puis **Redeploy**.

## 7. Vérifier
- Sur Studoo, lance un podcast de 10 min : il passe *En cours* en moins d'une minute environ
  (le temps qu'Azure voie le message et télécharge l'image).
- Portail Azure → groupe `studoo` → `studoo-worker` → **Historique d'exécution** : une exécution *En cours*,
  puis *Réussie*. Les journaux ne contiennent jamais le contenu des cours ni de jeton.
- Les modèles locaux (≈ 3 Go) ne sont téléchargés que s'ils servent (secours, lecture de copies).

## Temps et crédit
Avec Azure OpenAI + Azure AI Speech (voix mesurées le 25/11/2026) :
- voix : 30 s de dialogue en 2 à 3 s ; vidéo d'une minute (voix + calage des diapos) en 7 s ;
- export MP4 d'une vidéo d'une minute dans le navigateur : 8 s ;
- attente attendue pour un podcast de 10 min : **≈ 1 à 3 min** (dont ≈ 1 min de réveil de la machine Azure).

Avant (tout sur le processeur du serveur, 24/11/2026) : podcast 10 min en 48 à 64 min, car le modèle local
n'écrit qu'à 5 à 7 jetons/s sur 4 vCPU (≈ 2 vrais cœurs). Ce chemin ne sert plus qu'en dernier secours.

Crédit (pages Azure du 24/11/2026) :
- **gratuit chaque mois, pour toujours** : 180 000 vCPU-secondes et 360 000 Go-secondes → ≈ **12 h** de la machine 4 vCPU / 8 Go ;
- au-delà : sur les 100 $ annuels — environ 0,43 $ par heure de machine (prix à confirmer sur la page tarifaire),
  soit ≈ **19 h de plus par mois** si le crédit est réparti sur l'année.
- Une génération ne garde la machine que quelques minutes : le crédit de calcul n'est plus la limite.
  La limite devient la voix Azure gratuite : **500 000 caractères par mois ≈ 55 podcasts de 10 min**
  (au-delà : Gemini avec la clé de l'élève, sinon les voix locales).
- Écriture (Azure OpenAI, GPT-4.1 mini) : environ 0,40 $ par million de jetons lus et 1,60 $ par million écrits,
  soit ≈ 1 centime par podcast de 10 min, pris sur les 100 $ du crédit étudiant (quota : 100 000 jetons par minute).
  Mode « Global Standard » (le seul ouvert aux comptes étudiants) : les données restent stockées en Italie mais le calcul
  peut se faire dans un autre centre Microsoft ; Microsoft ne s'en sert pas pour entraîner ses modèles.
- La file de réveil coûte moins d'un centime par mois.

## En cas de problème
- **« RequestDisallowedByAzure » / région refusée** : le script lit normalement les régions autorisées tout seul.
  Pour les voir : `az policy assignment list --query "[].parameters.listOfAllowedLocations.value[]" -o tsv`,
  puis relance avec l'une d'elles, par exemple
  `powershell -ExecutionPolicy Bypass -File worker\azure\deploy.ps1 -Location spaincentral`.
- **« image pull » / image introuvable** : vérifie que l'action GitHub « Image du serveur de tâches » est verte et que le paquet est public (étape 2).
- **Rien ne démarre** : vérifie `WORKER_QUEUE_URL` dans Vercel puis *Redeploy* ; regarde l'historique d'exécution du job.
- **Le crédit baisse trop vite** : portail Azure → *Abonnements* → *Coûts* ; on peut réduire la machine
  (dans le script : `cpu = 2.0; memory = "4Gi"`, et passer `OCR_MODEL=lightonai/LightOnOCR-3-1B` dans `.env.worker`).
