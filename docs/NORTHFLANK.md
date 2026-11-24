# Mettre en ligne le serveur de tâches (Northflank, gratuit, sans carte)

Le serveur de tâches fabrique les podcasts, vidéos et lectures de copies avec des outils open source
(Qwen3-4B pour écrire, Kokoro/Piper pour les voix, ffmpeg pour le montage, Qwen3-VL pour lire).
Il tourne comme une **tâche planifiée** : toutes les 5 minutes, il regarde s'il y a du travail,
le fait, puis s'arrête. Tu ne paies (avec les 20 $ offerts chaque mois) que le temps de calcul réel.

## 1. Préparer les clés (une seule fois)
Le fichier **`.env.worker`** (à la racine du projet, jamais envoyé sur GitHub) contient des clés déjà générées :
`JOB_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
Complète-le avec `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (les mêmes que dans Vercel).

Dans **Vercel → studoo → Settings → Environment Variables**, ajoute :
- `JOB_SECRET` = la même valeur que dans `.env.worker` (type *Sensitive*) ;
- `VAPID_PUBLIC_KEY` = la même valeur que dans `.env.worker`.
Puis **Redeploy**.

## 2. Créer le compte et le projet
1. <https://northflank.com> → **Sign up** avec GitHub (offre **Developer Sandbox**, « No card needed »).
2. **Create project** → nom `studoo`, région **Europe** (la plus proche de la base Neon, Francfort).
3. Autorise Northflank à lire le dépôt **B2TN/studoo** (Settings → Git).

## 3. Créer la tâche planifiée (« Cron job »)
1. Dans le projet : **Create new → Job → Cron job**.
2. **Source** : dépôt `B2TN/studoo`, branche `main`, **Dockerfile** : `worker/Dockerfile`, contexte de build : `/` (racine).
3. **Schedule** : `*/5 * * * *` (toutes les 5 min) ; **Concurrency policy** : *Forbid* (jamais deux en même temps).
4. **Resources** : la plus grosse offre permise par le Sandbox, idéalement **2 vCPU / 8 Go** (le modèle de lecture
   des copies a besoin d'environ 6 Go). Si seul 4 Go est possible : ajoute la variable `OCR_MODEL=lightonai/LightOnOCR-3-1B`.
5. **Active deadline** (durée max d'une exécution) : **14 400 s** (4 h).
6. **Environment variables** : colle tout le contenu de `.env.worker` (bouton « Bulk edit »).
7. **Create** puis **Run now** pour un premier essai.

## 4. Vérifier
- Sur Studoo, lance un podcast court : il apparaît dans « Mes générations » (*En attente*), puis *En cours* au
  prochain passage (≤ 5 min), avec sa progression.
- Dans Northflank → le job → **Runs** → **Logs** : on voit « Tâche … (podcast), essai 1 » puis « terminée ».
  (Les journaux ne contiennent jamais le contenu des cours ni de jeton.)

## Temps de fabrication attendus (2 vCPU, mesurés sur PC le 24/11/2026)
| Génération | Écriture (Qwen3-4B, ≈ 4-5 jetons/s) | Voix | Montage | Total approx. |
|---|---|---|---|---|
| Vidéo courte (≈ 1 min 45) | ≈ 2,5 min | ≈ 1 min (Kokoro) | < 1 min | **≈ 4 min mesurées (prévoir 10)** |
| Podcast 10 min | ≈ 12 min | ≈ 6 min (Kokoro) / 40 s (Piper) | < 1 min | **≈ 18 min mesurées (prévoir 25)** |
| Podcast 30 min | ≈ 45 min | ≈ 21 min / 2 min | 1 min | **≈ 50-70 min** |
| Vidéo 30 min | ≈ 50 min | ≈ 21 min / 2 min | ≈ 8 min | **≈ 1 h-1 h 20** |
| Lecture d'une page (Qwen3-VL-2B) | — | — | — | **≈ 3-6 min** |

Avec 20 $ par mois de ressources (≈ 0,10 $ par heure pour 2 vCPU / 8 Go), il reste de la marge pour
**environ 150 à 200 heures de calcul** par mois.
