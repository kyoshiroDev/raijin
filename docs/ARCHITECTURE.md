# Architecture — Raijin Shield

Monorepo **Nx** (pnpm, sans Nx Cloud), mode « integrated » : un seul `package.json`
racine (une seule version de chaque dépendance), alias TypeScript `@raijin/...`
déclarés dans `tsconfig.base.json`.

Graphe Nx : **non commité** (≈ 6 Mo, régénérable ; `docs/graph.html` et `docs/static/` sont
dans `.gitignore`). Pour le consulter : `pnpm nx graph` (navigateur) ou
`pnpm nx graph --file=docs/graph.html` (fichier local).

## 1. Structure

| Projet | Dossier | Rôle | Tags |
|---|---|---|---|
| `web` | `apps/web` | App Angular (standalone, zoneless, signals, routes lazy, PWA) | `scope:web`, `type:app` |
| `web-e2e` | `apps/web-e2e` | Playwright : e2e, responsive, axe, captures | `scope:web`, `type:app` |
| `api` | `apps/api` | API NestJS 11 (`/api/v1`) | `scope:api`, `type:app` |
| `api-e2e` | `apps/api-e2e` | Tests e2e de l'API (Jest) | `scope:api`, `type:app` |
| `landing` | `apps/landing` | Landing Astro 5 (SEO, zéro JS par défaut) | `scope:landing`, `type:app` |
| `brand` | `libs/brand` | Tokens, logos, icônes, mascotte (fourni) | `scope:shared`, `type:brand` |
| `shared-contracts` | `libs/shared/contracts` | Schémas Zod + types du contrat API | `scope:shared`, `type:contracts` |
| `shared-util` | `libs/shared/util` | Formatage (montants, adresses), base58 | `scope:shared`, `type:util` |
| `shared-risk-engine` | `libs/shared/risk-engine` | Moteur de verdict pur (TS sans Node/Deno) | `scope:shared`, `type:util` |
| `web-ui` | `libs/web/ui` | Composants de base (Button, VerdictBadge…) + thème Tailwind | `scope:web`, `type:ui` |
| `web-data-access` | `libs/web/data-access` | Services HTTP, stores signals | `scope:web`, `type:data-access` |
| `web-feature-analyse` | `libs/web/feature-analyse` | Analyse, page publique `/t/<mint>` | `scope:web`, `type:feature` |
| `web-feature-suivis` | `libs/web/feature-suivis` | Suivis et alertes | `scope:web`, `type:feature` |
| `web-feature-wallet` | `libs/web/feature-wallet` | Scan de wallet | `scope:web`, `type:feature` |
| `web-feature-compte` | `libs/web/feature-compte` | Auth, compte, abonnement | `scope:web`, `type:feature` |
| `api-auth` … `api-solana` | `libs/api/*` | Modules Nest (auth, users, billing, alerts, notifications, solana) | `scope:api`, `type:feature` |
| `raijin-banc-de-test` | `apps/raijin-banc-de-test` | Front Angular 22 zoneless du banc (importé de `raijin-old`, phase 1 bis) | `scope:bench`, `type:app` |

Prévus plus tard : `raijin-banc-de-test-api` (phase 8 bis), `libs/bench/*` (`scope:bench`),
`libs/web/feature-admin`, `libs/api/admin`, `libs/api/analytics`.

### Hors Nx : `legacy/`

`legacy/` contient la référence en lecture seule de l'ancien scanner (`supabase/`, `scripts/`,
`docs/`, `vercel.json` ; voir `legacy/README.md`). Ce n'est **pas** un projet Nx : ignoré par
`.nxignore` (et `.prettierignore`), rien n'y est linté, testé ni buildé, et aucun projet ne
l'importe (un import relatif serait refusé par `@nx/enforce-module-boundaries`). Supprimé après
la bascule du banc (phase 8 bis).

## 2. Frontières (`@nx/enforce-module-boundaries`, bloquante, dans `eslint.config.mjs`)

Par **type** :
- `type:app` → tout type (les apps restent fines : routes, bootstrap, configuration).
- `type:feature` → `feature`, `ui`, `data-access`, `util`, `contracts`, `brand`.
- `type:ui` → `ui`, `util`, `brand` (et rien d'autre : pas de data-access, pas de feature).
- `type:data-access` → `data-access`, `util`, `contracts`.
- `type:util` → `util`, `contracts`.
- `type:contracts` → `contracts`, `util`.
- `type:brand` → rien.

Par **scope** :
- `scope:web` → `web`, `shared` (jamais `api`).
- `scope:api` → `api`, `shared` (jamais `web`).
- `scope:landing` → `landing`, `shared`.
- `scope:shared` → `shared` uniquement.
- `scope:bench` → `bench`, `shared`.
- **Aucun projet Raijin ne dépend de `scope:bench`** (aucune règle ne l'autorise ; seul `scope:bench` lui-même le peut).

Note : les modules Nest de `libs/api/*` sont taggés `type:feature` (ils jouent le rôle de
« feature » côté serveur et peuvent dépendre de `util`, `contracts` et d'autres modules Nest).

## 3. Conventions

- **Imports** : toujours par alias `@raijin/<scope>-<nom>` (ex. `@raijin/shared-contracts`,
  `@raijin/web-ui`), jamais de chemin relatif entre projets.
- **TypeScript strict** partout (`strict`, `noUncheckedIndexedAccess`,
  `noPropertyAccessFromIndexSignature`, `noImplicitOverride`).
- **Contrat unique** : tout type échangé entre front et back est un schéma Zod de
  `libs/shared/contracts` ; les types sont dérivés par `z.infer`. Aucun type dupliqué.
- **Apps fines** : aucune logique métier dans `apps/*`.
- **Cibles** : chaque projet de code expose `lint`, `test`, `typecheck`, `build`, toutes en cache
  Nx (`nx.json` → `targetDefaults`). Exceptions assumées : les projets e2e (`web-e2e`, `api-e2e`)
  exposent `lint`, `typecheck` et `e2e` (pas de build ni de test unitaire) ; `brand` (assets seuls)
  expose `lint`, qui vérifie la cohérence `tokens.json` ↔ `tokens.css` et la présence des icônes
  (`tools/scripts/check-brand-tokens.mjs`, lecture seule).
- **typecheck** : `tsc --noEmit` sur chaque tsconfig du projet (app/lib + spec) ; `astro check`
  pour la landing. Les templates Angular sont vérifiés par le build (`strictTemplates`).
- **Libs partagées** (`libs/shared/*`) : TypeScript pur, `lib: es2022`, aucun type Node ;
  ESLint y interdit les modules Node (`node:*`, `fs`…), Deno (`npm:`, `jsr:`) et les globaux
  `process`, `Buffer`, `Deno`, `require`.
- **Tests** : Jest pour l'API et les libs `api`, Vitest pour Angular et les libs partagées,
  Playwright pour l'e2e.
- **Nommage** : fichiers en kebab-case, sélecteurs Angular préfixés `rj-`.

### Exceptions assumées du banc (`raijin-banc-de-test`)

Code d'origine importé tel quel pour ne pas modifier le comportement des calculs avant la mesure :
- `noUncheckedIndexedAccess: false` dans le **seul** `apps/raijin-banc-de-test/tsconfig.json`
  (289 erreurs d'indexation dans le code d'origine, qui ne l'activait pas) ; les autres options
  strictes restent actives, `strictTemplates` compris. Correction prévue au portage (8 bis).
- **Thème d'origine conservé** (`apps/raijin-banc-de-test/src/styles.css`, Tailwind 4 limité à
  ses propres sources par `source(".")`, police Inter auto-hébergée, CSP `font-src 'self'`) : il
  n'importe pas `libs/brand/tokens.css`. Seule contrainte vérifiée : sa couleur `warn` (badge
  « BANC DE TEST ») est identique au token `warn` de `libs/brand` (`bench-badge.spec.ts`).
- Sélecteurs `app-` conservés ; aucune règle ESLint désactivée.
- Cible supplémentaire `write-env` : génère `src/environments/environment.local.ts` (ignoré par
  Git, clés publiques uniquement) ; configuration `local` pour `build`/`serve` (port 4300).

## 4. Styles et thème

- `libs/brand/tokens.css` est la **source unique** des tokens (`@theme` Tailwind 4).
- `libs/web/ui/src/styles/theme.css` est le **point d'entrée unique du thème** côté Angular :
  il importe Tailwind, `libs/brand/tokens.css`, déclare les sources Tailwind (apps/web et libs/web)
  et les utilitaires de base. `apps/web/src/styles.css` n'importe que ce fichier.
- La landing Astro (`apps/landing/src/styles/global.css`) importe la même chaîne :
  `theme-reset.css` → `libs/brand/tokens.css` → `extras.css` (même source de vérité, plugin
  `@tailwindcss/vite`).
- `theme-reset.css` désactive les palettes par défaut de Tailwind (couleurs, polices, tailles de
  texte, rayons, ombres) : `bg-red-500`, `rounded-xl` ou `text-2xl` ne produisent rien.
  `extras.css` ajoute les valeurs dérivées de la charte : grille `--spacing: 4px`, `rounded-full`,
  `ease-raijin` (`cubic-bezier(.2,.8,.2,1)`), `max-w-reading` (1200 px).
- Utilitaires ajoutés dans `libs/web/ui/src/styles/extras.css` (phase 1, composants) :
  variante `xs:` (`--breakpoint-xs: 360px`, seuil du logotype complet), `text-input`
  (16 px / 24 px, évite le zoom iOS sur les champs), marges de zones sûres `pt-safe`, `pb-safe`,
  `pl-safe`, `pr-safe` (`env(safe-area-inset-*)`), `pb-tabbar` et `bottom-tabbar` (espace réservé
  à la barre d'onglets mobile, calculé sur la grille `--spacing`).
- Utilitaires générés par les tokens : `bg-base`, `bg-surface`, `bg-surface-raised`,
  `text-ink`, `text-ink-muted`, `bg-thunder`, `text-on-thunder`, `text-safe|warn|danger|info`,
  `border-line`, `rounded-sm|md|lg`, `font-display|sans|mono`, `text-display|h1|h2|h3|body|body-sm|label|metric|data`,
  `shadow-card`, `shadow-glow`. **Aucune valeur de couleur, taille ou rayon en dur.**
- Polices : Space Grotesk, Inter, JetBrains Mono, chargées par l'`@import` Google Fonts
  (`display=swap`) de `tokens.css`, avec préconnexion dans `apps/web/src/index.html` et le layout Astro.
- PWA : `apps/web/public/manifest.webmanifest` (« Raijin Shield » / « Raijin », `#07090d`,
  standalone) ; les icônes sont copiées au build depuis `libs/brand/icons` (aucune copie dans le dépôt).
- `/_design` : route déclarée seulement si `isDevMode()` (absente des builds de production),
  composant `DesignPage` dans `libs/web/ui`.

- Icônes : paquet **`lucide`** (ISC, icônes en données `IconNode`), rendues par le composant
  maison `rj-icon` de `libs/web/ui` ; seules les icônes nommées dans
  `libs/web/ui/src/lib/icon/icons.ts` entrent dans le bundle. `lucide-angular` est écarté :
  incompatible avec Angular 22 (dépendances pairs `@angular/core` 13.x à 21.x en 1.0.0).

## 5. Graphiques de l'admin : Chart.js 4

Choix : **Chart.js 4**, importé de façon modulaire (tree-shaking : seuls les contrôleurs
`line`, `bar`, `doughnut` et les échelles nécessaires sont enregistrés), chargé uniquement dans
la lib lazy `libs/web/feature-admin`.
- Léger une fois réduit (≈ 50 à 60 ko gzip pour line + bar + doughnut), aucun coût sur le reste de l'app.
- Couvre tous les besoins de l'admin : tendances (line), entonnoir (bar horizontal),
  répartitions des verdicts (doughnut), comparaison de périodes.
- Rendu canvas responsive, lisible à 360 px ; `prefers-reduced-motion` respecté (animations coupées).
- Thème : les couleurs sont lues dans les variables CSS des tokens (`getComputedStyle`) :
  `thunder` pour la série principale, `info` pour la comparaison, `safe|warn|danger` pour les verdicts.
  Aucune couleur en dur.
- Pas de wrapper Angular tiers : un composant `rj-chart` maison (signals) suffit.
- Écartés : ECharts (trop lourd), uPlot (pas de doughnut ni de barres horizontales natives),
  D3 (trop bas niveau pour le besoin).

## 6. CI

`.github/workflows/ci.yml` : sur push `dev` et PR vers `main`, `nx affected -t lint typecheck
test build` (avec `nrwl/nx-set-shas`), cache pnpm et cache `.nx/cache`, `concurrency` avec
annulation des exécutions obsolètes. E2E Playwright uniquement sur les PR vers `main`,
artefacts de captures envoyés seulement en cas d'échec.

- pnpm : version imposée par `packageManager` du `package.json` (lue par `pnpm/action-setup`),
  Node 22, `pnpm install --frozen-lockfile`.
- Scripts d'installation (pnpm 11, clé `allowBuilds` de `pnpm-workspace.yaml`) : chaque paquet
  doté d'un script doit être listé, sinon l'installation échoue (`ERR_PNPM_IGNORED_BUILDS`).
  Autorisés : `nx`, `@swc/core` (postinstall du binaire natif). Refusés : `esbuild`,
  `@parcel/watcher`, `unrs-resolver`, `lmdb`, `msgpackr-extract`, `@nestjs/core` (binaires
  fournis par les dépendances optionnelles, scripts inutiles) et `sharp` (aucun traitement
  d'image côté serveur à ce stade). Tout nouveau paquet à script doit être tranché ici.
- Dépendances pairs : `pnpm peers check` signale des écarts **transitifs uniquement**, sans
  impact constaté (lint, typecheck, test, build verts) et non corrigeables sans rétrograder
  l'outillage : plugins `@babel/plugin-syntax-*` 7 de `babel-preset-jest` face à `@babel/core` 8 apporté par
  `@angular/build`,
  `chokidar` attendu par `@angular-devkit/core` 19 (via `@nestjs/schematics`) et 22, `typescript`
  6 au-delà des plages de `tsconfck` / `zod-to-ts` (dépendances d'Astro 5), `@emnapi/*` de
  `@napi-rs/wasm-runtime` (Nx, binaire WASM de secours non utilisé sous Linux x64). Aucun ne
  concerne une dépendance directe du `package.json`. À réexaminer à chaque montée de version.

## 7. Variables d'environnement

Voir `docs/ENV.md` (modèle du `.env.example`).
