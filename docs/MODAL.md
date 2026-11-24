# Mettre en ligne le serveur de tâches (Modal)

Le serveur de tâches fabrique les podcasts, vidéos et lectures de copies avec des outils open source
(Qwen3-4B pour écrire, Kokoro/Piper pour les voix, ffmpeg pour le montage, Qwen3-VL pour lire).

Sur **Modal**, rien ne tourne au repos :
- dès qu'une tâche est créée sur Studoo, l'API appelle l'adresse **kick** → une machine de 8 vCPU / 8 Go démarre,
  fait tout le travail en attente, puis s'éteint ;
- toutes les 10 min, une toute petite fonction **watch** vérifie s'il reste du travail (relances, appel manqué)
  et ne démarre la grosse machine que si c'est le cas ;
- les modèles (≈ 3 à 7 Go) sont gardés dans un **volume** `studoo-models` : ils ne sont téléchargés qu'une fois.

Tout tourne dans la région **« eu »** (Espace économique européen), pour le RGPD.

## 1. Créer le compte (à faire toi-même)
1. <https://modal.com> → **Sign up** (avec GitHub). Offre **Starter** : 30 $ de calcul offerts chaque mois.
2. Ajoute ta carte quand Modal la demande.
3. Dans **Settings → Usage & Billing**, si Modal propose une limite de dépenses, mets **30 $** :
   tu ne paieras jamais plus que le crédit offert. (Je n'ai pas pu vérifier le nom exact de ce réglage.)

## 2. Relier ton PC à ton compte (une seule fois)
Dans un terminal, à la racine du projet :

```powershell
python -m pip install modal
```

```powershell
python -m modal setup
```

(une page s'ouvre dans le navigateur : accepte.)

## 3. Donner les clés au serveur
1. Ouvre **`.env.worker`** (à la racine, jamais envoyé sur GitHub). Il contient déjà `JOB_SECRET`, `VAPID_*`.
   Complète `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (les mêmes que dans Vercel).
2. Envoie-le à Modal comme « secret » :

```powershell
python -m modal secret create studoo-worker --from-dotenv .env.worker
```

(pour le modifier plus tard : même commande avec `--force` à la fin.)

## 4. Déployer

```powershell
python -m modal deploy worker/modal_app.py
```

La première fois, la construction de l'image prend quelques minutes. À la fin, Modal affiche une adresse du type
`https://TON-NOM--studoo-worker-kick.modal.run` : c'est l'adresse **kick**.

## 5. Brancher le site (Vercel → studoo → Settings → Environment Variables)
- `JOB_SECRET` = la même valeur que dans `.env.worker` (type *Sensitive*) ;
- `VAPID_PUBLIC_KEY` = la même valeur que dans `.env.worker` ;
- `WORKER_KICK_URL` = l'adresse **kick** affichée à l'étape 4.

Puis **Redeploy**.

## 6. Vérifier
- Sur Studoo, lance un podcast de 10 min : il apparaît dans « Mes générations », passe *En cours* en quelques
  secondes (sinon au plus tard 10 min après), avec sa progression.
- Sur <https://modal.com/apps> → `studoo-worker` → `process` → **Logs** : « Tâche … (podcast), essai 1 » puis « terminée ».
  (Les journaux ne contiennent jamais le contenu des cours ni de jeton.)
- La toute première tâche est plus lente : elle télécharge les modèles dans le volume.

## Temps et coût
Mesuré sur PC avec 2 cœurs le 24/11/2026 : vidéo courte (≈ 1 min 45) **4 min**, podcast 10 min **18 min**.
La machine Modal a 8 vCPU : compter *environ* 2 fois plus vite (estimation, pas encore mesurée sur Modal).

Prix Modal (page tarifaire, 24/11/2026) : 0,0000131 $ par cœur physique (2 vCPU) et par seconde,
0,00000222 $ par Go et par seconde, × 1,15 pour la région « eu ».
La grosse machine coûte donc ≈ **0,29 $ de l'heure** → les **30 $ offerts ≈ 100 heures de calcul par mois**
(≈ 0,05 à 0,10 $ par podcast de 10 min). Les petites fonctions `watch` et `kick` coûtent quelques centimes par mois.

## En cas de problème
- **« region » refusée au déploiement** : ton offre ne permet pas de choisir la région → dans
  `worker/modal_app.py`, remplace `REGION = "eu"` par `REGION = None`, puis redéploie.
- **La construction échoue sur `ghcr.io/ggml-org/llama.cpp:server-b12674`** : remplace ce tag par
  `ghcr.io/ggml-org/llama.cpp:server` dans `worker/Dockerfile`.
- **Rien ne démarre** : vérifie `WORKER_KICK_URL` dans Vercel, puis attends 10 min (vérification automatique).
