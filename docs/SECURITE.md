# Audit de sécurité avant l'ouverture publique (itération 7, 27/11/2026)

Méthode : relecture du code (API, serveur de tâches, site), outils automatiques, et tests ajoutés pour chaque
correction. Aucun test n'a visé de compte ou de donnée réels : uniquement des comptes de démonstration et de faux
serveurs. L'outil d'analyse multi-agents « Claude Security » n'a pas pu tourner dans cette session (il exige les
« workflows », désactivés) : l'audit a donc été fait à la main, avec les outils ci-dessous.

Outils : `npm audit` (site), `pip-audit` (API et serveur de tâches), `detect-secrets` + recherche de longues chaînes
aléatoires sur **tout l'historique Git** (61 commits), `curl` sur le site en ligne (en-têtes, CORS, CSRF, HTTPS).

## Trouvé et corrigé

| Gravité | Problème | Correction |
|---|---|---|
| **Élevée** | Supprimer un compte depuis l'admin n'effaçait que sa ligne : ses tâches, sa clé Gemini, ses compteurs restaient, et **sa session restait valable 30 jours** (cookie chiffré jamais revérifié). | Chaque session est revérifiée (compte existant, non banni ; au plus une lecture par minute) ; la suppression efface tout ce que Studoo garde. Tests `test_bans.py`. |
| Moyenne | **SSRF par redirection** : les robots d'emploi du temps (ADE, Celcat, HyperPlanning, Aurion) vérifiaient l'adresse de départ mais suivaient ensuite les redirections sans contrôle ; la détection du logiciel (`/higher/detect`) n'en faisait aucun. Un faux établissement pouvait faire viser une adresse interne au serveur. | `services/netguard.py` : chaque requête, redirections comprises, doit viser une adresse publique en HTTP(S), sinon elle n'est jamais envoyée. Tests SSRF (169.254.169.254, 127.0.0.1, 10.x, `file://`). |
| Moyenne | Connexion acceptée avec une adresse e-mail **non vérifiée par Google**, alors que les droits admin et les bannissements reposent sur l'e-mail. | Connexion refusée si `email_verified` n'est pas vrai. Test ajouté. |
| Moyenne | **Coûts** : aucune limite quotidienne pour les générations du serveur de tâches (podcasts, vidéos, exercices…), seulement 30 par heure. | 10 par élève et par jour, et un plafond global de 150 par jour (contre la création de comptes en masse). Tests `test_limits.py`. |
| Faible | Les photos envoyées au serveur de tâches n'étaient vérifiées qu'en taille. | Signature JPEG/PNG/WebP et base64 exigés avant tout traitement. Test ajouté. |
| Faible (vie privée) | Les compteurs anti-abus gardaient l'adresse IP en clair jusqu'à 2 jours (corrigé à l'itération 6). | Empreinte HMAC uniquement. |

## Vérifié, sans problème trouvé

- **Sessions** : cookie chiffré (Fernet), `HttpOnly`, `Secure`, `SameSite=Lax`, 30 jours ; déconnexion qui efface le cookie.
- **CSRF** : en-tête `X-Studoo: 1` exigé sur toute requête qui modifie (vérifié en ligne : 403 sans lui).
- **Contrôle d'accès** : tâches, générations, quotas et clés filtrés par compte (tests `test_jobs_are_private`,
  `forget-file` limité au compte) ; jetons d'emploi du temps scellés et liés au compte ; **toutes** les routes
  `/api/admin/*` protégées côté serveur.
- **Robots** : mots de passe en `SecretStr`, jamais écrits ni journalisés (test qui inspecte les journaux).
- **Clés Gemini** : chiffrées, liées au compte, jamais renvoyées au navigateur.
- **Envois** : audio (type, taille, vide), `.ics` (3 Mo, 3 000 cours, anti-SSRF), photos OCR (base64, type).
- **XSS** : aucune insertion de HTML venant de l'IA, des transcriptions ou des élèves (tout passe par `textContent`) ;
  les deux seuls `innerHTML` contiennent du texte fixe du code ; liens générés toujours internes (`/fichier/…`).
- **Injections SQL** : requêtes paramétrées (SQLAlchemy).
- **En-têtes** (vérifiés en ligne) : CSP stricte, HSTS (2 ans, preload), `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy`, `Permissions-Policy` ; HTTP → HTTPS (308) ; aucun en-tête CORS pour un autre site ;
  documentation de l'API désactivée en ligne.
- **Secrets** : aucun dans le code ni dans l'historique Git ; aucune clé dans le navigateur (seulement des valeurs
  publiques par nature : identifiant client Google, clé publique VAPID, DSN Sentry).
- **Dépendances** : 0 vulnérabilité connue (npm, pip-audit sur l'API et le serveur de tâches).
- **GitHub Actions** : permissions minimales (`contents: read`, `packages: write` pour l'image seulement).

## Reste à faire ou accepté (honnêtement)

| Gravité | Point | Pourquoi / quoi faire |
|---|---|---|
| Faible | Un cookie de session **volé** reste valable jusqu'à 30 jours, même après déconnexion. | Le vol suppose un accès à l'appareil (le cookie est `HttpOnly`). Supprimer ou bannir le compte coupe la session. Une révocation fine demanderait une table de sessions. |
| Faible | « DNS rebinding » : entre la vérification d'adresse et la connexion, un nom peut changer d'adresse. | Aucune réponse brute n'est renvoyée à l'élève ; risque accepté. |
| Faible | Un fichier `/assets/…` absent renvoie une vraie 404, mais avec l'en-tête de cache d'un an des fichiers à empreinte. | Limite de la configuration Vercel (pas d'en-tête selon le code de réponse) ; sans effet depuis la récupération automatique (C2). |
| Info | Les robots HyperPlanning, Aurion et ADE à identifiants propres n'ont jamais été testés sur un vrai compte. | Marqués « Expérimental » partout. |
| À faire (toi) | Régénérer les clés Azure (Speech, OpenAI) qui ont transité par la conversation de développement. | Voir les étapes manuelles. |

## Ce qui doit rester privé

`.env`, `.env.worker` (jamais dans Git : `.gitignore`), les variables Vercel, les clés Azure, le secret client Google,
`SESSION_SECRET`, `JOB_SECRET`, la clé privée VAPID, la clé Brevo. Le **dépôt lui-même peut rester public** :
l'historique ne contient aucun secret.
