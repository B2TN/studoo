# Architecture et faisabilité

> Document de décision rédigé avant le code (23/11/2026). Chaque choix est expliqué
> en une ou deux phrases ; les limites sont dites franchement.

## 1. Vue d'ensemble

```
 Navigateur (HTML/CSS/JS + Vite)
   │  ├── Google Identity Services : bouton « Se connecter avec Google »
   │  ├── Google Drive API (directement, avec le jeton de l'utilisateur)
   │  │     → les cours ne passent JAMAIS par notre serveur pour être stockés
   │  └── fetch("/api/...")  (même domaine, cookie de session httpOnly)
   ▼
 API FastAPI (Python, fonctions Vercel)          API Node (fonction Vercel)
   ├── /api/auth/*   échange du code OAuth          └── /api/pronote/*  (Pawnote)
   ├── /api/ai/*     IA : Azure AI Speech / Azure OpenAI (clés cachées)
   ├── /api/ent/*    ENT étudiants (CAS → ADE…)
   ├── /api/events   analytics maison (sans cookie)
   └── /api/admin/*  réservé à ADMIN_EMAILS
   ▼
 Base Postgres gratuite (Neon) : uniquement comptes (e-mail, dates) + compteurs
```

**Pourquoi ce découpage ?** Le navigateur parle directement à Google Drive avec le jeton
de l'utilisateur : nos serveurs ne stockent aucun cours. Le serveur ne sert qu'à cacher
les clés d'IA, valider les données et compter les visites.

## 2. Connexion Google (seul moyen de connexion)

| Élément | Choix | Pourquoi |
|---|---|---|
| Flux | OAuth 2.0 « authorization code » (popup GIS → backend) | Le secret client reste côté serveur. |
| Scopes | `openid email profile` + `https://www.googleapis.com/auth/drive.file` | `drive.file` = l'appli ne voit **que les fichiers qu'elle a créés**. C'est un scope « non sensible » : pas d'audit de sécurité payant. |
| Session | Cookie `httpOnly`, `Secure`, `SameSite=Lax`, signé ; le *refresh token* Google y est **chiffré** | Pas de table de jetons sur le serveur. Le navigateur demande un jeton Drive frais via `/api/auth/token`. |
| Admin | Variable d'env. `ADMIN_EMAILS` | Pages `/admin` et `/analytics` réservées. |

**Limites :**
- Mode « test » (choisi pour démarrer) : 100 comptes max, ajoutés à la main dans la console Google, et le jeton expire tous les 7 jours (reconnexion).
- Passage en public : vérification de marque Google (gratuite, quelques jours) — il faut une page d'accueil, RGPD et CGU en ligne (prévues).
- `drive.file` ne permet pas de parcourir les fichiers déjà présents dans le Drive : on importe depuis l'appareil (le fichier devient alors « créé par l'appli »).

## 3. IA : les outils de Studoo sur Microsoft Azure (itération 6)

**Par défaut, aucune donnée ne part chez Google.** Tout passe par les services Azure de Studoo
(crédit Azure for Students, région Italy North), ou par des modèles open source sur notre serveur de tâches.

| Usage | Où ça tourne | Remarque |
|---|---|---|
| Transcription + rôles (tranches de 5 min) | **Azure AI Speech** « fast transcription » (`studoo-voix`, F0) | Diarisation : la voix qui parle le plus = « Professeur ». Audio effacé même en cas d'échec. |
| Estimation du cours, titre automatique | **Azure OpenAI** GPT-4.1 mini, depuis l'API Vercel | Petite requête texte (`services/ai.py`). |
| Fiches | Azure OpenAI GPT-4.1 mini, depuis l'API Vercel | JSON structuré, rendu dans le style cahier. |
| Lecture des PDF scannés importés | Azure OpenAI GPT-4.1 mini (vision) | Pages réduites dans le navigateur. |
| Lecture des photos de cours numérisées | **Qwen3-VL** (open source) sur le serveur de tâches | Rien ne sort de notre serveur. |
| Scripts de podcast / vidéo, feuilles d'exercices, corrections de copies | Serveur de tâches → Azure OpenAI (repli : Qwen3-4B local) | Voir [AZURE.md](AZURE.md). |
| Voix | Azure AI Speech (Vivienne + Henri ; Denise en secours ; voix locales sinon) | Signalé à l'élève si une voix de secours a servi. |

**Gemini, en option personnelle.** Il n'y a plus de clé Gemini du site. Un élève peut enregistrer
**sa** clé dans les réglages (vérifiée auprès de Google, chiffrée par Fernet avec une clé dérivée de
`SESSION_SECRET` et liée à son compte, jamais renvoyée au navigateur ni écrite dans un journal). Des cases
apparaissent alors, **toutes décochées** : transcription, rangement, fiches, exercices/corrections,
lecture des photos, podcasts, vidéos. Pour une case cochée, l'API (ou le serveur de tâches, via la tâche
chiffrée) appelle Gemini avec sa clé en premier, puis repasse sur Azure si Gemini échoue. Avant la saisie,
la page explique ce qui part chez Google pour chaque fonctionnalité.

**Quotas.** `QUOTA_LITE_PER_DAY` / `QUOTA_FLASH_PER_DAY` (partagés) et `QUOTA_USER_PER_DAY` (par élève)
protègent le crédit Azure. Les demandes faites avec la clé Gemini d'un élève ne consomment pas ces quotas.

## 4. Fonctionnalités : comment, et ce qui est réaliste

### 4.1 Transcription
Micro → `MediaRecorder` (Opus, ~1 Mo / 5 min) → tranche envoyée à `/api/ai/transcribe` →
Azure AI Speech → texte renvoyé → **l'audio est effacé de la mémoire** (jamais écrit sur disque, ni Drive,
ni serveur). Texte affiché au fil du cours (~1 min de décalage). Durée max : 2 h.
Consentement : engagement accepté une fois, puis rappel discret.
Ensuite : page de confirmation (cours/chapitre estimés, titre auto).

### 4.2 Numérisation de cours papier
Traitement d'image **écrit à la main en JavaScript** (`frontend/src/lib/scan-core.js`, ~200 lignes,
au lieu d'OpenCV.js qui pèse ~10 Mo) : détection de la feuille (seuil d'Otsu + plus grande zone claire),
coins ajustables à la main, redressement par homographie, suppression des ombres (normalisation de
l'éclairage) et contraste. PDF assemblé avec **pdf-lib**. La photo ne quitte jamais l'appareil
(seule une copie réduite part vers le serveur de tâches de Studoo, où Qwen3-VL lit le texte).

### 4.3 Fiches
Azure OpenAI (GPT-4.1 mini) produit un JSON structuré (titres, définitions, encadrés, schémas simples), rendu par le
site dans le style cahier. Fichier `.fiche.json` sur Drive + bouton « Exporter en PDF »
(impression navigateur avec feuille de style dédiée).

### 4.4 Podcasts (10 / 20 / 30 min)
Le serveur de tâches fait écrire un dialogue à deux voix par Azure OpenAI, **uniquement à partir des
cours sélectionnés**, puis le fait lire par Azure AI Speech (Vivienne + Henri) et range le MP3 dans le Drive.
Détails : [AZURE.md](AZURE.md).

### 4.5 Vidéos explicatives (≈2 / 10 / 30 min)
Pas de vidéo IA « réelle » (Veo est payant). Alternative gratuite : **diaporama animé dessiné à
la main + voix**. Azure OpenAI écrit le script et les diapos (serveur de tâches) ; le navigateur dessine chaque diapo sur un
`<canvas>` et encode un **MP4** (WebCodecs + `mp4-muxer`), plus vite que le temps réel sur un
ordinateur récent (plus lent sur téléphone). Voix : Azure AI Speech (Vivienne).

### 4.6 Emploi du temps
| Méthode | Réalisme |
|---|---|
| **Lien / fichier `.ics`** | Fiable. Pronote, ADE, HyperPlanning, Celcat… proposent un lien iCal personnel mis à jour en continu. Chaque service a un tutoriel intégré. |
| **Pronote (lycéens)** | Bibliothèque **non officielle** Pawnote (Node). Connexion par **QR code** (aucun mot de passe). Si l'instance Pronote propose l'export iCal (Pronote 2024+), Studoo récupère le **lien iCal officiel** et ne garde rien d'autre ; sinon un **jeton de reconnexion chiffré** (AES-256-GCM, lié à l'utilisateur) est rangé dans le Drive de l'élève. Peut casser à chaque mise à jour de Pronote ; zone grise vis-à-vis des CGU d'Index Éducation. |
| **ENT lycée (5 services)** | Pronote (connecteur), puis École Directe, Skolengo/Kdecole, Oze/ENT régionaux, Monlycée.net : **tutoriel lien iCal** quand le service l'offre ; sinon export via Pronote (la plupart des ENT régionaux y renvoient). |
| **20 grands établissements du supérieur** | Parcours guidé par établissement (lien vers l'ENT, étapes pour obtenir le lien iCal d'ADE / Celcat / HyperPlanning, reconnaissance automatique du logiciel). Les liens ADE ont des dates fixes : Studoo les **fait glisser automatiquement** pour rester à jour. **Pas de connexion CAS par mot de passe** : impossible à tester sans comptes, fragile, et le lien iCal donne le même résultat sans aucun identifiant. |

Création automatique des dossiers de cours à partir des noms de matières de l'EDT.

### 4.7 Stockage / explorateur
Arborescence dans le Drive de l'utilisateur :
`<Nom du site>/<Cours>/<Chapitre>/{PDF, transcriptions .md, fiches, podcasts, vidéos}`.
Explorateur intégré (liste, glisser-déposer, renommer, supprimer → corbeille Drive).

## 5. Hébergement gratuit : comparaison

| Option | Front | Back Python | Inconvénients | Verdict |
|---|---|---|---|---|
| **Vercel (Hobby)** | ✅ | ✅ FastAPI détecté automatiquement, + fonctions Node | Usage non commercial uniquement ; 300 s max par requête | **Recommandé** : un seul projet, un seul domaine `*.vercel.app`, déploiement auto depuis GitHub, pas de mise en veille. |
| Render (free) | ✅ | ✅ | Le back s'endort après 15 min (réveil ~1 min) | Correct, mais lent au premier clic. |
| Cloudflare Pages + Workers | ✅ | ⚠️ Python en bêta | Bibliothèques Python limitées | Très rapide, mais compliqué pour notre back. |
| Netlify | ✅ | ❌ pas de Python | — | Non. |
| Google Cloud Run | ✅ | ✅ | Carte bancaire obligatoire | Non (budget 0 €). |

Base de données : **Neon Postgres** gratuit (0,5 Go), branché à Vercel en un clic.
Adresse : `<nom>.vercel.app` (personnalisable gratuitement).

## 6. Sécurité
- HTTPS forcé (Vercel + en-tête HSTS), en-têtes CSP, `X-Content-Type-Options`, etc.
- Toutes les entrées validées côté serveur (Pydantic), tailles maximales imposées.
- Anti-spam : limitation de débit par utilisateur/IP, champ « pot de miel » sur les formulaires.
- Clés (Azure, secret OAuth, clé de chiffrement) uniquement dans les variables d'environnement Vercel et du serveur de tâches ; aucune clé Gemini du site.

## 7. Ce que TU devras faire (je te guiderai pas à pas)
1. Créer un projet Google Cloud, l'écran de consentement OAuth et un identifiant client Web.
2. Créer les ressources Azure (AI Speech, Azure OpenAI) : voir [AZURE.md](AZURE.md).
3. Créer un compte Vercel (connexion avec GitHub) et une base Neon.
4. Ajouter les variables d'environnement.

Sources consultées : [Pawnote](https://github.com/LiterateInk/Pawnote/blob/index/README.md),
[limites Vercel](https://vercel.com/docs/limits), [offre Hobby](https://vercel.com/docs/accounts/plans/hobby-plan).
