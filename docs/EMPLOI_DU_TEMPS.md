# Emploi du temps : le robot de connexion (mis à jour le 26/11/2026, itération 4)

Règle : **seule l'option « Dernier recours : .ics » demande un lien ou un fichier**. Pour les autres, l'élève
tape son identifiant et son mot de passe, et le **robot** de Studoo (côté serveur) va chercher l'emploi du temps.

## Comment marche le robot (lycées)
1. L'élève cherche son lycée dans l'**annuaire officiel** de l'Éducation nationale (`data.education.gouv.fr`,
   données publiques) → Studoo obtient son code **UAI**.
2. Adresse Pronote déduite du code : `https://<uai>.index-education.net/pronote/eleve.html` (aucun lien à coller).
3. **ENT reconnu tout seul** : la page élève redirige vers la page de connexion de l'ENT régional
   (ex. `mon.lyceeconnecte.fr`, `ent.l-educdenormandie.fr`) ; Studoo associe cette adresse au bon connecteur
   de `pronotepy` (42 connecteurs lus dans la bibliothèque). Au plus 2 essais (variante élève / EduConnect).
4. Connexion, récupération des cours, puis :
   - **lien iCal officiel** du compte gardé chiffré dans le Drive → à jour pour toujours, sans mot de passe ;
   - sinon **copie des cours** dans le Drive + **rappel de reconnexion toutes les 2 semaines** (choix du 26/11).

**Mot de passe :** il n'existe que dans la mémoire de la requête (fonction Vercel, région Paris, 2 min au plus) :
jamais écrit en base, dans un fichier, un journal ou un rapport d'erreur (type `SecretStr`, erreurs de saisie
renvoyées sans les valeurs, journaux de `pronotepy` coupés). Il disparaît à la fin de la requête dans **tous**
les cas : réussite, échec, délai dépassé, plantage. C'est plus strict que « stocké chiffré puis supprimé » :
il n'y a rien à supprimer.

**Erreurs expliquées à l'élève :** mot de passe incorrect · double authentification (le robot ne peut pas la
passer → dernier recours) · ENT non reconnu (ex. EduConnect seul) · service en maintenance / qui ne répond pas ·
lycée sans Pronote hébergé chez Index Éducation.

Vérifié le 26/11/2026 : annuaire (Lycée Lavoisier Paris → 0750656F) ; redirections réelles de 3 lycées
(Paris : Pronote direct ; Brive : Lycée connecté ; Le Havre : L'Educ de Normandie) ; vraie connexion au Pronote
de démonstration d'Index Éducation (0,7 s, lien iCal obtenu).

## Ce qui peut casser
- `pronotepy` est **non officiel** : une mise à jour de Pronote ou d'un ENT peut le casser du jour au lendemain.
- Certains ENT bloquent les adresses de serveurs étrangers : les fonctions du site tournent à **Paris** (Vercel `cdg1`).
- Les comptes avec **double authentification obligatoire** ne passent pas.

## Supérieur : chercher son établissement, le robot fait le reste (26/11/2026)
1. **Recherche** dans l'annuaire officiel du ministère (`fr-esr-principaux-etablissements-enseignement-superieur`,
   245 établissements, champ `url`) + composantes connues (IUT de Paris – Rives de Seine…).
2. **Détection du logiciel** : essais en parallèle d'adresses habituelles sur le domaine de l'établissement
   (`ade.`, `adeconsult.app.`, `edt.`, `planning.`, `celcat.`, `hp.`…) ; reconnaissance par la réponse.
   Relevé réel : Paris Cité, Aix-Marseille, Lyon 1, Rennes, Côte d'Azur, INSA Lyon → ADE ; Bordeaux (public),
   Toulouse III (connexion) → Celcat. Non reconnus automatiquement : Lille, Nantes, Strasbourg, Lorraine,
   Sorbonne, Saclay, UPEC… → dernier recours guidé (liste d'adresses connues à compléter dans `services/higher.py`).
3. **Robots** :
   - **ADE** (connexion CAS/Shibboleth/SAML, voir ci-dessous) ; les ADE à identifiants propres (Grenoble,
     Montpellier) sont reconnus mais pas encore pris en charge ;
   - **Celcat Calendar** : recherche du groupe (`Home/ReadResourceListItems`, type 103) et cours
     (`Home/GetCalendarData`) — sans identifiant quand l'établissement les publie (Bordeaux), sinon après connexion
     (copie des cours + rappel de reconnexion, la session ne dure pas) ;
   - **HyperPlanning, Aurion** : reconnus, pas de robot (protocoles propriétaires non testables sans compte) →
     dernier recours avec les étapes propres au logiciel.

## Robot ADE (26/11/2026)
ADE ne donne pas l'emploi du temps de l'étudiant : il faut choisir l'**année** (« projet »), puis descendre
**établissement → filière → classe**. Le robot reproduit ce parcours avec l'étudiant :
1. **Connexion** par la page officielle de l'université (CAS Apereo ou Shibboleth : page « Loading Session »,
   champs `j_username`/`j_password`, `_eventId_proceed`). Seule étape qui utilise le mot de passe.
   Erreurs reconnues : mot de passe refusé, double authentification, page inconnue.
2. **ADE parlé comme son interface** (GWT-RPC) : `getInitialConfiguration` + `login` (enregistre l'identifiant de
   client, sans quoi ADE répond « identifiant invalide »), `getProjectList`, `loadProject`, `getChildren`.
   Les noms forts, numéros de méthode et signatures de types sont **relus dans le code d'ADE** à chaque connexion.
3. Entre deux étapes, seule la **session ADE** (cookie, 25 min max) circule, chiffrée, liée au compte Studoo ;
   elle n'est enregistrée nulle part.
4. Classe choisie → lien d'export officiel `…/jsp/custom/modules/plannings/anonymous_cal.jsp?resources=<id>&projectId=<n>&calType=ical&nbWeeks=20`,
   **lisible sans identifiant** et glissant (vérifié : 57 cours sur 4 semaines pour la classe 101 du département
   INFO de l'IUT, sans session). C'est lui seul qui est gardé (chiffré, dans le Drive).

Testé le 26/11/2026 sur l'ADE de l'Université Paris Cité (ADE 2025.1), session ouverte par l'utilisateur dans
le navigateur : chaque appel construit par le robot a été accepté par ADE (12 classes de « INFO 1ère année »).
Universités préconfigurées « en test » (même ADE derrière un CAS, non essayées avec un vrai compte) :
Aix-Marseille, Lyon 1, Rennes, Tours, Artois. Les autres : dernier recours guidé.

## Historique (itérations 2 et 3)
## Service par service

| Service | Comment Studoo récupère l'emploi du temps | Testé depuis le serveur | Fiabilité | État |
|---|---|---|---|---|
| **Pronote (compte direct)** | Bibliothèque non officielle `pronotepy` : QR code (aucun mot de passe) ou identifiant + mot de passe (utilisé une fois). Studoo garde le **lien iCal officiel** du compte (fonction Pronote 2024+), chiffré, puis le relit à chaque visite. | ✅ vraie connexion au Pronote de démonstration depuis Vercel (Paris) : 132 cours en 0,6 s, lien iCal obtenu | Bonne, mais peut casser lors d'une mise à jour de Pronote | **Automatique** |
| **Monlycée.net (Île-de-France)** | `pronotepy` + connexion à l'ENT (`ent.ile_de_france`) avec les identifiants Monlycée.net, puis même chose que Pronote | ✅ ENT joignable | Moyenne (le portail a changé d'adresse en 2025) | **Automatique** (à confirmer avec un vrai compte) |
| **Mon Bureau Numérique (Grand Est)** | `pronotepy` + `ent.monbureaunumerique` | ✅ joignable **depuis Paris** (bloqué depuis les États-Unis → fonctions déplacées à Paris) | Moyenne | **Automatique** (à confirmer) |
| **ENT Hauts-de-France** | `pronotepy` + `ent.ent_hdf` | ✅ | Moyenne | **Automatique** (à confirmer) |
| **Toutatice (Bretagne)** | `pronotepy` + `ent.ac_rennes` | ✅ **depuis Paris** (délai dépassé depuis les États-Unis) | Moyenne | **Automatique** (à confirmer) |
| **Éclat-BFC, Atrium + 20 autres ENT** | `pronotepy` (26 ENT proposés) | non testé un par un | Variable | **Automatique** (à confirmer) |
| **Skolengo** | Si le lycée utilise Pronote : QR code Pronote. Pas de connecteur Skolengo dans `pronotepy`. | — | — | Automatique via Pronote, sinon **dernier recours `.ics`** |
| **ÉcoleDirecte** | Aucun export iCal, pas de connecteur fiable maintenu. | — | — | **Dernier recours `.ics`** (dit clairement dans le site) |
| **Universités ADE** (Paris Cité / IUT Rives de Seine, Aix-Marseille, Lyon 1, Rennes, Montpellier…) | Connexion au **CAS de l'université** (mot de passe utilisé une fois), ouverture de la page personnelle **ADE « MyPlanning »**, puis export iCal. MyPlanning est une application GWT : il faut piloter un **navigateur invisible (Playwright)**, trop lourd pour Vercel → tourne sur le **serveur de tâches (C1)**. Studoo garde le lien d'export ADE (il se lit sans identifiant), chiffré. | ✅ ADE Paris Cité joignable, redirige bien vers `auth.u-paris.fr` ; MyPlanning existe à Paris Cité, Lyon 1, Rennes, Montpellier | Moyenne (même interface ADE partout) ; **impossible si l'université impose la double authentification** | **En attente du serveur de tâches** ; dernier recours `.ics` en attendant |
| **Universités Celcat** (Bordeaux…) | Connexion CAS puis API JSON de Celcat (`GetCalendarData`) | ✅ Celcat Bordeaux joignable | Moyenne | **En attente du serveur de tâches** |
| **Autres universités** | Même moteur générique CAS + ADE/Celcat, à activer université par université | — | — | À ajouter (il suffit de l'adresse de leur ADE / Celcat) |

Adresses ADE vérifiées le 24/11/2026 (redirection vers le CAS de l'université) :
`adeconsult.app.u-pariscite.fr` · `ade-web-consult.univ-amu.fr` · `adelb.univ-lyon1.fr` · `planning.univ-rennes.fr` ·
`proseconsult.umontpellier.fr` · `ade-uga-ro-vs.grenet.fr` · Celcat : `celcat.u-bordeaux.fr`.

## Sécurité
- Mot de passe : type `SecretStr` (jamais affiché), utilisé en mémoire pour ouvrir la session, **jamais stocké ni journalisé**.
- Jeton gardé : lien iCal (ou jeton de reconnexion Pronote), **chiffré** (Fernet, clé serveur) et lié au compte Studoo.
- « Déconnecter » supprime le jeton. Pour couper aussi côté école : régénérer le lien iCal dans Pronote/ADE.
- Diagnostic public : `/api/health/connecteurs` (joignabilité depuis le serveur + connexion au Pronote de démonstration).

## Risques
- Connecteurs **non officiels** (zone grise vis-à-vis des conditions d'Index Éducation et des régions) ;
  une mise à jour d'un portail peut les casser du jour au lendemain.
- Certains services filtrent les serveurs étrangers : les fonctions Studoo tournent donc **à Paris** (`cdg1`).
