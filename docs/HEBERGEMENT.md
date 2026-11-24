# Traitements lourds sur un serveur gratuit (sans carte bancaire) — étude du 24/11/2026

## 1. Offres comparées (pages officielles lues le 24/11/2026)

| Offre | Carte ? | Puissance gratuite | Durée max d'une tâche | Mise en veille | Tâches de fond ? | Verdict |
|---|---|---|---|---|---|---|
| **Modal** (serverless Python, « Starter ») | **Oui** (vérifié) | 30 $ de calcul / mois (CPU **et GPU**), 100 conteneurs | **24 h** | Aucun coût au repos (démarre à la demande) | ✅ fonctions lancées à la demande | Écarté (carte) |
| **Azure for Students** (Container Apps jobs) | **Non** (e-mail de l'école) | 100 $ / an + 180 000 vCPU-s et 360 000 Go-s gratuits chaque mois, jusqu'à 4 vCPU / 8 Go | non documentée (réglée à 6 h) | Aucun coût au repos | ✅ démarrage sur message de file | **Choisi** ✅ |
| **Northflank** (« Sandbox ») | **Oui** en pratique à l'inscription (constaté le 24/11/2026) | 20 $ de ressources / mois, 2 services + 2 jobs + 1 base | Non précisé | **Jamais** (« always on ») | ✅ service toujours allumé | Écarté (carte aussi, moins de puissance) |
| Hugging Face Spaces (CPU 2 vCPU / 16 Go) | — | Gratuit **seulement en site statique** | — | 48 h | ❌ Docker/Gradio exigent un abonnement payant depuis 2026 | Exclu |
| Hugging Face ZeroGPU | — | 5 min de GPU / jour | 60 s par appel | — | ❌ | Exclu (trop court) |
| GitHub Actions | Non | 4 vCPU / 16 Go | 6 h | — | ❌ **interdit** par les conditions (usage sans lien avec le code du dépôt) | Exclu |
| Render | Non | 0,1 vCPU / 512 Mo | — | 15 min | ❌ « background workers » payants | Exclu |
| Koyeb | — | plus d'offre gratuite de calcul | — | — | — | Exclu |
| Fly.io | **Oui** au-delà d'1 $ (7 jours) | 3 petites machines | — | optionnelle | ✅ | Exclu (carte) |
| Google Cloud Run / Oracle Always Free | **Oui** | élevée | 60 min / illimitée | — | ✅ | Exclu (carte) |
| **Vercel Hobby** (actuel) | Non | 1 vCPU / 2 Go | **300 s** | — | ❌ (cron 1×/jour) | Garde le site et l'API légère |

¹ **Décision du 24/11/2026** : Northflank et Modal demandent une carte. Après une recherche élargie (Daytona, E2B, Kaggle, Lightning AI, Oracle, Google Cloud éducation, Cloudflare, Groq…), le seul hébergement gratuit, sans carte et assez puissant est **Azure for Students** (réservé aux étudiants). Guide : [AZURE.md](AZURE.md).

## 2. Combien de temps ça prend ? (mesuré sur 1 cœur, 24/11/2026)

| Étape | Outil open source | Vitesse mesurée | 10 min de contenu | 30 min de contenu |
|---|---|---|---|---|
| Voix naturelle | **Kokoro** 82M (voix française `ff_siwis`) | 1,45 × temps réel | ≈ 7 min | ≈ 21 min |
| Voix plus simple | **Piper** (voix `fr_FR-siwis`) | 17 × temps réel | ≈ 35 s | ≈ 2 min |
| Vidéo diaporama 720p | Pillow + **ffmpeg** (H.264) | 3,8 × temps réel | ≈ 2,5 min | ≈ 8 min |
| Texte (script, fiche, exercices) | LLM open source (Qwen 7-8B) | *estimé* : 3-6 mots/s sur CPU, 40-80 sur GPU | CPU ≈ 8 min · GPU < 1 min | CPU ≈ 25 min · GPU ≈ 2 min |
| Transcription 1 h de cours | **faster-whisper** + diarisation | *estimé* : CPU ≈ 1-2 h · GPU ≈ 3-5 min | | |

*(un cœur de serveur gratuit est souvent 1,5 à 2 fois plus lent que ce PC : multiplier en conséquence)*

**Lecture :** sur CPU seul (plan B), une vidéo de 30 min = script (≈ 25 min) + voix (≈ 20-40 min) + rendu (≈ 10-15 min)
≈ **1 h de calcul**. Avec Modal (GPU pour le texte et la transcription, CPU pour le reste) : **≈ 20-30 min**.
Comme tu ne veux pas de limite, la vraie contrainte devient **le budget mensuel** :

| Avec Modal (30 $/mois) | Coût estimé | ≈ par mois |
|---|---|---|
| Fiche / exercices (GPU ~1 min) | ≈ 0,01-0,02 $ | > 1 500 |
| Podcast 30 min (GPU 2 min + CPU 25 min) | ≈ 0,05 $ | ≈ 600 |
| Vidéo 30 min | ≈ 0,08 $ | ≈ 350 |
| Transcription d'1 h de cours (GPU) | ≈ 0,05 $ | ≈ 600 |

Quand le crédit du mois est épuisé, les tâches **attendent le mois suivant** (aucun débit possible sans carte).
Protection anti-spam : au-delà de N tâches en attente par élève, les nouvelles sont refusées (pas de limite de durée).

## 3. Architecture recommandée

> **Mise à jour du 24/11/2026** : l'architecture retenue est celle de [AZURE.md](AZURE.md) (Azure Container Apps, processeur seulement, réveil par file). Les mentions de Modal ci-dessous datent de l'étude.

```
Navigateur (PWA) ──► Vercel : site + API légère (connexion, files d'attente, emplois du temps)
                         │  1. crée la tâche dans Neon (Postgres gratuit, déjà en place)
                         │  2. lance la fonction Modal (appel HTTPS signé)
                         ▼
                    Modal : worker Python (CPU / GPU selon l'étape, jusqu'à 24 h)
                         │  - lit les cours dans le Drive de l'élève (jeton hors ligne chiffré)
                         │  - génère (LLM, voix, vidéo, transcription, OCR)
                         │  - écrit le résultat dans le Drive, met à jour la progression dans Neon
                         │  - supprime tous ses fichiers temporaires (disque éphémère)
                         ▼
                    Notification : Web Push (PWA) → sinon e-mail → toujours une pastille dans le site
```

- **File d'attente** : table `jobs` dans Neon (statut en attente / en cours / terminé / échec, progression %, nombre d'essais).
  Reprise automatique : 3 essais, puis « échec » avec bouton « Relancer ».
- **Audio des cours** : envoyé par morceaux directement au worker, transcrit, **supprimé dès la transcription
  du morceau** (mémoire + disque temporaire effacés), jamais écrit dans le Drive ni dans la base.

## 4. Accès au Drive quand l'élève n'est plus connecté

- **Autorisation** : la même qu'aujourd'hui (`drive.file` : Studoo ne voit que ses propres fichiers).
  Le « refresh token » (jeton hors ligne) existe déjà, mais il n'est gardé que dans **le cookie chiffré du navigateur**.
- **Ce qui change** : pour travailler en ton absence, le serveur doit garder ce jeton **pendant la tâche** :
  - il est copié, **chiffré** (clé connue des seuls serveurs), dans la ligne de la tâche ;
  - il est **effacé dès que la tâche se termine** (réussite ou échec définitif) : rien n'est gardé entre deux tâches ;
  - jamais écrit dans les journaux.
- **RGPD** : nouvelle ligne dans la page Données personnelles (« jeton d'accès temporaire, chiffré, supprimé à la fin
  de la génération »), base légale = exécution du service demandé. Nouveau sous-traitant : Microsoft Azure (région France Central).
  Révocation : « Supprimer mon compte » ou myaccount.google.com/permissions coupe tout immédiatement.

## 5. Notifications

| Moyen | Android | PC | iPhone / iPad | Coût |
|---|---|---|---|---|
| **Web Push (PWA)** | ✅ | ✅ | ✅ **seulement si Studoo est ajouté à l'écran d'accueil** (iOS 16.4+) | Gratuit (clés VAPID) |
| **E-mail** (secours) | ✅ | ✅ | ✅ | Gratuit via Brevo (300/jour, sans carte) ; sans nom de domaine, l'expéditeur sera une adresse vérifiée (ex. `studoo.bastosdev@gmail.com`), risque de dossier « spam » |
| Pastille dans le site | ✅ | ✅ | ✅ | Gratuit |
