# bench-web-logic (`@raijin/bench-web-logic`)

Logique pure du front du banc (`apps/raijin-banc-de-test`) : modèles et lecture des lignes de l'API,
calculs (backtest, performance, presets, portefeuille simulé, graphe de prix, alertes, coût
aller-retour), formatage français. TypeScript pur : ni Angular, ni API Node, ni réseau, ni horloge
implicite. L'app ne garde que l'affichage (composants, stores, client HTTP et SSE). Décision :
`docs/ARCHITECTURE.md` §17.2 (exceptions §17.8).

Tags `scope:bench`, `type:util`. Aucun projet Raijin ne l'importe.

`NX_DAEMON=false pnpm nx run-many -t lint typecheck test build -p bench-web-logic`

## Points d'entrée
| Import | Contenu |
|---|---|
| `@raijin/bench-web-logic` | modèles `token`, `paper` ; utilitaires `format`, `stake`, `decimal`, `roundtrip-cost`, `solana-address`, `safe-url`, `visuals`, `email` |
| `@raijin/bench-web-logic/opportunities` | filtres, signaux, sources de liquidité, aller-retour, affichage du jeton, données du graphe de prix |
| `@raijin/bench-web-logic/alerts` | journal, vue et simulation des alertes |
| `@raijin/bench-web-logic/strategy-lab` | backtest, rattrapage, synthèse et format du labo |
| `@raijin/bench-web-logic/portfolio` | carnet, statistiques, courbe de solde, glissement des stops, libellés |
| `@raijin/bench-web-logic/performance` | ventilation, presets, comparaison des carnets, statistiques |
| `@raijin/bench-web-logic/paper-trade` | stratégie de trade simulé |
| `@raijin/bench-web-logic/settings` | réglages d'alerte |
| `@raijin/bench-web-logic/shadow` | comparaison en mode ombre |
| `@raijin/bench-web-logic/verdict-quality` | format du rapport de justesse |
| `@raijin/bench-web-logic/testing` | fabriques de lignes pour les specs (jamais importé par le code de production) |

Les fonctions de formatage homonymes (`formatPct`, `formatCount`, `formatMultiple`, `formatSignedSol`)
vivent dans des points d'entrée distincts : c'est la raison du découpage.
