# SECURITY — Raijin Shield

## Dépendances (`pnpm audit`, `pnpm peers check`)

Relevé du 2026-11-24 (phase 9, T2), Nx 24.0.6, pnpm 11.6.0.

- `pnpm audit --prod` : **0 vulnérabilité** (critère bloquant, vérifié en CI).
- `pnpm audit` (dépendances de développement comprises) : 3 alertes **modérées**, toutes transitives d'outillage,
  absentes des images de production (`dist/apps/*/package.json` générés ne les contiennent pas). Aucune n'est
  corrigée en amont à ce jour (dernières versions de Nx, Jest, test-exclude et sockjs vérifiées) ; un `overrides`
  imposerait une version majeure à des dépendances épinglées exactement par Nx. Décision : **justifiées, non
  surchargées**, revues à chaque montée de Nx ou de Jest.

| Alerte | Paquet (chemin) | Pourquoi elle ne s'applique pas |
|---|---|---|
| GHSA-w5hq-g745-h8pq (modérée) | `uuid` 8.3.2 via `@nx/webpack` → `webpack-dev-server` → `sockjs` | Le défaut touche `v3`/`v5`/`v6` appelées avec un tampon `buf` fourni ; `sockjs` n'appelle que `uuid.v4()` sans tampon. `webpack-dev-server` n'est jamais lancé (API servie par `@nx/js:node`, front par `@angular/build`). |
| GHSA-3g3m-2fjr-6pw4 (modérée) | `glob` 10.5.0 / 13.0.7 via `jest-config`, `test-exclude` | Contournement de l'annulation par `AbortSignal` : Jest et la couverture n'utilisent pas de signal, sur des motifs écrits par le projet, en local et en CI. |
| GHSA-g3hv-75wg-m249 (modérée) | `minimatch` 9.0.9 / 10.2.5 via `nx`, `@nx/devkit` (épinglé `10.2.5`), `glob` | Déni de service par des motifs construits par un attaquant : seuls les motifs de configuration du dépôt (`nx.json`, `project.json`, ESLint) sont évalués, jamais une entrée utilisateur. |

Avertissements de dépendances pairs (`pnpm peers check`), tous d'outillage, sans effet à l'exécution :

| Pair attendu | Installé | Demandé par | Décision |
|---|---|---|---|
| `@babel/core` ^7 | 8.0.5 (via `@angular/build` 22) | plugins `@babel/plugin-syntax-*` de `babel-preset-jest` | Jest utilise son propre `@babel/core` 7.29 (présent) ; le 8 sert uniquement à `@angular/build`. Rien à faire. |
| `chokidar` ^4 / ^6 | 5.0.0 | `@angular-devkit/core` 19 (`@nestjs/schematics`) et 22 | Pair **optionnel** (mode surveillance des schematics) ; aucun schematic NestJS lancé en surveillance. |
| `@emnapi/core`, `@emnapi/runtime` ^1.7.1 | 2.0.0-alpha.6 | `@napi-rs/wasm-runtime` 1.2.7 | Repli WebAssembly des binaires natifs, inutilisé sur linux-x64 (binaires natifs présents). |
