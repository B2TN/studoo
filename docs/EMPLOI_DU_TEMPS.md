# Emploi du temps : récupération automatique (mis à jour le 24/11/2026)

Objectif : l'élève **se connecte à son service**, Studoo **va chercher lui-même** l'emploi du temps et le
garde à jour. Aucun lien à coller, aucun identifiant ni mot de passe stocké : seulement un **jeton chiffré**
(lié au compte Studoo), supprimé par « Déconnecter ».

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
