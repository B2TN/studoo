# Mettre en ligne le serveur de tâches (Azure for Students — gratuit, sans carte)

Le serveur de tâches fabrique les podcasts, vidéos et lectures de copies avec des outils open source
(Qwen3-4B pour écrire, Kokoro/Piper pour les voix, ffmpeg pour le montage, Qwen3-VL pour lire).

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
- Région **France Central** (Paris).

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

## 5. Lancer le script de mise en place
À la racine du projet :

```powershell
powershell -ExecutionPolicy Bypass -File worker\azure\deploy.ps1
```

Il crée tout (file, environnement, job) et transforme les lignes de `.env.worker` en secrets Azure, sans les afficher.
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
- Chaque exécution télécharge les modèles (≈ 3 Go, 1 à 2 min) : il n'y a pas de stockage permanent,
  pour ne pas consommer le crédit.

## Temps et crédit
Mesuré sur PC avec 2 cœurs le 24/11/2026 : vidéo courte (≈ 1 min 45) **4 min**, podcast 10 min **18 min**.
La machine Azure a 4 vCPU : un peu plus rapide (pas encore mesuré sur Azure), plus 1 à 2 min de téléchargement.

Crédit (pages Azure du 24/11/2026) :
- **gratuit chaque mois, pour toujours** : 180 000 vCPU-secondes et 360 000 Go-secondes → ≈ **12 h** de la machine 4 vCPU / 8 Go ;
- au-delà : sur les 100 $ annuels — environ 0,43 $ par heure de machine (prix à confirmer sur la page tarifaire),
  soit ≈ **19 h de plus par mois** si le crédit est réparti sur l'année.
- Total ≈ **30 h de calcul par mois**, soit de l'ordre de 100 podcasts de 10 min.
- La file de réveil coûte moins d'un centime par mois.

## En cas de problème
- **« RequestDisallowedByPolicy » / région refusée** : ton abonnement étudiant limite les régions →
  relance avec une autre région, par exemple
  `powershell -ExecutionPolicy Bypass -File worker\azure\deploy.ps1 -Location westeurope`.
- **« image pull » / image introuvable** : vérifie que l'action GitHub « Image du serveur de tâches » est verte et que le paquet est public (étape 2).
- **Rien ne démarre** : vérifie `WORKER_QUEUE_URL` dans Vercel puis *Redeploy* ; regarde l'historique d'exécution du job.
- **Le crédit baisse trop vite** : portail Azure → *Abonnements* → *Coûts* ; on peut réduire la machine
  (dans le script : `cpu = 2.0; memory = "4Gi"`, et passer `OCR_MODEL=lightonai/LightOnOCR-3-1B` dans `.env.worker`).
