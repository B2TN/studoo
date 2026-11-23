# Mettre Studoo en ligne (gratuitement)

Compte : environ 30 minutes. Tout est gratuit, aucune carte bancaire n'est demandée.

## 1. Google Cloud : connexion Google

1. Va sur <https://console.cloud.google.com/> et crée un projet « Studoo ».
2. **API et services → Bibliothèque** : active **Google Drive API**.
3. **API et services → Écran de consentement OAuth** (« Google Auth Platform ») :
   - Type d'utilisateur : **Externe** ; nom de l'appli : Studoo ; logo : `frontend/public/icon-512.png`.
   - Domaine de l'appli : page d'accueil `https://studoo.vercel.app`, règles de confidentialité `https://studoo.vercel.app/rgpd`, conditions `https://studoo.vercel.app/cgu`.
   - **Accès aux données (scopes)** : `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `.../auth/drive.file`.
   - **Audience** : laisse le statut **« En test »** et ajoute ton adresse Gmail (et celles de tes testeurs, 100 max) dans **Utilisateurs test**.
4. **Clients → Créer un client** : type **Application Web**.
   - Origines JavaScript autorisées : `https://studoo.vercel.app` et `http://localhost:5173`.
   - (Aucune URI de redirection n'est nécessaire : Studoo utilise le mode « popup ».)
   - Note l'**ID client** et le **code secret**.

> En mode « test », les connexions expirent au bout de 7 jours (il suffit de se reconnecter).
> Pour ouvrir au public : **Audience → Publier l'application**. `drive.file` n'étant pas un scope sensible,
> Google ne demande qu'une vérification de la marque (quelques jours, gratuite).

## 2. Google AI Studio : clé Gemini

1. Va sur <https://aistudio.google.com/apikey> → **Create API key** (dans le projet Studoo).
2. Dans **Rate limits**, vérifie les quotas gratuits du jour et les noms exacts des modèles,
   puis ajuste `GEMINI_MODEL_*` et `QUOTA_*` si besoin.

## 3. Neon : base de données

1. Crée un compte sur <https://neon.tech> (connexion avec GitHub), projet « studoo », **région Europe (Frankfurt)**.
2. Copie l'**URL de connexion** (`postgresql://...`). Les tables sont créées automatiquement au premier lancement.

## 4. Vercel : hébergement et déploiement automatique

1. Crée un compte sur <https://vercel.com> avec ton GitHub.
2. **Add New → Project** → importe le dépôt `studoo`. Vercel lit `vercel.json` (rien à régler).
3. **Settings → Domains** : renomme le domaine en `studoo.vercel.app` (ou un autre nom libre, puis mets à jour les URL partout).
4. **Settings → Environment Variables** (Production) :

| Variable | Valeur |
|---|---|
| `APP_URL` | `https://studoo.vercel.app` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | étape 1 |
| `GEMINI_API_KEY` | étape 2 |
| `SESSION_SECRET` | 48 caractères aléatoires : `python -c "import secrets; print(secrets.token_urlsafe(48))"` |
| `ADMIN_EMAILS` | ton adresse Gmail |
| `DATABASE_URL` | étape 3 |

5. **Deployments → Redeploy**. Ensuite, chaque `git push` sur `main` met le site à jour tout seul.

## 5. Référencement Google (Search Console)

1. <https://search.google.com/search-console> → **Ajouter une propriété** → « Préfixe de l'URL » : `https://studoo.vercel.app/`.
2. Méthode de validation **Balise HTML** : copie la balise `<meta name="google-site-verification" ...>`
   dans le `<head>` de `frontend/index.html`, pousse sur GitHub, puis clique sur **Valider**.
3. **Sitemaps** → ajoute `sitemap.xml`.
4. **Inspection de l'URL** → `https://studoo.vercel.app/` → **Demander l'indexation**.

## Vérifier après la mise en ligne

- `https://studoo.vercel.app/api/health` répond `{"ok": true, ...}`.
- Connexion Google → le dossier « Studoo » apparaît dans ton Drive.
- `/admin` et `/analytics` sont accessibles avec l'adresse de `ADMIN_EMAILS`, et refusés aux autres.
