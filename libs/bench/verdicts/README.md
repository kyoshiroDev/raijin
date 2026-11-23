# bench-verdicts (`@raijin/bench-verdicts`)

Mesure de la justesse des verdicts de Raijin pour le banc de test (phase 7 bis, PROMPT.md §4.8) :
contrats du suivi à 24 h / 72 h / 7 j, classification des issues, métriques de justesse, rejeu de
variantes du moteur, rétention et alerte de taille de base. TypeScript pur, sans I/O ni horloge.

Tags `scope:bench`, `type:util` : lisible par le banc seulement (aucun projet Raijin ne l'importe).
Décisions : `docs/ARCHITECTURE.md` §16. Persistance et jobs de suivi : phase 8 bis.

`pnpm nx run-many -t lint typecheck test -p bench-verdicts`
