# Emploi du temps : ce qui est réellement faisable (vérifié le 24/11/2026)

Aucun de ces services n'a d'API publique officielle, et aucun ne propose une connexion de type
« OAuth » (comme « Se connecter avec Google ») qui renverrait un jeton à un site extérieur.
Studoo utilise donc trois techniques, de la plus sûre à la moins sûre :

| Technique | Mot de passe transite par Studoo ? | Ce qui est gardé | Durée de vie |
|---|---|---|---|
| **Lien iCal** (copié depuis la page officielle) | Non : tu te connectes sur le site officiel | Le lien, **chiffré** | Tant que tu ne le régénères pas (souvent toute l'année) |
| **QR code Pronote** | Non (code PIN à 4 chiffres seulement) | Le lien iCal du compte, ou à défaut le jeton de reconnexion Pronote, **chiffré** | Jeton renouvelé à chaque synchro |
| **Identifiants** (Pronote ou ENT régional) | **Oui, une seule fois**, en HTTPS, en mémoire | Le lien iCal du compte, **chiffré** (jamais le mot de passe) | Celle du lien iCal |

**Chiffrement :** clé connue du seul serveur, jeton lié à ton compte Studoo (inutilisable par un autre compte).
**Journaux :** les mots de passe sont typés `SecretStr`, les messages détaillés de la bibliothèque sont coupés.
**Révocation :** « Déconnecter » supprime le jeton de ton Drive. Pour couper aussi côté école,
régénère ton lien iCal dans Pronote/ADE (l'ancien cesse de marcher).

## Service par service

| Service | QR code | Identifiants | Lien iCal | Remarques |
|---|---|---|---|---|
| **Pronote (compte direct)** | ✅ | ✅ identifiants Pronote | ✅ Pronote 2024+ | Bibliothèque non officielle `pronotepy` (MIT, en maintenance). |
| **Monlycée.net (Île-de-France)** | ✅ | ✅ via `ent.ile_de_france` | ✅ | Le site a changé d'adresse en 2025 : risque de casse si le portail change encore. |
| **Mon Bureau Numérique (Grand Est)** | ✅ | ✅ via `ent.monbureaunumerique` | ✅ | |
| **ENT Hauts-de-France** | ✅ | ✅ via `ent.ent_hdf` | ✅ | |
| **Toutatice (Bretagne)** | ✅ | ✅ via `ent.ac_rennes` | ✅ | |
| **Éclat-BFC, Atrium, + 20 autres ENT** | ✅ | ✅ (liste « Autre ENT régional ») | ✅ | 26 ENT proposés, pris dans les 43 de `pronotepy`. |
| **Skolengo** | ✅ si Pronote | ❌ non pris en charge | ✅ si Pronote | Pas de connecteur Skolengo dans `pronotepy`. |
| **ÉcoleDirecte** | ❌ | ❌ | ❌ | Pas d'export iCal ; seulement l'import d'un fichier `.ics`. |
| **IUT de Paris – Rives de Seine / Université Paris Cité (ADE)** | — | ❌ volontairement | ✅ | Connexion sur la page officielle (CAS `auth.u-paris.fr`), puis « Export Agenda → Générer URL ». Le lien `anonymous_cal.jsp` se lit sans identifiant (vérifié : le serveur ADE 6.16 répond publiquement). |
| **19 autres universités** | — | ❌ | ✅ | Même principe (ADE, Celcat, HyperPlanning). |

### Pourquoi pas de connexion par mot de passe pour les universités ?
La connexion CAS des universités (souvent avec double authentification) changerait d'une
université à l'autre, je ne peux pas la tester sans comptes, et elle ferait transiter ton
mot de passe universitaire (qui ouvre aussi ta messagerie, tes notes…) par le serveur. Le lien
d'export donne exactement le même résultat **sans aucun mot de passe**.

### « Teste tout » : ce que fait Studoo avec un lien ADE
1. Le lien tel quel, avec les dates prolongées automatiquement (aujourd'hui −14 j → +180 j).
2. Le même lien en forçant `calType=ical`.
3. La version « 26 semaines glissantes » (`nbWeeks=26`), qui ne périme jamais.
4. La version `https://` si le lien était en `http://`.

La première version qui renvoie un vrai calendrier est gardée (chiffrée).

### Risques
- **Conditions d'utilisation** : les connecteurs Pronote/ENT ne sont ni officiels ni autorisés
  explicitement par Index Éducation ou les régions (zone grise). Le lien iCal, lui, est une
  fonction officielle prévue pour être utilisée dans un agenda.
- **Casse** : une mise à jour de Pronote ou d'un portail ENT peut casser la connexion par
  identifiants ou QR code du jour au lendemain. Le lien iCal reste la méthode de secours.
