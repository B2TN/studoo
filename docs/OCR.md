# Lecture des copies photographiées (OCR) — tests du 24/11/2026

## Échantillons (publics)
- 5 lignes **manuscrites en français** (jeu RIMES 2011, Teklia, Hugging Face) ;
- 4 **formules manuscrites** (jeu CROHME 2019).

Mesure : **taux d'erreur par caractère (CER)** entre le texte lu et le texte attendu (0 % = parfait).
Machine de test : processeur portable Intel i5-1235U, **sans carte graphique** (le pire cas).

## Résultats

| Outil | Type | Taille | Licence | Manuscrit FR | Formules | Temps / image (CPU) | Mémoire | Sur l'hébergeur gratuit (C1) |
|---|---|---|---|---|---|---|---|---|
| **Qwen3-VL-2B-Instruct** | Vision-langage | 2 Md | Apache 2.0 | **4,4 %** | **10 %** | ≈ 60 s | ≈ 5 Go | ✅ Modal (GPU : quelques s) · ⚠️ plan B CPU : lent |
| **LightOnOCR-3-1B** | Vision-langage spécialisé OCR | 1 Md | Apache 2.0 | **0 %** | 67 % | ≈ 32 s | ≈ 3 Go | ✅ Modal · ✅ plan B CPU |
| RapidOCR (PP-OCR) | OCR classique | < 0,1 Md | Apache 2.0 | 43 % | 100 % (rien lu) | ≈ 1,6 s | < 0,5 Go | ✅ partout |
| PaddleOCR-VL-1.6 | Vision-langage | 0,9 Md | Apache 2.0 | non testable ici ¹ | — | — | — | — |
| olmOCR-2 (7B) | Vision-langage | 7 Md | Apache 2.0 | non testé ² | — | — | ≈ 16 Go | ✅ Modal GPU seulement |

¹ Le code du modèle n'est pas compatible avec la version actuelle de Transformers (il demande l'environnement PaddlePaddle).
² Trop gros pour ce PC ; donné comme le meilleur open source en manuscrit par plusieurs comparatifs 2026.

**Limites du test :** 9 images seulement, lignes isolées (pas de pages entières, pas de schémas ni de ratures).
Ce sont des indications, pas un classement définitif.

## Recommandation
- **Principal : Qwen3-VL** (2B testé ; sur le GPU du serveur de tâches, la version 8B, plus précise, lit une page en quelques secondes).
  C'est le seul testé qui lit bien **à la fois** l'écriture française et les maths (sortie en LaTeX).
- **Plan B plus léger : LightOnOCR-3-1B** — parfait sur le texte manuscrit, deux fois plus rapide, tourne sur un simple CPU,
  mais faible sur les formules isolées : idéal pour les cours numérisés, moins pour les copies de maths.
- **Toujours** : prétraitement de la photo (détection de la feuille, redressement, recadrage, contraste — déjà dans
  `frontend/src/lib/scan-core.js`) **puis relecture par l'élève** : le texte lu s'affiche dans une zone modifiable
  avant d'être utilisé (déjà en place pour « Numériser », réutilisé pour la correction des copies).
