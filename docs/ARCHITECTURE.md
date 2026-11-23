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
   ├── /api/ai/*     appels Gemini (clé cachée)
   ├── /api/ent/*    ENT étudiants (CAS → ADE…)
   ├── /api/events   analytics maison (sans cookie)
   └── /api/admin/*  réservé à ADMIN_EMAILS
   ▼
 Base Postgres gratuite (Neon) : uniquement comptes (e-mail, dates) + compteurs
```

**Pourquoi ce découpage ?** Le navigateur parle directement à Google Drive avec le jeton
de l'utilisateur : nos serveurs ne stockent aucun cours. Le serveur ne sert qu'à cacher
la clé Gemini, valider les données et compter les visites.

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

## 3. IA : Gemini (clé du propriétaire du site, côté serveur)

L'utilisateur n'a aucune clé à fournir : c'est **ta** clé Gemini, cachée dans l'API, qui paie.
Budget choisi : **0 €** → niveau gratuit.

| Usage | Modèle (configurable par variable d'env.) | Remarque |
|---|---|---|
| Transcription + diarisation (tranches de 5 min) | Gemini *Flash-Lite* | Gemini comprend l'audio et sait étiqueter « Professeur / Élève ». |
| Estimation du cours, titre automatique | Flash-Lite | Petite requête texte. |
| Fiches, scripts de podcast et de vidéo | Gemini *Flash* (repli Flash-Lite) | Qualité supérieure, quota plus faible. |
| Voix (podcast, vidéo) | Gemini *TTS* multi-voix | Repli : voix de synthèse du navigateur. |

**Limites honnêtes (à vérifier dans AI Studio, elles changent souvent) :**
- En octobre 2026, le gratuit est rapporté à environ **20 requêtes/jour** pour Flash et **~500/jour** pour Flash-Lite, **par projet** (donc partagées entre tous les utilisateurs), remise à zéro à minuit heure du Pacifique. Un cours de 2 h = 24 tranches ≈ 24 requêtes Flash-Lite → environ **20 cours de 2 h par jour pour tout le site**.
- TTS gratuit : quelques minutes d'audio par jour. Un podcast de 30 min ne tiendra pas en une journée → bascule automatique sur la voix du navigateur.
- **RGPD** : au niveau gratuit, Google peut utiliser les contenus envoyés pour améliorer ses produits. C'est écrit en clair dans la page RGPD et rappelé avant le premier enregistrement. Passer au niveau payant (quelques €/mois) supprime ce point.
- L'API gère les erreurs de quota proprement : message clair « quota du jour atteint, réessaie demain » et file d'attente côté client.

## 4. Fonctionnalités : comment, et ce qui est réaliste

### 4.1 Transcription
Micro → `MediaRecorder` (Opus, ~1 Mo / 5 min) → tranche envoyée à `/api/ai/transcribe` →
Gemini → texte renvoyé → **l'audio est effacé de la mémoire** (jamais écrit sur disque, ni Drive,
ni serveur). Texte affiché au fil du cours (~1 min de décalage). Durée max : 2 h.
Consentement : engagement accepté une fois, puis rappel discret.
Ensuite : page de confirmation (cours/chapitre estimés, titre auto).

### 4.2 Numérisation de cours papier
Dans le navigateur avec **OpenCV.js** : détection des bords de la feuille, redressement
(perspective), recadrage, contraste et nettoyage du fond. PDF assemblé avec **pdf-lib**.
La photo ne quitte jamais l'appareil (seule une miniature basse définition part vers Gemini
pour estimer le cours et le titre).

### 4.3 Fiches
Gemini produit un JSON structuré (titres, définitions, encadrés, schémas simples), rendu par le
site dans le style cahier. Fichier `.fiche.json` sur Drive + bouton « Exporter en PDF »
(impression navigateur avec feuille de style dédiée).

### 4.4 Podcasts (10 / 20 / 30 min)
Gemini écrit un dialogue à deux voix **uniquement à partir des cours sélectionnés**. Voix Gemini
TTS par segments d'~1 min, assemblés et encodés en audio compressé dans le navigateur, puis
envoyés sur Drive. Si le quota TTS est épuisé : le script est enregistré et lu par la voix du
navigateur dans le lecteur du site (pas de fichier audio dans ce cas — les navigateurs ne
permettent pas d'enregistrer leur propre voix de synthèse).

### 4.5 Vidéos explicatives (≈2 / 10 / 30 min)
Pas de vidéo IA « réelle » (Veo est payant). Alternative gratuite : **diaporama animé dessiné à
la main + voix**. Gemini écrit le script et les diapos ; le navigateur dessine chaque diapo sur un
`<canvas>` et encode un **MP4** (WebCodecs + `mp4-muxer`), plus vite que le temps réel sur un
ordinateur récent (plus lent sur téléphone). Sans voix Gemini disponible : MP4 sous-titré.

### 4.6 Emploi du temps
| Méthode | Réalisme |
|---|---|
| **Lien / fichier `.ics`** | Fiable. Pronote, ADE, HyperPlanning, Celcat… proposent un lien iCal personnel mis à jour en continu. Chaque service a un tutoriel intégré. |
| **Pronote (lycéens)** | Bibliothèque **non officielle** Pawnote (Node). Connexion par **QR code** (le mot de passe n'est jamais envoyé) ou identifiants pour les comptes sans ENT. On ne garde que le **jeton de reconnexion**, chiffré, dans le Drive de l'élève. Peut casser à chaque mise à jour de Pronote ; zone grise vis-à-vis des CGU d'Index Éducation. |
| **ENT lycée (5 services)** | Pronote (connecteur), puis École Directe, Skolengo/Kdecole, Oze/ENT régionaux, Monlycée.net : **tutoriel lien iCal** quand le service l'offre ; sinon export via Pronote (la plupart des ENT régionaux y renvoient). |
| **20 grands établissements du supérieur** | Fiche par établissement (logiciel d'EDT, URL, tutoriel iCal). Connecteur expérimental « CAS → ADE » pour ceux qui utilisent ADE : identifiants utilisés une fois, en HTTPS, **jamais stockés**. **Je ne peux pas tester sans comptes** : ces connecteurs sont « au mieux », avec repli automatique sur le lien iCal. |

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
- Clés (Gemini, secret OAuth, clé de chiffrement) uniquement dans les variables d'environnement Vercel.

## 7. Ce que TU devras faire (je te guiderai pas à pas)
1. Créer un projet Google Cloud, l'écran de consentement OAuth et un identifiant client Web.
2. Créer une clé Gemini dans Google AI Studio.
3. Créer un compte Vercel (connexion avec GitHub) et une base Neon.
4. Ajouter les variables d'environnement.

Sources consultées : [quotas Gemini (oct. 2026, non officiel)](https://imisofts.com/blog/gemini-api-free-tier-limits/),
[aifreeapi](https://www.aifreeapi.com/en/posts/google-gemini-api-free-tier),
[Pawnote](https://github.com/LiterateInk/Pawnote/blob/index/README.md),
[limites Vercel](https://vercel.com/docs/limits), [offre Hobby](https://vercel.com/docs/accounts/plans/hobby-plan).
