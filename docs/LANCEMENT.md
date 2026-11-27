# Ouvrir Studoo à tout le monde : étapes manuelles (itération 7)

Tout ce qui pouvait être fait dans le code l'est. Restent les actions dans des consoles en ligne, que **toi seul**
peux faire. Suis-les **dans cet ordre**. Coût total : **0 €** (un nom de domaine, environ 7 à 15 €/an, seulement si
Google refuse l'adresse `vercel.app` à l'étape 3).

## 1. Sécurité d'abord : régénérer deux clés Azure (10 min)

Les clés Azure AI Speech et Azure OpenAI ont transité par la conversation de développement. Par prudence :

1. Portail Azure → ressource **studoo-voix** → *Clés et point de terminaison* → **Régénérer la clé 1**.
2. Même chose pour **studoo-ecriture-…** (Azure OpenAI).
3. Vercel → *Settings → Environment Variables* : remplace `SPEECH_KEY` et `AZURE_OPENAI_KEY` (production) par les nouvelles clés.
4. Mets aussi les nouvelles clés dans `.env.worker` (`SPEECH_KEY`, `AZURE_OPENAI_KEY`), puis lance `worker/azure/deploy.ps1`
   (ce lancement met aussi en ligne la nouvelle version du serveur de tâches : Sentry, Gemini au choix de l'élève).
5. Vercel → *Deployments* → dernier déploiement → **Redeploy**.

## 2. Sentry : suivi des erreurs (10 min)

1. Crée un compte sur <https://sentry.io> en choisissant la région **EU (Frankfurt)** pour les données.
2. Crée un projet (plateforme « Python » ; il recevra aussi les erreurs du site) nommé `studoo`.
3. **Obligatoire avant d'activer** : *Settings → Security & Privacy* → coche **Prevent Storing of IP Addresses**
   et laisse **Data Scrubber** activé (la page RGPD annonce qu'aucune adresse IP n'est gardée).
4. Copie le **DSN** (*Settings → Client Keys*). Ajoute-le dans Vercel (`SENTRY_DSN`, production) et dans `.env.worker`
   (`SENTRY_DSN`), puis redéploie (Vercel *Redeploy* et `deploy.ps1`). Tant que `SENTRY_DSN` est vide, rien n'est envoyé.

## 3. Google : connexion ouverte à tous (30 min + 2 à 3 jours d'attente)

Bonne nouvelle : Studoo ne demande que des **portées non sensibles** (`openid`, `email`, `profile`,
`https://www.googleapis.com/auth/drive.file`). Le passage en production **ne déclenche pas d'examen** par Google
(pas de vidéo ni d'audit de sécurité obligatoires). Seule la **vérification de la marque** (nom + logo sur l'écran
de connexion) demande quelques jours ; sans elle, tout le monde peut déjà se connecter, mais l'écran affiche l'adresse
du site au lieu de « Studoo ».

### 3a. Adresse d'assistance `probastos@proton.me`

Google n'accepte comme « adresse d'assistance » qu'un **compte Google** (ou un groupe Google) qui a accès au projet :

1. Crée un compte Google **avec ton adresse existante** : <https://accounts.google.com/signup> → « Utiliser mon adresse
   e-mail actuelle » → `probastos@proton.me` (Google t'envoie un code pour la vérifier).
2. Google Cloud → *IAM et administration → IAM* → **Accorder l'accès** à `probastos@proton.me`, rôle **Propriétaire**
   (ou Éditeur).

### 3b. Search Console : prouver que le site est à toi (nécessaire pour la vérification de la marque)

1. <https://search.google.com/search-console> → **Ajouter une propriété** → **Préfixe de l'URL** :
   `https://studoo-app.vercel.app/` (le type « Domaine » est impossible sur `vercel.app`).
2. Méthode **Balise HTML** : copie la balise `<meta name="google-site-verification" content="…">` et **envoie-la-moi**
   (ou colle-la dans `frontend/index.html`, juste après `<meta name="theme-color" …>`), puis attends la mise en ligne et
   clique sur **Valider**.
3. Utilise le **même compte Google** que celui qui gère le projet Google Cloud.
4. *Sitemaps* → ajoute `sitemap.xml`. *Inspection de l'URL* → `https://studoo-app.vercel.app/` → **Demander l'indexation**
   (puis une page outil, par exemple `/outils/fiche-de-revision-automatique`).

### 3c. Google Auth Platform (console Google Cloud)

<https://console.cloud.google.com/auth/overview>, dans le projet Studoo :

1. **Branding** :
   - Nom de l'application : `Studoo`
   - Adresse d'assistance : `probastos@proton.me` (étape 3a)
   - Logo : `docs/lancement/logo-google-120.png` (120 × 120)
   - Page d'accueil : `https://studoo-app.vercel.app/`
   - Règles de confidentialité : `https://studoo-app.vercel.app/rgpd`
   - Conditions d'utilisation : `https://studoo-app.vercel.app/cgu`
   - Domaines autorisés : `studoo-app.vercel.app`
   - Contact développeur : `probastos@proton.me`
2. **Data access** : vérifie qu'il n'y a **que** `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` et
   `.../auth/drive.file`. Si une justification est demandée pour `drive.file`, colle :
   > Studoo enregistre les cours de l'élève (transcriptions, PDF, fiches, podcasts, vidéos) dans un dossier « Studoo »
   > de son propre Google Drive, et relit uniquement ces fichiers. Avec drive.file, l'application ne voit que les fichiers
   > qu'elle a créés ou que l'élève ouvre avec elle, jamais le reste de son Drive. Aucun cours n'est stocké sur nos serveurs.
3. **Clients** → ton identifiant OAuth Web : origines JavaScript autorisées `https://studoo-app.vercel.app`
   (et `http://localhost:5173` pour le développement). Aucune URI de redirection n'est nécessaire (mode popup).
4. **Audience** → **Publier l'application** → « En production ». À partir de là, **n'importe quel compte Google** peut se connecter.
5. **Branding → Vérifier la marque** (« Verify branding »). Réponse sous 2 à 3 jours ouvrés, par e-mail.
   - **Si Google refuse l'adresse `vercel.app`** : achète un nom de domaine (par exemple `studoo.fr` chez OVH ou
     Gandi, environ 7 à 15 €/an), ajoute-le dans Vercel (*Settings → Domains*), et dis-le-moi : je mets à jour
     `APP_URL`, les adresses canoniques, le sitemap et les pages ; tu refais alors 3b avec une propriété « Domaine ».

**Vidéo de démonstration** : non exigée pour des portées non sensibles. Si Google en demande une quand même, script (1 min 30) :
1. Page d'accueil `https://studoo-app.vercel.app/`, clic sur « Se connecter avec Google ».
2. Écran de consentement : montrer le nom de l'application et la portée Drive (« fichiers créés par Studoo uniquement »).
3. Tableau de bord → « Créer une fiche » → choisir un cours → la fiche s'affiche.
4. Ouvrir Google Drive dans un autre onglet : montrer le dossier « Studoo » et la fiche créée (et rien d'autre).
5. Réglages → « Supprimer mon compte » (montrer, sans valider) ; liens RGPD et CGU en bas de page.

## 4. Bing Webmaster Tools (5 min)

<https://www.bing.com/webmasters> → **Importer depuis Google Search Console** (le plus simple : propriété et sitemap
repris automatiquement). Bing alimente aussi plusieurs assistants d'IA (Copilot, etc.).

## 5. GitHub (5 min)

Le dépôt `B2TN/studoo` est déjà public, et l'audit n'y a trouvé **aucun secret** (voir `docs/SECURITE.md`).

1. *Settings → General* : description « Site de révision gratuit : transcription, fiches, podcasts, vidéos à partir de
   tes cours » ; site web `https://studoo-app.vercel.app` ; sujets `education`, `fastapi`, `vite`, `azure`, `pwa`.
2. *Settings → Code security* : active **Dependabot alerts**, **Dependabot security updates** et **Secret scanning
   (push protection)** — gratuits pour un dépôt public.
3. Rien à faire pour le contrôle avant mise en ligne : Vercel attend tout seul que les tests GitHub réussissent
   (`scripts/vercel-ignore.sh`).

## 6. Facultatif

- **E-mail de secours** (si les notifications sont refusées) : compte Brevo gratuit, `BREVO_API_KEY` et `MAIL_FROM`
  dans `.env.worker`, puis `EMAIL_NOTIFICATIONS=1` sur Vercel. Pense à retirer la mention « pas encore activé » de la
  page RGPD (ou demande-le-moi).

## Récapitulatif des coûts

| Élément | Coût |
|---|---|
| Vercel, Neon, GitHub, Sentry (offres gratuites), Search Console, Bing | 0 € |
| Azure (crédit Azure for Students, 100 $/an) | 0 € tant que le crédit tient ; limites quotidiennes dans le code |
| Passage en production Google, vérification de la marque | 0 € |
| Nom de domaine | 0 € avec `vercel.app` ; 7 à 15 €/an seulement si Google le refuse |
