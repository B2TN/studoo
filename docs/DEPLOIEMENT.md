# Mettre Studoo en ligne (gratuitement)

Compte : environ 30 minutes. Tout est gratuit, aucune carte bancaire n'est demandée.

## 1. Google Cloud : connexion Google

1. Va sur <https://console.cloud.google.com/> et crée un projet « Studoo ».
2. **API et services → Bibliothèque** : active **Google Drive API**.
3. **API et services → Écran de consentement OAuth** (« Google Auth Platform ») :
   - Type d'utilisateur : **Externe** ; nom de l'appli : Studoo ; logo : `frontend/public/icon-512.png`.
   - Domaine de l'appli : page d'accueil `https://studoo-app.vercel.app`, règles de confidentialité `https://studoo-app.vercel.app/rgpd`, conditions `https://studoo-app.vercel.app/cgu`.
   - **Accès aux données (scopes)** : `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `.../auth/drive.file`.
   - **Audience** : laisse le statut **« En test »** et ajoute ton adresse Gmail (et celles de tes testeurs, 100 max) dans **Utilisateurs test**.
4. **Clients → Créer un client** : type **Application Web**.
   - Origines JavaScript autorisées : `https://studoo-app.vercel.app` et `http://localhost:5173`.
   - (Aucune URI de redirection n'est nécessaire : Studoo utilise le mode « popup ».)
   - Note l'**ID client** et le **code secret**.

> En mode « test », les connexions expirent au bout de 7 jours (il suffit de se reconnecter).
> Pour ouvrir au public : **Audience → Publier l'application**. `drive.file` n'étant pas un scope sensible,
> Google ne demande qu'une vérification de la marque (quelques jours, gratuite).

## 2. Microsoft Azure : IA du site

Le site n'utilise **aucune clé Gemini**. L'IA tourne sur Azure (voir [AZURE.md](AZURE.md)) :

1. **Azure AI Speech** (`studoo-voix`) : copie la clé 1 et la région → `SPEECH_KEY`, `SPEECH_REGION`.
2. **Azure OpenAI** (`studoo-ecriture-…`, déploiement `gpt-4.1-mini`) : copie la clé et l'adresse
   `https://<ressource>.openai.azure.com/openai/v1/chat/completions` → `AZURE_OPENAI_KEY`, `AZURE_OPENAI_URL`.

## 3. Neon : base de données

1. Crée un compte sur <https://neon.tech> (connexion avec GitHub), projet « studoo », **région Europe (Frankfurt)**.
2. Copie l'**URL de connexion** (`postgresql://...`). Les tables sont créées automatiquement au premier lancement.

## 4. Vercel : hébergement et déploiement automatique

> ✅ Déjà fait : le projet Vercel « studoo » est relié au dépôt GitHub, l'adresse est `studoo-app.vercel.app`,
> et `APP_URL`, `SESSION_SECRET` et une base SQLite **provisoire** (`/tmp`, effacée régulièrement) sont configurés.
> Il reste à ajouter les variables Google, Azure, admin et Neon ci-dessous.

1. Sur <https://vercel.com>, ouvre le projet **studoo**.
2. **Settings → Environment Variables** (Production) — ajoute ou remplace :

| Variable | Valeur |
|---|---|
| `APP_URL` | `https://studoo-app.vercel.app` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | étape 1 |
| `SPEECH_KEY` / `SPEECH_REGION` | étape 2 (transcription) |
| `AZURE_OPENAI_KEY` / `AZURE_OPENAI_URL` | étape 2 (rangement automatique, fiches, lecture des PDF) |
| `SESSION_SECRET` | 48 caractères aléatoires : `python -c "import secrets; print(secrets.token_urlsafe(48))"` |
| `ADMIN_EMAILS` | ton adresse Gmail |
| `DATABASE_URL` | étape 3 |

3. **Deployments → Redeploy**. Ensuite, chaque `git push` sur `main` met le site à jour tout seul.

## 5. Référencement Google (Search Console)

1. <https://search.google.com/search-console> → **Ajouter une propriété** → « Préfixe de l'URL » : `https://studoo-app.vercel.app/`.
2. Méthode de validation **Balise HTML** : copie la balise `<meta name="google-site-verification" ...>`
   dans le `<head>` de `frontend/index.html`, pousse sur GitHub, puis clique sur **Valider**.
3. **Sitemaps** → ajoute `sitemap.xml`.
4. **Inspection de l'URL** → `https://studoo-app.vercel.app/` → **Demander l'indexation**.

## Vérifier après la mise en ligne

- `https://studoo-app.vercel.app/api/health` répond `{"ok": true, ...}`.
- Connexion Google → le dossier « Studoo » apparaît dans ton Drive.
- `/admin` et `/analytics` sont accessibles avec l'adresse de `ADMIN_EMAILS`, et refusés aux autres.
