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
| `landing` | `apps/landing` | Landing Astro 7 (SEO, zéro JS par défaut) | `scope:landing`, `type:app` |
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
| `api-auth` … `api-notifications` | `libs/api/*` | Modules Nest (auth, users, billing, alerts, notifications) | `scope:api`, `type:feature` |
| `api-analysis` | `libs/api/analysis` | Analyse de token : endpoint, cache, quotas simples, persistance, page publique, image OG (phase 3) | `scope:api`, `type:feature` |
| `api-wallet` | `libs/api/wallet` | Scan de wallet en lecture seule : endpoint, quota de scans, cache par wallet, réutilisation des verdicts par mint (phase 5) | `scope:api`, `type:feature` |
| `api-billing` | `libs/api/billing` | Abonnement : `BillingProvider` (Stripe / simulation), Checkout, portail, webhooks idempotents, `Subscription` (phase 6) | `scope:api`, `type:feature` |
| `api-trial` | `libs/api/trial` | Essai Pro : job de fin d'essai, e-mails J+1 / J-2 / J0, récapitulatif, conversion admin (phase 6) | `scope:api`, `type:feature` |
| `api-solana` | `libs/api/solana` | Clients Helius / RPC, DexScreener, GeckoTerminal, Jupiter, RugCheck, file de débit, agrégateur de faits (partagé avec l'API du banc) | `scope:solana`, `type:data-access` |
| `api-prisma` | `libs/api/prisma` | Schéma Prisma, migrations, client généré, `PrismaService` | `scope:api`, `type:data-access` |
| `api-core` | `libs/api/core` | Socle Nest transverse : config Zod, filtre d'erreurs, Helmet, CORS, throttler, CSRF, cookies | `scope:api`, `type:util` |
| `raijin-banc-de-test` | `apps/raijin-banc-de-test` | Front Angular 22 zoneless du banc (importé de `raijin-old`, phase 1 bis) | `scope:bench`, `type:app` |
| `bench-verdicts` | `libs/bench/verdicts` | Justesse des verdicts (phase 7 bis) : contrats du suivi, issues, métriques, variantes, rétention (TS pur) | `scope:bench`, `type:util` |

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
- `scope:api` → `api`, `solana`, `shared` (jamais `web`).
- `scope:landing` → `landing`, `shared`.
- `scope:shared` → `shared` uniquement.
- `scope:solana` → `solana`, `shared` (intégrations Solana côté serveur, `libs/api/solana` ; ni `api` ni `bench`).
- `scope:bench` → `bench`, `solana`, `shared` (le banc réutilise `libs/api/solana`, PROMPT.md §4.8).
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
- ~~`noUncheckedIndexedAccess: false`~~ : **levée en phase 9** (T9 e). Les 196 erreurs restantes
  (74 dans le code et les gabarits, 122 dans les tests) sont corrigées par 196 assertions non nulles `!` seulement
  (effacées à la compilation : aucun changement de calcul, diff vérifié caractère par caractère, 766
  tests d'origine verts sans modifier une assertion) ; le banc hérite désormais de
  `tsconfig.base.json` comme le reste du dépôt. Ces `!` marquent les accès que le code d'origine
  supposait toujours définis : un vrai garde (changement de comportement) ne s'ajoute qu'avec un test.
- **Thème d'origine conservé** (`apps/raijin-banc-de-test/src/styles.css`, Tailwind 4 limité à
  ses propres sources par `source(".")`, police Inter auto-hébergée, CSP `font-src 'self'`) : il
  n'importe pas `libs/brand/tokens.css`. Seule contrainte vérifiée : sa couleur `warn` (badge
  « BANC DE TEST ») est identique au token `warn` de `libs/brand` (`bench-badge.spec.ts`).
- Sélecteurs `app-` conservés ; aucune règle ESLint désactivée.
- Aucune configuration d'environnement ni clé : le front appelle l'API du banc sur la même origine (`/api`,
  client `src/app/core/api/`, cookies `rjb_*` + CSRF double-submit, SSE `/api/events`) ; `serve` (port 4300)
  relaie `/api` vers `localhost:3300` (`proxy.conf.json`). Cible `write-env` et supabase-js retirés (phase 8 bis, T8).

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
- Polices (app Angular) : Space Grotesk 600/700, Inter 400/500/600, JetBrains Mono 500/600
  **auto-hébergées** (audit M7 : aucune IP envoyée à Google sans consentement, CSP `'self'`).
  Fichiers woff2 du sous-ensemble latin des paquets `@fontsource/*` (aucun script d'installation),
  copiés au build vers `/fonts` (assets de `apps/web/project.json`) ; `@font-face` (`font-display:
  swap`) dans `apps/web/src/fonts.css`, importé après le thème par `apps/web/src/styles.css` ;
  préchargement d'Inter 400 et Space Grotesk 600 dans `apps/web/src/index.html`.
- L'`@import` Google Fonts de `libs/brand/tokens.css` (fichier de la charte, non modifié) n'a
  jamais d'effet une fois inliné par Tailwind (un `@import` placé après des règles est ignoré) ;
  le plugin PostCSS `tools/postcss/strip-remote-font-imports.cjs` (déclaré dans
  `apps/web/.postcssrc.json`, entrée `sharedGlobals` de `nx.json`) le retire du CSS construit :
  le build web ne référence plus `fonts.googleapis.com` ni `fonts.gstatic.com`.
- Landing Astro : elle ne dépend pas de l'`@import` de `tokens.css` mais charge encore Google
  Fonts par un `<link>` dans `apps/landing/src/layouts/Base.astro` (à auto-héberger de la même
  façon par seo-astro).
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
annulation des exécutions obsolètes. E2E Playwright et Lighthouse uniquement sur les PR vers `main`
(Lighthouse aussi en lancement manuel), artefacts de captures envoyés seulement en cas d'échec.

- **Job `e2e`** (PR vers `main` uniquement, après le job principal) : conteneurs de service
  Postgres 17 (`postgres:17.12-alpine`), Redis (`redis:8.10.3-alpine`) et Mailpit
  (`axllent/mailpit:v1.34.0`), épinglés par tag précis **et** digest, avec healthchecks, sur les
  mêmes ports hôte que `docker-compose.dev.yml` (5433, 6380, 1026, 8026) : la configuration de
  développement de l'API et des suites s'applique sans adaptation. Variables non secrètes
  (`DATABASE_URL` factice, `REDIS_URL`, `SMTP_*`, `MAILPIT_URL`) ; `JWT_ACCESS_SECRET` et
  `COOKIE_SECRET` tirés au hasard dans le job et masqués (aucun secret GitHub). Étapes :
  `api-prisma:migrate-deploy`, Chromium seul (navigateurs en cache, clé = version de
  Playwright), puis api-e2e et web-e2e en deux passes pour que
  Playwright démarre sa propre API avec `JWT_ACCESS_TTL=20s` et des limites hautes au lieu de
  réutiliser celle de la première suite.
- **Matrice e2e (depuis le 2026-11-22)** : avec 833 tests web (dont 574 responsive et 126 axe), le job
  unique dépassait ses 30 min (run 45043971090 annulé après 27 min de web-e2e, après ~3 min de mise en
  place et 1 min 45 d'api-e2e). Le job `e2e` est désormais une matrice de **5 lots en parallèle**
  (`fail-fast: false`, timeout 25 min chacun), chacun avec ses propres services, sa propre API et sa
  base vide : aucun état partagé entre lots.
  - Lots (`E2E_LOT`, lu par `apps/web-e2e/playwright.config.mts`) : `responsive` coupé en deux par
    `E2E_SHARD=1/2` et `2/2` (287 tests chacun), `visuel` (a11y + captures, 186), `parcours`
    (analysis, auth, billing : 43 parcours lents), `reste` (tout fichier non listé : socle, trial,
    wallet, watch, et **tout nouveau spec** sans retoucher la CI) + api-e2e. Un `--shard=i/5` natif
    aurait été plus simple mais coupe par nombre de tests, dans l'ordre des fichiers : le premier lot
    aurait reçu a11y et presque tous les parcours (> 20 min), les autres seulement du responsive.
    Rééquilibrer = déplacer un fichier dans `E2E_LOTS` (config Playwright) ; les durées par test sont
    dans le journal (reporter `list` en CI). `E2E_LOT` et `E2E_SHARD` sont des entrées du cache Nx de
    `web-e2e:e2e` (`apps/web-e2e/project.json`) : un lot ne rejoue jamais le résultat d'un autre.
  - **1 worker par lot** (pas 2) : le runner privé a 2 vCPU et fait déjà tourner l'API, le serveur de
    dev Angular et le build servi ; les parcours partagent l'état global de l'API (scénarios de
    fixtures, passes de jobs de watch.flow). `E2E_WORKERS` permet d'essayer 2 sur un lot sans toucher
    la config. Les fichiers en série (`mode: 'serial'`) restent entiers dans un même lot.
  - **Build par lot plutôt qu'en artefact** : une étape `nx run-many -t build -p api web --parallel=2`
    (~1,5 min, souvent en cache Nx) précède Playwright, dont les `nx run api:build` / `web:build`
    deviennent des lectures du cache local. Un job de build partagé ajouterait ~3 min de mise en place
    en série avant les lots et un aller-retour d'artefact pour un gain d'environ 1 min par lot, et le
    serveur de dev compile de toute façon sur chaque runner.
  - **Serveur de dev conservé** pour la base `http://localhost:4200` : `/_design` (responsive et a11y)
    n'existe qu'en développement. Le build servi (4310) reste réservé aux tests qui le visent.
  - Une étape « Suites e2e affectées » (`nx show projects --affected -t e2e`) arrête un lot sans rien
    à tester avant Chromium, migrations et builds (même règle qu'avant avec `nx affected`).
  - **Rapports** : chaque lot en échec envoie son blob Playwright (`e2e-blob-<lot>`, 1 jour, nommé par
    `PLAYWRIGHT_BLOB_OUTPUT_NAME`) ; le job `e2e-rapport`, lancé **seulement si un lot a échoué**, les
    fusionne (`playwright merge-reports --reporter html`) en un artefact `playwright-rapport` (7 jours,
    traces et captures comprises). Rien n'est envoyé quand tout est vert.
  - **Coût estimé** (minutes facturées, arrondies à la minute par job ; durées de tests estimées, à
    recaler sur le premier run grâce au reporter `list`) : avant, ≥ 30 min perdues par lancement
    (annulé), ~55-60 min s'il avait abouti en un seul job ; après, 5 lots de ~13-17 min (mise en place
    ~3-4 min + tests ~9-13 min) soit **~70-80 min par lancement**, ~17 min d'attente au lieu de > 30,
    +1-2 min pour `e2e-rapport` en cas d'échec. Avec Lighthouse (~10 min), une PR vers `main` coûte
    ~90 min : environ 20 lancements complets par mois tiennent dans les 2 000 min de GitHub Free privé,
    à réserver aux PR vers `main` et aux lancements manuels `-f suite=e2e`.
  - **Durées mesurées et coût des échecs (2026-11-23)**. Run vert 45050124331 (833 tests) : 5 lots de
    6,3 à 7,4 min (mise en place + builds ~3,5-4 min, tests ~1,5-3 min ; 287 tests responsive en
    ~3 min, soit ~0,6 s par test), **~35 min facturées par lancement**. Run 45086414316 (1 010 tests,
    +13 écrans admin et landing dans responsive, axe et captures) : responsive-1 6,6 min, parcours
    7,3, visuel 12,4 (33 échecs axe admin), et responsive-2 **annulé à 25 min** : ses 213 tests verts
    ont pris 3 min, mais 74 tests admin en échec définitif × 3 passages (2 relances du preset Nx, souvent
    jusqu'au délai d'assertion, 3 à 9 s chacun) ont coûté 16,5 min. Le volume n'était donc pas en
    cause : c'était le coût d'un écran cassé.
  - **Garde-fous** (`playwright.config.mts`, CI seulement) : **1 relance** pour `responsive` et
    `visuel` (fixtures, déterministes ; 2 conservées pour `parcours` et `reste`, API réelle, jobs,
    e-mails) et **arrêt du lot après `E2E_MAX_FAILURES` = 15 tests en échec définitif** (`maxFailures`,
    réglé dans `ci.yml` ; 0 = illimité). Un lot cassé coûte au plus ~15 × 2 × 9 s ≈ 4,5 min de plus, et
    son rapport montre les 15 premiers échecs (assez pour diagnostiquer un écran entier : 11 largeurs).
    Variable non déclarée en entrée du cache Nx : elle ne change rien à un run vert, et Nx ne met pas en
    cache un échec. En local : ni relance ni limite.
  - **Pas de 3e part responsive** : `--shard` coupe dans l'ordre des tests et les 13 nouveaux écrans,
    en fin de `responsive.spec.ts`, tomberaient tous dans la dernière part ; Playwright 1.65 n'a pas de
    poids de part. Un 3e lot ajouterait ~5,5 min de mise en place facturée par lancement pour ~2 min
    gagnées sur responsive-2. Estimation, tout vert : responsive-1 ~7 min (359 tests), responsive-2
    ~13-14 min (358 tests, dont 143 admin/landing plus lents, ~1,5-2 s avec connexion), visuel ~10
    (212), parcours ~7,5, reste ~7, soit **~45 min facturées par lancement** (~55 avec Lighthouse ;
    ~35 lancements complets par mois dans les 2 000 min), ~19 min au pire pour un lot qui atteint la
    limite d'échecs. Si responsive-2 dépasse durablement 18 min tout vert : passer à `E2E_SHARD=1/3..3/3`
    (3 lignes de matrice) ou séparer `visuel` en `a11y` / `captures` dans `E2E_LOTS`. Contrôle de
    couverture : `E2E_LOT=<lot> [E2E_SHARD=i/n] npx playwright test --list` par lot, dont l'union doit
    être égale à la liste complète (1 010 tests au 2026-11-23, vérifié).
- **Job `lighthouse`** (PR vers `main`, après le job principal et en parallèle de `e2e` ; ou lancement
  manuel `workflow_dispatch`) : mêmes services et secrets éphémères que `e2e`, migrations, Chromium de
  Playwright (même cache), puis `pnpm nx run web-e2e:lighthouse --args="--runs 3 --phase phase-3"`
  (build de production web + api, `serve-prod` sur 4310, API en mode fixtures sur 3100). Le résumé
  (`docs/lighthouse/phase-3/summary.md` : tableau des scores, passages, audits fautifs) est publié dans
  le résumé du job ; résumé + rapports HTML/JSON complets (`dist/lighthouse/phase-3/`) en artefact
  `lighthouse-<n°>` (7 jours). Timeout 20 min. **Seuil** : sur PR vers `main`, le job échoue si une
  catégorie est < 95 sur une page ; en lancement manuel, il publie seulement (étape en
  `continue-on-error`), mais échoue si aucun résumé n'a été produit (serveurs non démarrés).
- **Lancer la mesure à la demande** : `gh workflow run ci.yml --ref dev` (option `-f runs=1|3|5`,
  défaut 3), ou onglet Actions → CI → « Run workflow » sur `dev`. Suivi : `gh run watch`, puis
  `gh run download <id> -n lighthouse-<n°>`. En lancement manuel, seul ce job tourne (le job principal
  et `e2e` sont ignorés) : ~10 min de runner. Le groupe de concurrence inclut l'événement, si bien qu'un
  lancement manuel n'annule pas la vérification d'un push sur `dev`. Budget GitHub Free privé
  (2 000 min/mois) : lancer seulement pour valider une optimisation, pas à chaque commit.
- **E2E en local** : `pnpm nx run api:dev-infra` (Postgres, Redis, Mailpit), puis
  `pnpm nx run api-prisma:migrate-deploy` au premier lancement, puis `pnpm nx e2e api-e2e`
  et `pnpm nx e2e web-e2e` (une API déjà lancée est réutilisée par Playwright : la lancer alors
  avec `JWT_ACCESS_TTL=20s`). Arrêt : `pnpm nx run api:dev-infra-stop`. Rejouer un lot de la CI :
  `E2E_LOT=parcours pnpm nx e2e web-e2e` (ou `E2E_LOT=responsive E2E_SHARD=1/2`).

- pnpm : version imposée par `packageManager` du `package.json` (lue par `pnpm/action-setup`),
  Node 22 (au moins 22.23.4, exigé par Astro 7 ; `engines` du `package.json`),
  `pnpm install --frozen-lockfile`.
- Actions GitHub épinglées par **SHA de commit complet** (tag en commentaire, tags annotés
  déréférencés vers le commit). `.github/dependabot.yml` propose chaque semaine (lundi) les
  mises à jour des actions, en PR groupée vers `dev`.
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
  `chokidar` attendu par `@angular-devkit/core` 19 (via `@nestjs/schematics`) et 22, `@emnapi/*` de
  `@napi-rs/wasm-runtime` (Nx, binaire WASM de secours non utilisé sous Linux x64). Aucun ne
  concerne une dépendance directe du `package.json`. À réexaminer à chaque montée de version.
- **Écart assumé avec PROMPT.md (« Astro 5 »)** : la landing utilise **Astro 7** (`^7.4.13`).
  Astro 5.18 cumulait 13 alertes `pnpm audit` (dont une critique et plusieurs hautes : RCE via
  l'optimisation d'images AVIF, SSRF via l'en-tête `Host`, XSS), sans correctif publié sur la
  branche 5, plus `sharp` < 0.35.5 et `zod` < 4.6.6 transitifs. La montée a été faite tant que la
  landing n'était qu'un squelette. Avec Vite 8 commun à la racine et à Astro 7, le cast `any` du
  plugin Tailwind dans `astro.config.mjs` a disparu. `sharp` (0.35.5, dépendance optionnelle
  d'Astro) reste installé sans son script : la landing n'optimise aucune image au build.
- Nx monté en **24.0.6** (correctif) : apporte `undici` 7.30.1 (alertes hautes corrigées).

- **Job `images`** (phase 8 ; PR vers `main` après le job principal, ou `gh workflow run ci.yml --ref dev -f
  suite=images`) : `docker compose -f infra/docker-compose.yml build` depuis la racine du dépôt (BuildKit ; services
  `raijin-api`, `raijin-web`, `raijin-landing`, `raijin-migrate` ; `raijin-bench-*` seulement si
  `apps/raijin-banc-de-test-api` existe), images **locales, jamais poussées**. `docker/bake-action` a été abandonné
  (chemins de `files` et `env_file` résolus hors du dossier du compose) ; **pas de cache GitHub** pour les images
  (il faudrait une action tierce de plus pour l'exposer à `docker compose build`). Variables factices tirées au hasard
  et masquées (`infra/ci/fake-env.sh` : refuse de tourner hors GitHub Actions et d'écraser un `infra/.env*` existant).
  `infra/ci/test-restore.sh` sur un Postgres jetable `raijin-restore-test` (init, cloisonnement des rôles, sauvegarde,
  `--check`, `--into` réussi, refus si une session est ouverte, **renommage refusé → base d'origine intacte**, retour
  automatique sur échec). Démarrage par `infra/deploy.sh --skip-build --yes --no-external-check` (le script de prod
  est testé) derrière un **Traefik v3.6 factice** (réseau `traefik-ci`, certificat par défaut, certresolver
  inexistant), puis `infra/ci/check-stack.sh` : 5 conteneurs `healthy`, aucun port publié, routage (`app…/api/*`,
  `app…/t/*` réécrit vers l'API, `www` → 301 avec chemin et requête), règles nginx (`.html` et `/x/` → 301, 404, 405,
  cache immuable / `no-cache`, pas de redirection ouverte), en-têtes des labels (CSP exacte par application, HSTS
  2 ans + preload, nosniff, DENY, Referrer-Policy, Permissions-Policy, COOP, pas d'en-tête `Server`, gzip),
  `/api/v1/health` avec base joignable. Trivy 0.70.0 (image épinglée par digest, gratuit) en **rapport seul** dans le
  résumé (HIGH/CRITICAL corrigeables) ; **à rendre bloquant sur CRITICAL après la v1** (audit M9). Journaux des
  conteneurs en cas d'échec. Actions et images épinglées par SHA/digest ; images de base aussi suivies par Dependabot
  (écosystèmes `docker` et `docker-compose`) ; `timeout-minutes: 25`.
  **Coût estimé** : 15 à 20 min par exécution sans cache (installation pnpm, builds Angular/Astro/Nest en parallèle
  sur le runner 4 vCPU / 16 Go, test de restauration ≈ 1 min, Trivy ≈ 2 min). Lancé seulement sur les PR vers `main`
  et à la demande : quelques exécutions par mois, soit ≈ 5 % du quota de 2 000 min.
- **Limites connues de l'infra** (audit phase 8, détail dans `docs/DEPLOY.md` A15) : aucun CDN devant Traefik
  (`TRUST_PROXY=1`) ; réseau Traefik partagé avec MTC (un conteneur voisin peut joindre l'API directement et forger
  `X-Forwarded-For` : piste du sous-réseau de confiance) (M7) ; ACL Redis par application à poser avec le banc en
  8 bis (M6).

## 7. Variables d'environnement

Voir `docs/ENV.md` (modèle du `.env.example`).

## 8. API et auth (phase 2)

### 8.1 Prisma : lib dédiée `libs/api/prisma` (`api-prisma`, `type:data-access`)
- Schéma : `libs/api/prisma/prisma/schema.prisma`, migrations dans `libs/api/prisma/prisma/migrations/`
  (commitées), configuration `libs/api/prisma/prisma.config.ts` (`DATABASE_URL` lue dans l'environnement).
- Client généré dans `libs/api/prisma/src/generated/` (**ignoré par Git**) par la cible
  `api-prisma:prisma-generate` (en cache, entrées : `schema.prisma`). `build`, `typecheck`, `test` et
  `lint` d'`api-prisma` et de tout projet qui en dépend passent d'abord par cette cible
  (`dependsOn` dans `nx.json`), pour que la CI fonctionne sans étape manuelle.
- Exporte `ApiPrismaModule` (global) et `PrismaService` (connexion au démarrage, fermeture propre).
  Seuls les modules `libs/api/*` l'importent ; jamais le front (frontière `scope:api`).
- Pourquoi pas dans `apps/api` : l'app reste fine, et le futur `raijin-banc-de-test-api` aura sa
  propre lib Prisma (`scope:bench`, base `raijin_bench`) sans couplage.
- Enums Prisma alignés **à l'identique** sur les contrats : `Plan { FREE PRO }`, `Role { USER ADMIN }`
  (le profil public `PublicUser` les réutilise sans conversion). Identifiants `uuid` (v7 si disponible).
- Modèle (migration `init`, toutes les tables de PROMPT.md §5 posées dès la phase 2) : `User` (avec
  `emailNormalized`, `trialStartedAt`, `trialEndsAt`, `trialStatus`, `stripeCustomerId`, attribution
  UTM, `role` ; le verrouillage vit dans Redis, les colonnes réservées `failedLoginCount` / `lockedUntil` ont été
  supprimées par la migration `20261122180000_analysis`), `Session` (= famille de refresh, son `id` est le
  `sid` du JWT) + `RefreshToken` (hash SHA-256, `usedAt`), `AuthToken` (vérification / reset / lien
  magique : hash SHA-256, type, expiration, `usedAt`, `redirectPath`), `TotpSecret`, `TrialFingerprint`,
  `ProductEvent`, `DailyMetric`, `JobRun`, `Subscription`, `StripeEvent`, `TokenAnalysis`, `Watch`,
  `Alert`, `PushSubscription`, `UsageCounter`, `AuditLog`. Index sur `mint` et `userId`. Suppression
  d'un compte : cascade sur ses données, `SetNull` sur l'audit, les événements, les analyses et les
  empreintes d'essai. Client Prisma 7 (`prisma-client`, CJS) avec l'adaptateur `@prisma/adapter-pg`.
- Cibles : `api-prisma:prisma-generate` (cache), `migrate-dev`, `migrate-deploy`, `migrate-status`,
  `seed` (compte local `dev@raijin.local`, refusé en production).
- Scripts d'installation (`prisma`, `@prisma/engines`, `argon2`…) : chacun tranché explicitement
  dans `allowBuilds` (`pnpm-workspace.yaml`) avec sa justification, sinon la CI casse.

### 8.2 Socle Nest `libs/api/core` (`api-core`, `type:util`)
Configuration (schéma Zod des variables, échec au démarrage si invalide), filtre d'exceptions global
au format `ApiError {code, message}` (codes de `@raijin/shared-contracts`, aucune stack hors
développement), pipe de validation Zod (schémas des contrats), Helmet, CORS limité à
`CORS_ORIGINS` avec `credentials: true`, `@nestjs/throttler` global (stockage Redis) et renforcé sur
`/auth/*` (`@AuthThrottle()`, repli mémoire si Redis tombe), garde CSRF globale, utilitaire de
cookies, OpenAPI sur `/api/v1/docs` hors production. `apps/api/src/main.ts` ne fait que brancher ce
socle : le `new Function(...)` (point M3) est remplacé par `createRequire` pour le signal de
disponibilité de `nx serve` (dev uniquement). La garde CSRF lit le `sid` via
`SessionIdResolverRegistry`, que `api-auth` alimente au démarrage (core ne dépend pas d'auth).

### 8.3 E-mails : interface `Mailer` dans `libs/api/notifications`
Classe abstraite `Mailer` (`send({to, subject, html, text})`), deux implémentations choisies par
`MAIL_PROVIDER` : `SmtpMailer` (Mailpit en dev, `SMTP_HOST`/`SMTP_PORT`) et `ResendMailer` (prod).
Templates HTML responsive en thème clair + version texte. Les couleurs (`EMAIL_THEME`) sont celles
du thème `light` de `libs/brand/tokens.json` ; un test échoue si elles divergent (pas d'import JSON
inter-projets). Logo PNG `APP_URL/icons/icon-192.png` (les clients mail bloquent le SVG).
`api-auth` dépend de `api-notifications`. Liens : `APP_URL` + `AUTH_EMAIL_LINK_PATHS` (contrats)
+ `?token=`.

### 8.4 Sessions et cookies
- **Access token** : JWT HS256 signé par `JWT_ACCESS_SECRET`, durée `JWT_ACCESS_TTL` (15 min), contenu
  minimal (`sub`, `sid`, `role`) ; le plan et les quotas sont toujours relus en base.
- **Refresh token** : **opaque** (32 octets aléatoires, base64url), stocké **haché (SHA-256)** dans
  `RefreshToken` avec une famille (`familyId`), durée `JWT_REFRESH_TTL` (30 j). **Rotation** à chaque
  `POST /auth/refresh` ; un refresh déjà utilisé révoque toute la famille (vol détecté) →
  `AUTH_SESSION_EXPIRED`. Déconnexion, reset et changement de mot de passe révoquent.
  (`JWT_REFRESH_SECRET` n'est donc plus nécessaire.)
- **Cookies** (tous `HttpOnly`, `SameSite=Lax`, `Secure` si `COOKIE_SECURE=true`, toujours en prod) :

  | Rôle | Nom prod (`COOKIE_SECURE=true`) | Nom dev | Path | Domain |
  |---|---|---|---|---|
  | Access | `__Host-rj_at` | `rj_at` | `/` | aucun (hôte API seul) |
  | Refresh | `__Host-rj_rt` | `rj_rt` | `/` | aucun |
  | CSRF | `__Host-rj_csrf` | `rj_csrf` | `/` | aucun |

  Aucun jeton dans le corps des réponses ni dans le `localStorage`/`sessionStorage`. Le cookie
  d'access vit aussi longtemps que la session (le JWT, lui, expire après 15 min) : son `sid` signé
  reste lisible pour la garde CSRF de `POST /auth/refresh`. Un refresh réutilisé dans les 10 s
  (onglets concurrents) reçoit 409 `CONFLICT` sans révoquer la famille ni effacer les cookies (le
  front rejoue sa requête) ; au-delà, toute la famille est révoquée (401 `AUTH_SESSION_EXPIRED`).
  Le refresh est refusé (401 `AUTH_SESSION_EXPIRED`, cookies effacés) si l'en-tête `Cookie` répète son
  nom ou s'il n'appartient pas à la session (`sid`) de l'access signé présent. L'ancien
  `__Secure-rj_rt` (`Path=/api/v1/auth`) est accepté une dernière fois s'il est lié à l'access, puis expiré.
  Sans cookie (jamais connecté, déconnecté) : 401 `UNAUTHORIZED`, le front ne tente pas de refresh.
  La garde d'auth vérifie en base que la session n'est pas révoquée (déconnexion immédiate).
  `COOKIE_DOMAIN` reste vide (cookies liés à l'hôte de l'API).
- Les jetons d'e-mail (vérification 24 h, reset 30 min, lien magique 15 min) sont opaques,
  stockés hachés, à usage unique ; demander un nouveau jeton invalide les précédents du même type.
- Mots de passe : argon2id (paramètres OWASP : m = 19 Mio, t = 2, p = 1), règles dans
  `PASSWORD_RULES` (contrats). Verrouillage temporaire après échecs répétés : compteur Redis par
  HMAC(`emailNormalized`), adresses sans compte comprises, partagé par la connexion et les
  confirmations par mot de passe (changement, suppression). argon2 tourne toujours (vrai hash ou
  factice) et la réponse reste 401 `AUTH_INVALID_CREDENTIALS` : ni l'existence du compte ni le
  verrouillage ne sont révélés (`AUTH_ACCOUNT_LOCKED` n'est plus renvoyé).
- Compteur d'échecs : `INCR` + `PEXPIRE` atomiques (script Lua : expiration posée au premier échec, ou reposée
  si la clé n'en a pas), jamais de clé sans expiration. **Repli mémoire si Redis tombe** : le compteur passe en
  mémoire du processus (journalisé, code d'erreur seulement). Acceptable tant que l'API tourne en **une seule
  instance** (cas de la v1 sur le VPS) ; avec plusieurs instances, chaque instance aurait son compteur (seuil
  effectif multiplié) : à revoir si l'API est un jour répliquée.
- **Verrouillage provoqué par un tiers** (qui tape exprès de mauvais mots de passe pour une adresse) : le
  verrouillage ne concerne que la connexion par mot de passe et expire seul (`AUTH_LOCKOUT_DURATION`) ; le
  **lien magique** (`POST auth/magic-link`, envoyé à la boîte de l'utilisateur) reste l'accès de secours et
  n'est pas soumis au compteur. Le front le propose après un échec de connexion.
- Journaux : jamais le message brut d'une erreur de pilote (pg, ioredis, undici, qui peut contenir une URL ou
  un hôte) ; seulement son code (`errorCode()` de `api-core`, ex. `ECONNREFUSED`, `P2002`).
- Réponses neutres (202 `MessageResponse`) pour inscription, mot de passe oublié, lien magique,
  renvoi de vérification : aucune énumération des comptes.

### 8.5 CSRF : SameSite=Lax + double-submit signé
- `GET /api/v1/auth/csrf` pose le cookie CSRF (httpOnly) et renvoie le même jeton dans le corps
  (`CsrfResponse`) ; les réponses de session (`AuthSession`) le renvoient aussi. Jeton =
  `nonce.HMAC(COOKIE_SECRET, nonce + sid)` (lié à la session une fois connecté).
- Le front garde le jeton **en mémoire** (signal de `web-data-access`) et l'envoie dans l'en-tête
  `X-CSRF-Token` (`CSRF_HEADER`) sur chaque POST/PUT/PATCH/DELETE via un intercepteur. Un site tiers
  ne peut ni lire la réponse (CORS) ni le cookie (httpOnly) : il ne peut pas forger l'en-tête.
- Dès qu'un `sid` est lu (access token signé, même expiré), seul un jeton lié à ce `sid` est accepté ;
  le jeton anonyme ne vaut qu'en l'absence de session. `GET /auth/csrf` émet donc un jeton lié au
  `sid` de l'access token signé, même expiré (flux `auth/csrf` → `auth/refresh`).
- La garde vérifie en plus l'en-tête `Origin` (présent et dans `CORS_ORIGINS`) sur les mutations.
  Exemptés : `GET`/`HEAD`/`OPTIONS`, et le webhook Stripe (phase 6, signé). Refus : 403
  `AUTH_CSRF_INVALID`. Ce schéma marche aussi entre `app.raijinshield.com` et `api.raijinshield.com`
  (même site, origines différentes) sans cookie partagé entre sous-domaines.

### 8.6 URLs locales et production
| App | Local | Production |
|---|---|---|
| web (Angular) | `http://localhost:4200` (proxy dev `/api` → `http://localhost:3100`, même origine) | `https://app.raijinshield.com` |
| api (NestJS) | `http://localhost:3100/api/v1` (port de dev par défaut, 3000 étant pris sur la machine) | `https://api.raijinshield.com/api/v1` |
| landing (Astro) | `http://localhost:4321` | `https://raijinshield.com` |
| Mailpit (UI / SMTP) | `http://localhost:8026` / `localhost:1026` | — (Resend) |
| Postgres / Redis | `localhost:5433` / `localhost:6380` | réseau interne Docker |

- En dev, le front appelle `API_BASE_URL = '/api/v1'` (relatif) : `apps/web/proxy.conf.json` relaie
  vers l'API, donc pas de CORS ni de cookie inter-origines en local. **En prod aussi (décision phase 8)** :
  `API_BASE_URL` reste `/api/v1` (relatif) et Traefik route `app.raijinshield.com/api/*` directement vers
  `raijin-api` (un seul proxy, `TRUST_PROXY=1` exact), ainsi que `app.raijinshield.com/t/*` réécrit en
  `/api/v1/share/t/*` (§9.7). Cookies liés à l'hôte de l'app, `CORS_ORIGINS=https://app.raijinshield.com`.
  `api.raijinshield.com` reste servi (webhook Stripe, images OG, santé). Voir `infra/docker-compose.yml`.
- `*.localhost` (`app.localhost`, `api.localhost`) reste possible pour reproduire le schéma
  inter-origines de la prod, mais n'est pas la configuration par défaut (pas de `Domain` sur les
  cookies, donc rien à changer côté API).
- Les liens des e-mails sont construits avec `APP_URL` (jamais avec l'en-tête `Host` de la requête).

### 8.7 Infrastructure de dev : `docker-compose.dev.yml` (racine)
Projet Compose `raijin-dev` : Postgres 17 (volume `pgdata`), Redis 8 (sans persistance), Mailpit 1.34.
Ports liés à `127.0.0.1` uniquement et décalés pour cohabiter avec les autres projets de la machine :
Postgres **5433**, Redis **6380**, Mailpit SMTP **1026** / interface **8026**. Valeurs par défaut
factices identiques à `docs/ENV.md`.
`pnpm nx run api:dev-infra` (démarre et attend les healthchecks) ·
`pnpm nx run api:dev-infra-stop` (`docker compose -p raijin-dev stop`, sans supprimer le volume) ·
`pnpm nx run api-prisma:migrate-deploy` · `pnpm nx e2e api-e2e` (parcours d'auth complets via Mailpit).


### 8.8 Routes livrées (`/api/v1`)
`GET health` (200 / 503) · `GET health/config` · `GET auth/csrf` · `POST auth/register` (202) ·
`POST auth/verify-email` · `POST auth/verify-email/resend` (202) · `POST auth/login` ·
`POST auth/refresh` · `POST auth/logout` (204) · `GET auth/session` · `POST auth/magic-link` (202) ·
`POST auth/magic-link/verify` (`MagicLinkSession` = `AuthSession` + `redirectPath`) ·
`POST auth/password/forgot` (202) · `POST auth/password/reset` (204) · `POST auth/password/change` (204) ·
`GET users/me` · `GET users/me/export` (RGPD, JSON en pièce jointe) · `DELETE users/me` (204, corps
`DeleteAccountRequest { password }`). Phase 3 : `POST analyses` (200 `AnalysisResponse`, auth facultative, CSRF, throttler
`analysis`) · `GET analyses/quota` (`QuotaInfo`) · `GET analyses/:mint/latest` (`AnalysisResult`, 404
`ANALYSIS_NOT_FOUND`) · `GET share/t/:mint` (HTML) · `GET og/:mint.png` (PNG 1200×630, ETag). Codes : connexion refusée 401, compte verrouillé 429,
jeton e-mail invalide 400, session absente 401 `AUTH_SESSION_EXPIRED`, CSRF 403.

## 9. Analyse de token (phase 3)

### 9.1 Découpage
- **`libs/shared/contracts/src/lib/analysis/`** : contrat unique front ↔ API ↔ banc : `analysisRequestSchema`
  (`{ input }` : mint ou lien, 256 caractères max), `mintParamSchema`, `analysisResultSchema` (verdict,
  `explanation`, 9 `checks` dans l'ordre de `ANALYSIS_CHECK_IDS` avec `status`, `summary`, `metrics`
  chiffrées, `sources` {id, name, url}, `reasonCodes` ; `engineVersion`, `analyzedAt`, `cached`, `degraded`),
  `analysisResponseSchema` (`{ analysis, quota }`), `quotaInfoSchema`, `tokenMetadataSchema` (nom/symbole
  **non fiables**, nettoyés et bornés, `untrusted: true`, aucune image), `riskFactsSchema` /
  `riskAssessmentSchema` (entrée/sortie du moteur), `RISK_REASON_CODES`, `ANALYSIS_ERROR_CODES`
  (`MINT_INVALID`, `TOKEN_NOT_FOUND`, `ANALYSIS_NOT_FOUND` ; `QUOTA_EXCEEDED`, `UPSTREAM_UNAVAILABLE`,
  `RATE_LIMITED` restent génériques) et leurs messages, `EXTERNAL_LINK_HOSTS`, `ANALYSIS_DISCLAIMER`,
  `SAFE_VERDICT_REMINDER`.
- **`libs/shared/util`** : `extractSolanaAddress` (adresse brute, DexScreener, pump.fun, Solscan, Birdeye ;
  `kind: 'mint' | 'pair_or_mint'`), `parseUrlLike` / `isAllowedHttpsUrl` (sans `URL`, absent de
  `lib: es2022`), `sanitizeUntrustedText`. Utilisés à l'identique par le front (aperçu immédiat) et l'API.
- **`libs/shared/risk-engine`** (pur) : `EvaluateRisk = (facts: RiskFacts) => RiskAssessment`. Aucune I/O,
  aucune horloge (âges calculés depuis `facts.observedAt`), seuils fournis par une fabrique
  (`createRiskEngine(config)`) pour que le banc évalue des variantes. Règles dans `docs/SCORING.md`.
  Couverture ≥ 80 % (lignes et branches).
- **`libs/api/solana`** (`api-solana`, **`scope:solana`**, `type:data-access`) : serveur uniquement,
  réutilisé par `raijin-banc-de-test-api` (le tag `scope:solana` est autorisé pour `scope:api` et
  `scope:bench`, et ne dépend lui-même que de `scope:shared`). Contenu :
  - un client par source : `helius` (RPC + DAS), `solana-rpc` (RPC public), `dexscreener`,
    `geckoterminal`, `jupiter` (lite-api quote, **devis seulement**), `rugcheck` ; chacun reçoit un
    `fetch` injecté (tests sans réseau) et valide la réponse avec un schéma Zod **local** (types de
    réponse des fournisseurs = détail d'implémentation, pas de contrat partagé) ;
  - `UpstreamGate` par source : seau à jetons + file FIFO bornée (débordement → échec rapide),
    timeout par appel (3 s, Jupiter 4 s), 2 tentatives max sur réseau / 429 / 5xx avec backoff
    exponentiel + gigue (`Retry-After` respecté jusqu'à 2 s), disjoncteur simple (5 échecs consécutifs →
    ouvert 30 s → un essai) ; implémentation maison (~150 lignes testées), **aucune dépendance** ;
  - collecteurs de faits par contrôle et **agrégateur** `collectFacts(mint, { profile: 'full' | 'light' })`
    → `RiskFacts` + statut par source (ok / erreur / ignorée, latence), sous une échéance globale de 8 s ;
    `light` (sans historique du créateur ni devis de vente) servira au scan de wallet (phase 5), avec
    `getTokenAccountsByOwner` réservé dans le client RPC ;
  - ports `CacheStore` (get/set TTL) et `Clock`, implémentés par l'API (Redis) et plus tard par le banc :
    la lib ne dépend pas de Redis ni de Prisma ;
  - `ApiSolanaModule` Nest configurable (`forRootAsync`) qui assemble le tout.
- **`libs/api/analysis`** (`api-analysis`, `scope:api`, `type:feature`) : contrôleur, cache, déduplication,
  quotas simples, persistance `TokenAnalysis`, page publique, image OG. Orchestration :
  `extractSolanaAddress` → résolution paire → mint (DexScreener) si `pair_or_mint` → `collectFacts` →
  `EvaluateRisk` → rédaction des phrases → `analysisResultSchema.parse` (garde de sortie) → réponse.

### 9.2 Routes (`/api/v1`)
`POST analyses` (auth facultative, CSRF, `AnalysisRequest` → `AnalysisResponse`) ·
`GET analyses/:mint/latest` (public, dernière analyse ≤ 24 h, sans quota, sinon 404 `ANALYSIS_NOT_FOUND`) ·
`GET analyses/quota` (`QuotaInfo`) · `GET og/:mint.png` (image 1200×630) ·
`GET share/t/:mint` (HTML de la page publique avec balises OG injectées, voir 9.7).

### 9.3 Débit Helius (plan Free : 10 req/s RPC, 2 req/s DAS, 1 M crédits/mois, **partagés avec le banc**)
- Répartition **statique** par processus (pas de coordination inter-processus) : API Raijin 7 req/s RPC et
  1,5 req/s DAS, banc 3 req/s et 0,5 req/s (variables `HELIUS_RPC_RPS`, `HELIUS_DAS_RPS`).
- Budget de crédits journalier compté dans Redis (`HELIUS_DAILY_CREDIT_BUDGET`, défaut API 22 000 ≈ 66 %
  du mois, banc 10 000) ; au-delà, repli sur le RPC public quand c'est possible, sinon contrôle
  `unavailable` (résultat `degraded`), jamais d'erreur bloquante.
- Autres sources (sans compte, limites à confirmer par solana-data dans leur doc et à mettre en
  configuration) : DexScreener ≈ 4 req/s, GeckoTerminal 0,5 req/s, Jupiter lite-api 1 req/s,
  RugCheck 1 req/s.
- **L'URL RPC Helius contient la clé** (`?api-key=`) : elle est construite à l'intérieur du client, jamais
  journalisée ni renvoyée ; les logs ne portent que `source`, méthode RPC, statut et latence ; toute erreur
  `fetch` est réemballée en `UpstreamError(source, kind)` **sans** `cause` (les erreurs undici peuvent
  contenir l'URL). `redirect: 'error'`, taille de réponse bornée (2 Mo), `content-type` JSON exigé.

### 9.4 Sans clé Helius
RPC public `https://api.mainnet-beta.solana.com` à 1 req/s, cache des analyses porté à 300 s
(`ANALYSIS_CACHE_TTL_NO_KEY_S`). Disponibles : autorités mint/freeze et extensions Token-2022
(`getAccountInfo` jsonParsed), top holders (`getTokenLargestAccounts` + propriétaires via
`getMultipleAccounts`). Indisponibles (statut `unavailable`, mention « source indisponible ») : historique
du créateur et métadonnées modifiables des tokens SPL classiques (DAS requis ; un Token-2022 avec
l'extension de métadonnées reste lisible). Les tests ne dépendent jamais de la clé (fixtures).

### 9.5 Cache et déduplication
- Résultat : Redis `analysis:result:<engineVersion>:<mint>`, TTL 60 s (`ANALYSIS_CACHE_TTL_S`) ; renvoyé
  avec `cached: true`. Cache négatif `TOKEN_NOT_FOUND` 60 s. Caches par source dans `api-solana` via
  `CacheStore` (ex. âge du token : 24 h, historique du créateur : 1 h, RugCheck : 5 min).
- Déduplication : *single-flight* en mémoire (`Map<mint, Promise>`) + verrou Redis
  `analysis:lock:<mint>` (`SET NX PX 15000`) ; les autres demandeurs relisent le cache toutes les 250 ms
  pendant 10 s au plus, puis calculent eux-mêmes. Redis absent → single-flight mémoire seul.
- Persistance : une ligne `TokenAnalysis` par analyse **fraîche** (pas pour un résultat en cache). Migration
  phase 3 : colonnes `engineVersion`, `facts` (Json, `RiskFacts` : rejouables par le banc), `degraded`,
  `explanation` ; `checks` = `AnalysisCheck[]`, `sources` = statut par source.

### 9.6 Quotas simples (complets en phase 6)
- Sujet : utilisateur connecté (`userId`) ou anonyme (`ipHash` = HMAC-SHA256(`IP_HASH_SECRET`, IP) tronqué,
  IP lue via `trust proxy`). Limites en configuration : anonyme `ANON_ANALYSIS_DAILY_LIMIT` (3),
  Gratuit `FREE_ANALYSIS_DAILY_LIMIT` (5), essai `TRIAL_ANALYSIS_DAILY_LIMIT` (50), Pro illimité. Jour UTC.
- Réservation atomique avant l'analyse (`UPDATE … SET count = count + 1 WHERE count < limit`, upsert du
  compteur `UsageCounter` kind `analysis`), **remboursée** si l'analyse échoue (`MINT_INVALID`,
  `TOKEN_NOT_FOUND`, `UPSTREAM_UNAVAILABLE`). Une même analyse (sujet + mint) répétée dans les 10 min ne
  recompte pas (Redis `quota:seen:<sujet>:<mint>`). Throttler renforcé sur `POST analyses` (anonyme).

### 9.7 Page publique `/t/<mint>` et image Open Graph
- Le front reste en rendu client (pas de SSR Angular) ; les robots des réseaux sociaux n'exécutant pas le
  JS, `app.raijinshield.com/t/*` est servi en production par `GET /api/v1/share/t/:mint` (réécriture
  Traefik en phase 8) : l'API lit le `index.html` du build web (`WEB_INDEX_HTML_PATH`, monté en lecture
  seule ; à défaut, HTML minimal avec lien vers l'app) et y injecte titre, description, `og:*`,
  `twitter:card = summary_large_image`, canonique, **toutes les valeurs échappées** (verdict + mint
  tronqué ; symbole entre guillemets et marqué non fiable). Angular démarre ensuite normalement et met
  à jour les balises via `Meta`/`Title` (seul mécanisme actif en dev).
- Image OG : **satori + `@resvg/resvg-wasm`** (JS + WebAssembly, aucun script d'installation, aucun
  binaire natif, donc rien à ajouter dans `allowBuilds` ; `sharp` reste refusé). 1200×630, fond `base`,
  logo, badge de verdict (icône + mot), mint tronqué, petit Rai ; couleurs lues dans
  `libs/brand/tokens.json`, polices de la charte en TTF/WOFF embarquées (satori ne lit pas le WOFF2).
  Satori ne reçoit que des nœuds texte (pas d'HTML parsé) issus de `sanitizeUntrustedText`. Cache Redis
  `og:<mint>:<verdict>:<engineVersion>` 1 h, `Cache-Control: public, max-age=600`, rendu en file de
  concurrence 1 ; repli : image statique générique de la marque.

### 9.8 Données externes hostiles et SSRF
- Toute chaîne externe passe par `sanitizeUntrustedText` **à la collecte** (`api-solana`) puis par le parse
  du contrat (rejoué côté front). Affichage par interpolation uniquement (aucun `innerHTML`,
  aucun `bypassSecurityTrust*`).
- Aucune image de token affichée ni proxifiée en v1 ; l'URI des métadonnées n'est **jamais** suivie.
- Les liens de sources sont **construits par Raijin** à partir de gabarits fixes
  (`https://dexscreener.com/solana/<mint>`, `https://rugcheck.xyz/tokens/<mint>`, `https://solscan.io/token/<mint>`…)
  et validés par `externalUrlSchema` (https + `EXTERNAL_LINK_HOSTS`) ; jamais une URL fournie par une source.
- SSRF : l'API n'appelle que des URL de base fixes en configuration ; le mint (base58 validé) est la seule
  donnée insérée dans un chemin (`encodeURIComponent` quand même) ; `redirect: 'error'`.

### 9.9 Fixtures
`libs/api/solana/src/fixtures/<source>/<scenario>.json` :
`{ recordedAt, source, request: { method, path | rpcMethod, params }, status, body }` (jamais d'URL
complète, jamais d'en-tête). Scénarios minimum : token sain établi, stablecoin à freeze actif (émetteur
connu), mint actif, honeypot (aucune route de vente), LP retirée, Token-2022 à taxe de transfert, mint
inexistant, 429 et 500. Enregistrement : cible manuelle `api-solana:record-fixtures` (ni cache ni CI),
qui lit `HELIUS_API_KEY` dans l'environnement du processus sans jamais l'afficher et retire toute
query string ; le test `fixtures-hygiene.spec.ts` échoue si un fichier contient `api-key`,
`helius-rpc.com/?` ou un UUID. Les tests unitaires rejouent les fixtures via le `fetch` injecté :
**aucun appel réseau en test ni en CI**.

### 9.10 Budget Lighthouse (mobile ≥ 95 sur l'écran d'analyse)
Route lazy `web-feature-analyse` ; budget Angular `initial` resserré (avertissement 400 kB, erreur 500 kB brut), chunk de
l'écran ≤ 80 kB brut ; LCP < 2,5 s, CLS < 0,05 (squelette aux dimensions du résultat), TBT < 200 ms ;
animation « éclair sur le bouclier » en SVG + CSS (`transform`/`opacity` uniquement, ≤ 1,2 s,
`prefers-reduced-motion` respecté) ; aucune ressource tierce, polices auto-hébergées préchargées
(`font-display: swap`). Mesure sur le build de production servi statiquement, API simulée par les
fixtures, pages : `/analyse` (vide), `/analyse/<mint>` (résultat), `/t/<mint>`.

### 9.11 Implémentation livrée (T3, `libs/api/analysis`)
- **Collecte** : port `FactsCollector` (`collectFacts`, `resolveMint`), implémenté par `SolanaFactsCollector` sur
  `SolanaDataService` (`@raijin/api-solana`, une instance par processus créée par `ApiAnalysisModule`) :
  `TokenNotFoundError` → 404 `TOKEN_NOT_FOUND` ; `canIssueVerdict(facts) === false` → 503 `UPSTREAM_UNAVAILABLE` ;
  contrôles bâtis avec `summarizeCheck`, `buildCheckMetrics`, `collected.checkSources`, `explainVerdict`,
  `collected.degraded`. Ports fournis à la lib : `SolanaCacheStore` (Redis, préfixe `solana:`) et
  `RedisCreditBudget` (compteur `helius:credits:<jour>`, script Lua INCRBY + EXPIRE + annulation au-delà du budget ;
  repli mémoire si Redis tombe). Cache des résultats 60 s avec clé Helius (`heliusConfigured`), 300 s sinon.
- **Mode fixtures** (`ANALYSIS_FIXTURES=1`, refusé en production) : `SolanaDataService` sans clé Helius, `fetch`
  de rejeu `createFixtureFetch(loadAllFixtures(dir))` de `@raijin/api-solana/testing`, appelé
  seulement dans ce mode (`ANALYSIS_FIXTURES_DIR`, défaut `libs/api/solana/src/fixtures`). Utilisé par `api:serve-e2e` (avec
  `TRUST_PROXY=1` pour simuler une IP par test via `X-Forwarded-For`).
- **Quota** : `QuotaService.resolvePolicy` (relu en base : Gratuit, essai actif, Pro ; seul point à étendre en phase 6)
  → `reserve` (`INSERT … ON CONFLICT … DO UPDATE … WHERE count < limit RETURNING count`) → `settleFailure` en cas
  d'erreur : panne des sources (`UPSTREAM_UNAVAILABLE`) remboursée jusqu'à `ANALYSIS_UPSTREAM_FAILED_DAILY_LIMIT` (10)
  par sujet et par jour (compteur `analysis_upstream_failure`), au-delà consommée ; cache négatif 60 s par mint
  (`analysis:unavailable:` et `analysis:notfound:`) pour qu'une même adresse ne relance pas la collecte ; autres échecs (token inexistant…)
  comptés (`UsageCounter.kind = analysis_failure`) et remboursés jusqu'à `ANALYSIS_FAILED_DAILY_LIMIT` (20) par
  sujet et par jour, au-delà consommés, et le sujet reçoit 429 `QUOTA_EXCEEDED` jusqu'à minuit UTC (chaque échec
  coûte des crédits Helius). Throttlers : clé = IP ramenée à son préfixe (`ipBucket`, IPv6 par /64).
  À faire en phase 4 (jobs) : purge à 90 jours de `TokenAnalysis`, `ProductEvent` et des `UsageCounter` anonymes. Empreinte d'IP : HMAC(`IP_HASH_SECRET`) tronqué, IPv6 regroupée par /64. Throttler `analysis`
  (`@AnalysisThrottle()`, `RATE_LIMIT_ANALYSIS_PER_MINUTE`) appliqué à tout `POST analyses`. Auth facultative
  (`OptionalAuthGuard`) : cookie d'access invalide → 401 `AUTH_SESSION_EXPIRED` (pas de bascule silencieuse en anonyme).
- **Persistance** : `TokenAnalysis` (+ `token` Json : métadonnées nettoyées pour la page publique, `durationMs`) ;
  `ProductEvent` `analysis_done` (mint, verdict, cached, degraded, engineVersion, durationMs, subject) à chaque
  analyse réussie, en cache ou non ; durée aussi dans l'en-tête `Server-Timing`.
- **Page publique** : `GET share/t/:mint` répond avec une CSP adaptée au document de l'app (`script-src 'self'`,
  `style-src 'self' 'unsafe-inline'`, `frame-ancestors 'none'`) au lieu du `default-src 'none'` des réponses JSON.
  Point à trancher en phase 8 (Traefik) : si le build web garde `inlineCritical` (attribut `onload` sur la feuille de
  style), la CSP de l'app doit l'autoriser ou le build doit le désactiver.
- **Image OG** : logo et Rai copiés dans `og/brand-assets.ts` (test d'égalité avec `libs/brand`), polices WOFF
  `@fontsource` copiées dans `dist/apps/api/assets/fonts` au build (`OG_FONTS_DIR` sinon). Nom du token réduit aux
  caractères latins des polices, 24 caractères max, toujours « (non vérifié) ».

## 10. Performance mobile (Lighthouse ≥ 95, PROMPT.md §3 et §9.5)

### 10.1 Diagnostic (2026-11-22, HEAD `32bd628`)
Lighthouse 13.6, mobile, throttling simulé par défaut (CPU ×4, 4G lente), build de production + API en
mode fixtures. Médiane de 3 : Perf 62 / 54 / 62 (`/analyse`, `/analyse/<mint>`, `/t/<mint>`), BP 96 / 96 / 92.
- **Zod entier dans le front** : `import { z } from 'zod'` lie le namespace `z` comme **valeur** ; ni
  esbuild ni Rolldown ne l'éliminent : chunk de contrats de 438 kB brut (locales 264 kB, JSON Schema
  34 kB, compilateur JIT 29 kB). Avec `import * as z from 'zod'` : 106 kB (mesuré, même contenu utile).
- **Chemin du LCP** : route `analyse` chargée à la demande → cascade main → chunk de la feature → 6 petits
  chunks partagés → rendu. Lighthouse (Lantern) compte aussi toute requête **commencée** avant le LCP
  observé : `auth/session`, `analyses/quota` puis le chunk Zod (chargé pour valider la réponse du quota)
  allongeaient le LCP simulé à 3,9–5,1 s.
- **TBT** : la tâche longue principale (~125 ms observés, ~730 ms simulés) est le **premier rendu de la
  coquille** (`RjAppShell` : barre latérale desktop rendue même sur mobile, icônes, logo, barre d'onglets),
  puis le rendu du résultat (9 contrôles), puis l'évaluation de Zod. 3 `Intl.NumberFormat` créés au
  chargement de `shared-util` (~15 ms ×4 chacun) s'y ajoutaient.
- **Best Practices** : 401 de `GET auth/session` pour tout visiteur anonyme (erreur réseau en console) ;
  sur `/t` (servie avec CSP), test `new Function('')` de Zod 4 → violation `script-src` (`inspector-issues`).
- **Machine de mesure** : `benchmarkIndex` 620–1190 selon la charge (agents en parallèle, réduction
  thermique `intel_powerclamp`), sous le seuil de 1000 attendu par Lighthouse (avertissement « slower CPU »).
  Les tâches longues simulées y sont gonflées : la note qui fait foi reste celle du multiplicateur 4,
  mesurée machine au repos (`benchmarkIndex` ≥ 1000 sur les 3 passages).

### 10.2 Décisions
1. **Pas de prérendu (SSG) ni de SSR Angular** (§9.7 maintenu). Le prérendu ne réglerait que le LCP de
   `/analyse`, déjà à 0,8 s une fois la route chargée au démarrage ; pour `/analyse/<mint>` et `/t/<mint>`,
   le LCP dépend de la réponse de l'API (contenu par mint, non prérendable). L'hydratation rejoue les
   templates de la coquille : elle ne supprime pas la tâche longue qui fait le TBT. L'hydratation
   incrémentale et le rejeu d'événements ajoutent un script inline (`ng-event-dispatch-contract`)
   incompatible avec `script-src 'self'`. Coût en plus : `@angular/ssr`, build serveur, gardes navigateur
   partout. Option rouverte seulement si les tâches 10.3 ne suffisent pas, avec un hash CSP documenté.
   Une coquille HTML statique dans `index.html` est écartée pour la même raison (TBT inchangé, balisage
   dupliqué hors composants). **Exception pour `/t/<mint>` seulement : voir §10.7** (verdict statique
   injecté par l'API et démarrage d'Angular à la première interaction, ce qui retire, lui, la tâche longue).
2. **Routes `analyse` et `t` dans le bundle initial** (`apps/web/src/app/app.routes.ts`, `children`
   statiques) ; `suivis`, `alertes`, `wallet`, `compte` restent à la demande. Bundle initial ≈ 377 kB brut
   (budget : avertissement 400 kB, erreur 500 kB). Mesuré : LCP de `/analyse` 3,8 s → 0,8–1,7 s.
3. **Zod côté front** : `import * as z from …` partout (règle ESLint `no-restricted-syntax` à la racine :
   `import { z }` et `import z` de `zod` interdits, imports de type permis). Les contrats importent Zod
   via `libs/shared/contracts/src/lib/zod.ts`, qui exécute `config({ jitless: true })` **avant** tout
   schéma (dépendance explicite : un import d'effet dans `index.ts` était réordonné par Rolldown) :
   plus de `new Function`, plus de violation CSP, pas de compilation au premier parse ; même réglage côté
   API et banc. Zod reste hors du bundle initial (chunk à la demande, 106 kB brut / ~30 kB transférés).
   `zod/mini` (14 kB) écarté pour l'instant : réécriture de tous les contrats et de leurs usages côté API
   pour un gain secondaire une fois Zod sorti du chemin critique.
4. **Contrat `GET /auth/session`** → 200 `SessionState` (`sessionStateSchema`, union discriminée sur
   `authenticated`) : `{ authenticated: false }` quand la requête ne porte **aucun** cookie de session
   (ni access ni refresh) ; `{ authenticated: true, user, accessTokenExpiresAt, csrfToken }` sinon. Un
   cookie présent mais access absent/expiré/invalide → 401 comme avant (le front tente le refresh).
5. **Rien avant le LCP qui ne le serve** : la session, l'attribution, le quota et le préchargement des
   contrats partent après le premier rendu de la route (`afterNextRender` puis `requestIdleCallback`,
   repli `setTimeout`), les gardes de route continuant d'attendre `AuthStore.whenReady()`. Sur
   `/analyse/<mint>` et `/t/<mint>`, la requête d'analyse part dès l'entrée dans la route, en parallèle
   du jeton CSRF et du chunk des contrats (jamais en série derrière eux).
6. **Formateurs `Intl` créés au premier usage** (`libs/shared/util/src/lib/format.ts`).
7. **Mesure** : `apps/web-e2e/scripts/lighthouse.mjs` republie l'analyse de BONK avant **chaque** passage
   (sinon un résultat partiel sorti du cache est recalculé pendant la mesure : jusqu'à 4 s de serveur),
   note le `benchmarkIndex` de chaque passage et accepte `--cpu <n>` (diagnostic seulement, noté « ne fait
   pas foi » dans le résumé). L'API garde l'`index.html` lu au démarrage : la redémarrer après un build web,
   sinon `/t/<mint>` référence des chunks disparus (NO_FCP).

### 10.3 Budgets (complètent §9.10)
Tâche longue au démarrage ≤ 50 ms observés sur la machine de mesure au repos (≤ 200 ms simulés) ; aucune
requête API ni chunk Zod avant le premier rendu de `/analyse` ; LCP ≤ 2 s simulé sur les 3 pages ; TBT
≤ 200 ms ; CLS ≤ 0,05 ; 0 erreur console et 0 problème « Issues » (visiteur anonyme, CSP de l'API active).

### 10.4 Mesure de référence : le runner GitHub
La machine de développement a un CPU bridé thermiquement (`idle_inject` sur 8 cœurs, `benchmarkIndex`
980–1320) : Lighthouse local y donne Perf 87 / 73 / 78 (`/analyse`, `/analyse/<BONK>`, `/t/<BONK>`),
Accessibilité, Best Practices et SEO à 100, CLS 0, TBT 490 / 710 / 1060 ms (chunk framework Angular
161 kB), LCP de `/analyse/<BONK>` 3,6 s. Ces chiffres servent au diagnostic, pas au critère. **La mesure
qui fait foi pour le critère ≥ 95 est celle du job `lighthouse` sur `ubuntu-latest`** (multiplicateur CPU
4 par défaut, `benchmarkIndex` noté dans le résumé), lancé à la demande (§6) ou sur la PR `dev → main`.
Si le runner lui-même affiche un `benchmarkIndex` < 1000, le noter dans `PROGRESS.md` à côté du score.

### 10.5 Si le runner donne < 95 : options restantes (classées gain / risque)
1. **Lancer l'analyse au démarrage de l'app** (gain moyen sur le LCP de `/analyse/<mint>` et `/t/<mint>`,
   risque faible) : sur ces URL, déclencher jeton CSRF puis `POST /analyses` avant le bootstrap
   (`main.ts` appelle une fonction de la lib de la feature, aucune logique dans l'app), et faire
   consommer la promesse par le store ; la réponse arrive pendant l'évaluation du framework au lieu
   d'après. Pas de dépendance, pas d'impact CSP.
2. **Réduire le chunk framework** (gain moyen sur le TBT, risque faible à moyen, par petites étapes
   mesurées). Déjà en place : zoneless (`provideZonelessChangeDetection`, pas de `zone.js`), aucun
   `provideAnimations*` (animations CSS). Restent : inventaire du chunk avec les stats esbuild
   (`--stats-json`) ; `withComponentInputBinding` remplacé par la lecture explicite des paramètres sur les
   routes initiales ; formulaires (`FormsModule`/`ReactiveFormsModule`), `HttpClient` et intercepteurs
   non nécessaires au premier rendu sortis du bundle initial ; barils de libs qui tirent des services
   entiers remplacés par des imports ciblés ; coquille desktop (`RjAppShell`, barre latérale) rendue
   seulement au-delà du point de rupture (`@defer (on viewport)` ou condition de média).
3. **`zod/mini`** (gain faible sur le chemin critique depuis que Zod est hors du bundle initial, §10.2 point 3 ;
   106 kB → ~14 kB à la demande ; risque moyen) : réécriture de tous les contrats (`libs/shared/contracts`)
   et de leurs usages API et banc, API fonctionnelle différente (`z.optional(x)` au lieu de `x.optional()`).
   À ne faire que si le profil montre encore l'évaluation de Zod avant le LCP.
4. **Hydratation / prérendu** (gain incertain, risque fort) : impossible en l'état avec `script-src 'self'`
   (script inline de rejeu d'événements) et sans effet sur la tâche longue de la coquille (§10.2 point 1).
   Écarté, sauf hash CSP documenté et preuve que le TBT baisse.

**Recommandation** : d'abord relever la mesure du runner (`gh workflow run ci.yml --ref dev`). Si une page
est < 95, appliquer l'option 1 puis l'option 2 (coquille desktop et inventaire du chunk en premier), avec une mesure runner
après chacune ; `zod/mini` seulement en dernier recours ; l'hydratation reste écartée.

### 10.6 Audit du bundle initial (phase 9, T1, 2026-11-24)
Mesure : `pnpm nx run web:build:production --stats-json` (metafile esbuild `dist/apps/web/browser-stats.json`),
arbre de travail du 2026-11-24. Le budget Angular `initial` compte **JS + CSS initiaux**. Tailles « brut » =
fichiers émis (minifiés, non compressés) ; la part de chaque module est le `bytesInOutput` du metafile ramené à
la taille finale de son chunk (coefficient 0,78 à 0,86, second passage d'optimisation).

**Total : 471,3 kB brut / 123,7 kB transférés** (avertissement 400 kB, erreur 500 kB) : JS 405,1 kB, CSS 66,2 kB.

| Chunk initial | Brut | Contenu |
|---|---:|---|
| `chunk-B0ZDm8dy` | 169,1 kB | `@angular/core` (≈ 140 kB), `rxjs` ≈ 20 kB, `tslib`, `common/platform_location` |
| `main` | 103,2 kB | `web-ui` 39 kB, `feature-analyse` 36 kB, `web-data-access` 22 kB, `shared-util` 3,8 kB, `apps/web` 3,3 kB |
| `chunk-BwgTypt5` | 94,8 kB | `@angular/router` ≈ 80 kB, `platform-browser` (renderer DOM) ≈ 14 kB |
| `styles` | 66,2 kB | utilitaires Tailwind 51,3 kB (dont variantes `md`/`lg`/`sm` 8,7 kB), base + preflight 10,2 kB, `@property` 4,1 kB, `@font-face` 2,2 kB |
| `chunk-DY8KIUve` | 19,9 kB | `@angular/common/http` (`HttpClient`, `withFetch`, intercepteurs) |
| `chunk-l5n4wdVk` | 11,8 kB | registre d'icônes `RjIcons` : **41 icônes Lucide**, toutes dans le bundle initial |
| `chunk-CXeNBmOZ` + 2 petits | 6,3 kB | `common/location`, `api-config`, `contracts` (chargeur paresseux) |

Modules ≥ 5 kB (ou groupes) du bundle initial, propriétaire et décision :

| Module | Brut | Propriétaire | Décision |
|---|---:|---|---|
| `@angular/core` | ≈ 140 kB | framework | Garder (zoneless déjà en place, pas d'animations, pas de `zone.js`). |
| `@angular/router` | ≈ 80 kB | framework | Garder. `withComponentInputBinding` : gain ≈ 1–2 kB seulement, **non prioritaire**. |
| CSS Tailwind global | 66,2 kB | ui-mobile-first | Retirer de `@source` la page `/_design` (dev seulement) et la feature admin (feuille propre, chargée avec la coque admin) : **G5**. |
| `@angular/common/http` | 19,9 kB | framework | Garder : le `POST analyses` anticipé de `/analyse/<mint>` en a besoin au démarrage. Un client `fetch` maison est écarté (CSRF, refresh, maintenance à réécrire, risque fort). |
| `rxjs` | ≈ 20 kB | framework | Garder (requis par router et `HttpClient`). |
| `feature-analyse/analysis` | 21,9 kB | ui-mobile-first | `analysis-result` (10 kB), `shield-scan`, `analysis-loading` : chemin du LCP de `/analyse/<mint>`, **gardés**. `check-help` (4,4 kB) + `RjBottomSheet` (5,2 kB, aussi utilisé par `follow-button`) : `@defer (on interaction)` à l'ouverture : **G4**. |
| `feature-analyse/pages` | 13,6 kB | ui-mobile-first | Garder (`/analyse`, `/t` restent initiales, §10.2 point 2 : sortir `/t` recréerait la cascade du LCP). |
| icônes (`lucide` + `icons.ts`) | 11,8 kB | ui-mobile-first | Registre scindé : icônes de la coquille, de `/analyse` et de `/t` dans `web-ui` ; les autres enregistrées par chaque feature à la demande : **G2**. |
| `web-ui/navigation` | 11,6 kB | ui-mobile-first | `RjSidebar` (4,5 kB) déjà non rendue < 1024 px mais présente dans le JS : `@defer (when desktop())` avec la largeur réservée (CLS 0) : **G3**. |
| `web-ui/input-field` | 7,0 kB | ui-mobile-first | Garder (formulaire LCP de `/analyse`). |
| `data-access/auth` | 6,4 kB | ui-mobile-first | Garder (CSRF et session des intercepteurs). Report éventuel en chunk paresseux = **G8** (dernier recours). |
| `data-access/admin` | 5,4 kB | ui-mobile-first (+ admin-analytics) | **Hors du bundle initial** : `adminSessionInterceptor` ne fait rien hors `admin/*` et charge `AdminSessionStore` par import dynamique sur une requête `admin/*` ; garde `adminAreaGuard` inchangée (aucun chunk admin pour un non-admin) : **G1**. |
| `data-access/analysis` | 5,1 kB | ui-mobile-first | Garder (store et POST anticipé). |
| `toast`, `unread-alerts`, `attribution` | 6,2 kB | ui-mobile-first | `RjToastHost` créé au premier toast, compteur d'alertes non lues et validation de l'attribution chargés après le premier rendu (`runAfterFirstRoute`) : **G6**. |

Ce qui s'exécute avant le premier rendu (`apps/web/src/app/app.config.ts`) : `provideRouter` (+ input binding),
`provideHttpClient(withFetch(), 5 intercepteurs)`, `provideAppInitializer` de l'auth (relevé synchrone de l'URL
d'attribution seulement), `provideStartupPrefetch` (CSRF + `POST analyses` sur `/analyse/<mint>` seulement),
rendu de `RjAppShell` (barre d'onglets < 1024 px). Déjà différés : session, validation de l'attribution, quota,
contrats Zod (aucun chunk Zod dans `initial`, vérifié), service worker (après stabilisation, 30 s au plus),
`SwPush` (écran Compte), Chart.js et toute la feature admin, billing / bandeau d'essai (features à la demande),
formateurs `Intl` (au premier usage). Vérifié dans le metafile : ni `@angular/forms`, ni Zod, ni
`@angular/service-worker`, ni Chart.js dans `initial` (seul le petit enregistreur `service-worker.ts` y est).

**Écart 430 → 471 kB** (pas de rebuild des anciens commits : attribution par croissance des sources des modules
initiaux entre les commits de fin de phase, et inventaire) : code des libs web +11,6 kB (phase 4 +3,5 :
alertes non lues, `follow-button` ; phase 6 +0,6 ; phase 6 bis +7,0 : session admin, intercepteur, garde ;
après 6 bis +0,5) ; icônes 34 → 41 (+≈ 2 kB, phases 4–6 bis) ; CSS : utilitaires des nouvelles features
(compte, wallet, suivis, admin) ≈ +5 à 8 kB ; le reste (≈ 20 kB, non mesuré module par module) est attribué au framework :
montées mineures d'Angular 22.x et API nouvellement utilisées (`resource`, `effect` présents dans le chunk core).

**Gains classés (estimation brute, coût, risque)** — à appliquer dans cet ordre par ui-mobile-first (T3), un
build de prod après chacun :

| # | Gain | Estimation | Coût | Risque / garde-fou |
|---|---|---:|---|---|
| G1 | Admin hors initial (intercepteur à import dynamique) | −4,5 à −5 kB | faible | Test : requête non `admin/*` sans chunk admin ; 403 de session admin toujours géré. |
| G2 | Registre d'icônes scindé | −5 à −6 kB | moyen | Type `RjIconName` conservé ; icône inconnue = rien rendu (test). |
| G3 | `RjSidebar` en `@defer (when desktop())` | −4,5 à −6 kB | faible | CLS 0 à 1024/1440 (largeur réservée) ; e2e responsive. **Allège aussi le premier rendu mobile** (TBT). |
| G4 | Aide des contrôles + `RjBottomSheet` en `@defer (on interaction)` | −8 à −9 kB | faible à moyen | Focus et `aria` de l'ouverture conservés ; placeholder de même taille. |
| G5 | CSS : `@source not` de `/_design` et de `feature-admin` (+ feuille admin propre) | −4 à −8 kB | moyen | Captures admin identiques ; aucune classe manquante (test e2e admin). |
| G6 | Toast, alertes non lues, attribution après le premier rendu | −3 à −5 kB | faible | Gardes `whenReady` inchangées ; badge affiché après idle. |
| G7 | `withComponentInputBinding` retiré | −1 à −2 kB | moyen | Lecture explicite des paramètres sur toutes les routes. |
| G8 | Auth (store, API, refresh) en chunk paresseux | −4 à −5 kB | élevé | Seulement si > 420 kB après G1–G7 : CSRF du POST anticipé à préserver. |

G1 → G6 : **≈ −30 à −39 kB → 432 à 441 kB**. G7 + G8 : −5 à −7 kB de plus → **≈ 425 à 436 kB**. Conclusion :
**420 kB n'est pas atteignable sans toucher au framework** (core + router + http + rxjs = 289 kB, 61 % du
total) ; zod/mini est sans effet sur `initial` (Zod déjà hors initial) et reste écarté. Décision : T3 applique
G1 → G6 (puis G7/G8 seulement si Lighthouse < 95), budget `initial` relevé à **avertissement 440 kB / erreur
480 kB** une fois G1 → G6 mesurés (le budget suit la mesure, il ne la précède pas), et le critère de T3 qui
fait foi est **Lighthouse runner ≥ 95** (TBT, LCP), pas le poids brut. `modulepreload` : Angular l'émet déjà
pour tous les chunks initiaux ; aucun préchargement à ajouter pour les chunks différés (ils ne sont pas sur le
chemin du LCP).

Fichiers de diagnostic `docs/lighthouse/perf-{dbg,zod}` : dossiers vides, non suivis ; `perf-eager`, `perf-p2` :
ignorés par `.git/info/exclude`, non suivis. Rien à retirer de l'index.

### 10.7 `/t/<mint>` : verdict statique injecté et démarrage d'Angular à l'interaction (relecture finale, 2026-11-24)

**Constat** : runner 85–93 sur `/t/<mint>`, page déjà peinte (FCP = LCP 0,77 s), seule perte le TBT ≈ 400 ms
(`bootstrapApplication` + rendu de la coquille + rendu du verdict, une seule tâche). G1–G6 ont réduit le
bundle sans faire passer `/t` de façon stable : tant qu'Angular démarre pendant la fenêtre mesurée, la
tâche longue reste. Sur `/t`, la page est **en lecture seule** (pas de bouton « Suivre », deux liens et la
mention légale) : rien n'exige Angular pour la lire.

**Décision** : quand l'API sert `/t/<mint>` (Traefik envoie `/t/*` à `raijin-api`, `infra/nginx/web.conf`) et
qu'une analyse publiée existe, elle injecte **dans `<rj-root>`** un rendu HTML statique du verdict. L'app
**n'appelle pas** `bootstrapApplication` tant que ce rendu est présent, jusqu'à la **première interaction**.
L'évaluation du bundle `main-*.js` reste (script `type="module"` inchangé, compilé hors du fil principal par
Chrome) ; c'est le démarrage et le rendu, la partie lourde, qui sortent de la fenêtre mesurée. Pas de SSR,
pas d'hydratation, pas de script inline, **CSP inchangée**, aucune dépendance ajoutée.

Écarté : démarrer en idle (`requestIdleCallback`, minuterie) : la tâche longue resterait avant le TTI et
compterait dans le TBT ; rendre le bundle paresseux (`import()` depuis `main.ts`) : un aller-retour de plus
sur `/analyse` et `/analyse/<mint>` (servis par Nginx, 97–99 aujourd'hui) ; retirer ou réécrire la balise
`<script src="main-….js" type="module">` dans le HTML de `/t` : casse l'e2e « servie par l'API » et le
démarrage normal ; détecter Lighthouse ou `navigator.webdriver` : interdit (le comportement mesuré doit être
celui des visiteurs).

#### Contrat côté API (`libs/api/analysis/src/lib/share`)
1. **Quand** : `SharePageService.render(mint)` avec `mint` valide **et** `findLatest(mint)` non nul, gabarit
   du build web lu (pas le `minimalHtml`). Sinon rien n'est injecté (mint inconnu, page générique, gabarit
   absent) et l'app démarre normalement.
2. **Où** : le contenu de `<rj-root></rj-root>` du gabarit est remplacé (une seule occurrence, recherche
   insensible à la casse ; si la balise est introuvable : aucune injection, journal `warn` sans donnée).
   Les balises `<head>` (`injectMeta`), le `<script src="main-….js" type="module">`, les `modulepreload` et
   `analyse-prefetch.js` restent **intacts**.
3. **Format exact** (fonction pure `renderStaticVerdict(analysis, mint): string` exportée à côté de
   `injectMeta`, testée par instantané) :
   ```html
   <header class="rj-static__header">
     <div class="rj-static__bar">
       <a class="rj-static__brand" href="/" aria-label="Raijin Shield, accueil">
         <svg class="rj-static__logo rj-static__logo--mark" viewBox="8 2 48 60" aria-hidden="true" focusable="false">…symbole…</svg>
         <svg class="rj-static__logo rj-static__logo--wordmark" viewBox="8 2 204 60" aria-hidden="true" focusable="false">…logotype « Raijin SHIELD »…</svg>
       </a>
     </div>
   </header>
   <main data-rj-static="t" class="rj-static" aria-labelledby="rj-static-title">
     <p class="rj-static__eyebrow">Analyse partagée</p>
     <h1 id="rj-static-title" class="rj-static__title">Verdict Raijin</h1>
     <p class="rj-static__verdict" data-verdict="safe|warn|danger" role="status" aria-label="Verdict : {VERDICT_LABELS[verdict]}">{VERDICT_LABELS[verdict]}</p>
     <!-- seulement si symbol ?? name : -->
     <p class="rj-static__token">Symbole déclaré « {symbole} » (non vérifié)</p>
     <p class="rj-static__explanation">{explanation}</p>
     <p class="rj-static__date">Analyse du <time datetime="{analyzedAt ISO}">{date fr-FR, Europe/Paris}</time></p>
     <!-- seulement si degraded : -->
     <p class="rj-static__note">Résultat partiel : une source était indisponible.</p>
     <nav class="rj-static__actions" aria-label="Actions">
       <a class="rj-static__link" href="/analyse/{mint}">Réanalyser ce token</a>
       <a class="rj-static__link rj-static__link--primary" href="/analyse">Analyser un autre token</a>
     </nav>
     <p class="rj-static__disclaimer" data-disclaimer>{ANALYSIS_DISCLAIMER}</p>
   </main>
   ```
   Textes repris des constantes de `@raijin/shared-contracts` (`VERDICT_LABELS`, `ANALYSIS_DISCLAIMER`) et des
   libellés de `public-token.page.ts` (aucun texte réécrit à la main) ; liens **relatifs**, mêmes `href` que
   la page Angular. Ni score, ni contrôles, ni image : la version complète arrive avec Angular. L'en-tête
   (avant `<main>`, frère dans `<rj-root>` : le sélecteur `rj-root > [data-rj-static="t"]` reste valable) remplace
   celui de `RjAppShell` : logo officiel inline et décoratif comme `RjLogo` « auto » (géométrie de
   `libs/brand/logos`, symbole seul sous 360 px, logotype complet au-delà ; couleurs et police par classes,
   tokens), lien relatif vers l'accueil ; barre `rj-static__bar` alignée sur la colonne de `.rj-static` (même
   `max-width` et mêmes marges à chaque point de rupture) ; aucune ressource externe, CSP inchangée.
4. **Échappement** : chaque valeur dynamique passe par `escapeHtml` (déjà exportée, `& < > " '`), y compris
   `mint` (déjà validé base58 en amont) et le libellé du verdict ; symbole et nom du token (non fiables)
   tronqués à 32 caractères (`Array.from`, pas de coupure d'emoji) puis échappés, toujours entre « » et
   marqués « non vérifié ». Aucun attribut `style`, aucun `on*`, aucun `<script>`, aucune URL issue des
   données du token. Tests : nom contenant `</rj-root><script>`, `"`, `'`, `&` et un emoji → rendu inerte.
5. **Cache** : `Cache-Control` actuel de `/t` inchangé ; le HTML suit la dernière analyse publiée (même
   source que les balises OG).

#### Contrat côté app (`apps/web`, `libs/web/*`)
1. **Porte de démarrage** : fonction `startWhenInteractive(start: () => void): void` dans
   `@raijin/web-data-access` (fichier `startup-gate.ts`, sans Angular, testée avec Vitest + jsdom). `main.ts` se
   limite à `startWhenInteractive(() => bootstrapApplication(App, appConfig).catch(…))` (aucune logique dans
   l'app). Règle : si `location.pathname` correspond à `/t/<mint>` **et** que
   `document.querySelector('rj-root > [data-rj-static="t"]')` existe **et** que `location.search` est vide,
   attendre ; sinon `start()` tout de suite (comportement actuel sur toutes les autres routes, en dev sur
   `:4200` où rien n'est injecté, et quand l'URL porte des paramètres d'attribution `utm_*` : l'attribution
   doit être relevée par `provideAppInitializer` avant qu'un lien statique ne recharge la page).
2. **Interaction** : premier `pointerdown`, `touchstart`, `keydown` ou `focusin` sur `document`
   (écouteurs `{ capture: true, passive: true, once: true }`, tous retirés au premier déclenchement),
   `start()` appelé une seule fois. Pas de démarrage sur `scroll`, pas de minuterie de repli. Un lien statique
   touché déclenche une navigation pleine page normale (servie par Nginx), sans dépendre d'Angular.
3. **Prise de relais** : Angular vide `<rj-root>` au démarrage (pas d'hydratation) et rend la coquille et
   `PublicTokenPage` comme aujourd'hui ; la donnée vient de `window.__rjStartup` (préchargement
   `analyse-prefetch.js` **inchangé**, `GET …/latest` parti à la lecture du HTML) si elle a moins de 30 s
   (`MAX_AGE_MS`), sinon d'une nouvelle lecture. Le décalage visuel éventuel suit une saisie (exclu du CLS).
4. **Styles** : classes `rj-static*` définies dans `libs/web/ui/src/styles/` (fichier `static-verdict.css`
   importé par `theme.css`), **uniquement avec les tokens** (`var(--…)` / `@apply` des utilitaires du thème),
   alignées visuellement sur `PublicTokenPage` dans la coquille mobile (mêmes marges que le `<main>` de
   `RjAppShell`, badge de verdict aux couleurs `safe/warn/danger` via `[data-verdict]`, liens d'au moins 44 px
   de haut, focus visible). Ces classes sont un **contrat stable** : l'API ne dépend d'aucun utilitaire
   Tailwind généré (le scan de Tailwind ne voit pas `libs/api`).
5. **Ce qui attend l'interaction** sur `/t` : session, quota, attribution sans paramètre, service worker,
   bandeau de consentement GA4. Accepté : la page est lisible et ses liens marchent sans eux.

#### Critères d'acceptation
- Unitaires : `renderStaticVerdict` (instantanés safe / warn / danger, `degraded`, sans symbole, échappement) ;
  injection dans `<rj-root>` et absence d'injection (mint inconnu, gabarit sans `<rj-root>`) ;
  `startWhenInteractive` (démarrage immédiat hors `/t`, sans balise statique, avec `?utm_source=…` ; attente
  puis un seul démarrage à la première interaction ; écouteurs retirés).
- e2e existants verts sans modification (`analysis.flow` « page publique /t/<mint> » : le serveur de dev
  n'injecte rien ; le test « servie par l'API » voit toujours `og:*` et `<script src="main-….js" type="module">`).
- e2e ajouté (test-e2e), sur l'origine de production : `/t/<BONK>` affiche `[data-rj-static="t"]` avec
  « Prudence », les deux liens et `[data-disclaimer]` **sans** interaction ; après un `tap`, `main h1` vaut
  « Verdict Raijin » rendu par Angular et le titre devient celui de l'app ; 0 erreur console, 0 violation
  CSP ; axe sans violation sur la version statique ; captures 360 et 1440.
- Lighthouse runner : `/t/<mint>` ≥ 95 sur 3 passages (TBT ≤ 100 ms attendu), `/analyse` et `/analyse/<mint>`
  sans recul.

## 11. Suivis, alertes et push (phase 4)

### 11.1 Découpage
- **Contrats** (`@raijin/shared-contracts`) : `watch/` (`watchCreateRequestSchema` `{mint}`, `watchUpdateRequestSchema`
  `{status}`, `watchSchema` avec `lastVerdict` et `unreadAlerts`, `planLimitsSchema`, `watchListResponseSchema`,
  `watchSnapshotSchema` serveur/banc, `WATCH_ERROR_CODES`), `alerts/` (`ALERT_TYPES`, payloads par type,
  `alertSchema` union discriminée sur `type`, `alertListQuerySchema` (statut lu/non lu, types, mint, curseur),
  `alertReadRequestSchema`, `watchEventSchema` + `dedupeKey`), `notifications/` (préférences, réglages,
  `PUSH_SERVICE_HOSTS`, abonnement, clé VAPID publique, charge utile au format `ngsw`), `pagination.ts`.
  `TOKEN_UNANALYZABLE` (m4) et `MAINTENANCE` ajoutés aux codes d'erreur.
- **`libs/shared/risk-engine`** (pur, solana-data) : `detectWatchEvents(previous, next, thresholds)` →
  `WatchEvent[]`, `mergeWatchSnapshot`, seuils exportés (`WATCH_EVENT_THRESHOLDS`), `WATCH_RULES_VERSION` ;
  règles documentées dans `docs/SCORING.md` (section « Événements de suivi »). Le banc pourra les rejouer.
- **`libs/api/solana`** (solana-data) : collecteurs d'instantanés `collectAuthoritiesBatch(mints ≤ 100)`,
  `collectPoolsBatch(mints ≤ 30)`, `collectHolders(mint)`, sur les clients et `UpstreamGate` existants ;
  budget de crédits par voie (`interactive` | `watch`).
- **`libs/api/alerts`** (nestjs-api) : suivis (CRUD, limites), état par mint, planificateur et workers BullMQ,
  détection → `WatchEvent` → `Alert`, endpoints alertes, purges, `JobRun`.
- **`libs/api/notifications`** (nestjs-api) : `PushSender` (`WebPushSender` / `FakePushSender`), abonnements,
  préférences, e-mail d'alerte groupé (Rai PNG 2x), résumé hebdomadaire.
- **Web** (ui-mobile-first) : `web-feature-suivis` (Suivis, Alertes), `web-feature-compte` (préférences),
  `web-data-access` (`WatchesStore`, `AlertsStore`, `PushService` sur `SwPush`), `web-ui` (`rj-status-page` : 404 et
  maintenance avec Rai bravo), `apps/web` (routes, `provideServiceWorker`, `ngsw-config.json`).

### 11.2 Routes (`/api/v1`, session + e-mail vérifié sauf mention, CSRF sur les mutations)
`GET watches` · `POST watches` (201, 200 si déjà suivi ; 404 `ANALYSIS_NOT_FOUND` sans analyse ≤ 24 h ; 403
`WATCH_LIMIT_REACHED`) · `PATCH watches/:id` · `DELETE watches/:id` (204) · `GET alerts` · `GET alerts/unread-count` ·
`POST alerts/read` · `GET notifications/settings` · `PATCH notifications/preferences` ·
`GET push/vapid-public-key` (public ; 503 `PUSH_NOT_SUPPORTED` sans clés) · `POST push/subscriptions` (403
`PUSH_PLAN_REQUIRED` en Gratuit) · `POST push/unsubscribe` (204) · `POST internal/jobs/:name/run` (seulement si
`JOBS_TEST_TRIGGER=1`, refusé en production). Ressource d'un autre utilisateur : toujours 404.

### 11.3 Jobs : BullMQ (tranché) plutôt que `@nestjs/schedule`
- **BullMQ** (`bullmq` + `@nestjs/bullmq`, sur le Redis déjà présent) : planification persistante (Job Schedulers),
  reprises avec backoff, déduplication par `jobId`, concurrence par worker, survie aux redémarrages ; même technologie
  que l'API du banc (phase 8 bis). `@nestjs/schedule` écarté : cron en mémoire, sans reprise, sans déduplication, passes
  qui se chevauchent si un traitement dépasse la période, jobs perdus au redémarrage.
- Files : `watch` (planificateur + passes), `notify` (push, e-mail groupé), `maintenance` (purges ; la fin d'essai
  horaire de la phase 6 s'y ajoute). Préfixe `BULLMQ_PREFIX` (`raijin`, banc `raijin-bench`).
- Redis : BullMQ exige `maxmemory-policy noeviction` ; toutes les clés de cache ont un TTL (déjà le cas). À poser dans
  `docker-compose.dev.yml` maintenant et dans le compose de prod (phase 8). `pnpm install` : vérifier les scripts
  d'installation (`msgpackr-extract` est déjà refusé dans `allowBuilds`) et `pnpm audit --prod`.
- **Anti-chevauchement** : planificateur unique (`watch-planner`, toutes les `WATCH_TICK_SECONDS`), worker de
  concurrence 1 + verrou Redis `lock:watch-planner` (`SET NX PX`) ; passes en `jobId` déterministe
  (`fast:<créneau>:<lot>`, `holders:<mint>:<créneau>`, `full:<mint>:<créneau>`) : un doublon est ignoré par BullMQ ;
  verrou par mint (`lock:watch:mint:<mint>`) + `revision` optimiste sur l'état du mint.
- **Journal** : une ligne `JobRun` par exécution du planificateur et de chaque purge (statut, durée, `details` Json :
  mints traités, crédits, événements, alertes ; erreur = **code** seulement). `JobRun` purgé à 30 jours.
- Tests : `JOBS_ENABLED=false` en unitaire (services testés sans Redis via ports) ; e2e avec Redis réel et
  `JOBS_TEST_TRIGGER=1`.

### 11.4 Fréquence, étalement et budget Helius (1 M crédits/mois partagés avec le banc)
- 1 M/mois ≈ **33 300 crédits/jour** : banc 10 000, API 22 000 (`HELIUS_DAILY_CREDIT_BUDGET`), marge ≈ 1 300.
  Dans l'API, voie `watch` plafonnée à **12 000/jour** (`WATCH_DAILY_CREDIT_BUDGET`) ; les analyses à la demande gardent
  au moins 10 000 (≈ 700 analyses fraîches à ~14 crédits). Compteurs Redis `helius:credits:<jour>` (global) et
  `helius:credits:watch:<jour>` (voie), même script Lua atomique.
- **L'état est par mint, pas par suivi** : 40 utilisateurs qui suivent BONK coûtent une seule réanalyse.
- Trois passes par mint (coûts Helius : RPC 1 crédit, DAS 10) :

  | Passe | Défaut | Appels | Crédits | Par jour |
  |---|---|---|---|---|
  | Rapide (autorités + pool) | 5 min | `getMultipleAccounts` jsonParsed par lots de 100 + DexScreener `tokens/v1` par lots de 30 (gratuit) | 1 par lot de 100 mints | 288 × ⌈N/100⌉ |
  | Holders (top 20) | 30 min | `getTokenLargestAccounts` + propriétaires et programmes en cache 24 h | ≈ 1,2 par mint | ≈ 58 par mint |
  | Complète (verdict) | 6 h | `collectFacts(full)` du moteur (cache d'âge 24 h) | ≈ 15 par mint | ≈ 60 par mint |

  Soit ≈ **118 crédits/jour par mint + 288 fixes** pour 100 mints : capacité ≈ (12 000 − 288) / 118 ≈ **99 mints
  distincts** à la cadence par défaut. Un événement critique déclenche une passe complète anticipée (au plus 1 par mint
  et par heure).
- **Au-delà** : le planificateur calcule `f = demande estimée / budget restant` et étire les intervalles holders et
  complète par `f` (la passe rapide, quasi gratuite, reste à 5 min) ; mints suivis par un Pro ou l'essai d'abord, puis
  le plus en retard. Ex. 300 mints : demande ≈ 36 300 → f ≈ 3 → holders toutes les 1 h 30, verdict toutes les 18 h.
  Budget de la voie épuisé : passes reportées au lendemain (jamais d'erreur), visible dans `JobRun.details`.
- **Étalement** : première échéance = maintenant + (hash(mint) mod intervalle), puis `+ intervalle` ; 100 mints à 30 min
  ≈ 3,3 passes holders/min, très en dessous de 7 req/s. Passes complètes en concurrence 1, holders en concurrence 2.
- **Sans clé Helius** : RPC public (1 req/s) pour la passe rapide ; `getTokenLargestAccounts` refusé → pas de détection
  `holder_sold` (groupe `holders` à `null`, aucun faux positif).

### 11.5 Faits stockés pour la comparaison
- `MintWatchState` (une ligne par mint suivi, supprimée quand plus personne ne le suit) : `snapshot` Json
  (`WatchSnapshot` v1 : groupes `authorities`, `pool` avec `sqrtK`, `peakSqrtK`/`peakAt`, `holders` top 20 avec montants
  bruts u64 en texte, `verdict`), chacun daté ; `revision` ; `nextFastAt`, `nextHoldersAt`, `nextFullAt` ; `priority` ;
  `consecutiveFailures`, `lastErrorCode` ; `unanalyzable`. Seul le dernier instantané est gardé ; l'historique, ce sont
  les `WatchEvent`.
- **Règles** (`detectWatchEvents`, première observation d'un groupe = référence, jamais d'alerte) :
  verdict plus grave (rang safe < warn < danger ; re-référence sans alerte si la version majeure du moteur change) ;
  **LP retirée > 30 %** : baisse de √(base × quote) du pool principal par rapport au plus haut des 6 dernières heures
  (invariant d'un pool à produit constant : un swap ne le fait pas baisser, un retrait si ; approximation pour les pools
  concentrés, documentée) ; mint ou freeze de nouveau actif (révoqué → actif) ; **holder > 5 % qui vend** : holder ≥ 5 %
  (exclusions de la concentration) dont la position baisse d'au moins 25 % ou d'au moins 1 point d'offre, ou qui sort du
  top 20 (« vente ou transfert », on ne lit pas les transactions). Gravité : `danger` pour LP, mint, freeze et verdict →
  Danger ; `warn` sinon.
- `Watch` : + `status`, `pausedReason`, `pausedAt` ; `lastVerdict`/`lastCheckedAt` recopiés à chaque passe complète.
  `WatchService.enforcePlanLimit(userId)` met en pause (`plan_limit`) les suivis au-delà de la limite, les plus récents
  d'abord : utilisé par la fin d'essai (phase 6).
- Préférences : colonnes `User.notifyEmailAlerts` (true), `notifyPushAlerts` (true), `notifyWeeklyDigest` (false).

### 11.6 Idempotence des alertes (aucun doublon)
- `WatchEvent` (`mint`, `type`, `severity`, `payload`, `dedupeKey`, `detectedAt`) avec `@@unique([mint, dedupeKey])` ;
  `Alert.eventId` avec `@@unique([userId, eventId])`. Insertion `ON CONFLICT DO NOTHING` dans la même transaction que la
  mise à jour de l'état du mint : rejouer une passe (reprise BullMQ, redémarrage) ne crée rien de plus.
- Clés : `verdict_degraded:<from>><to>:<analysisId>`, `lp_removed:<pool>:<peakAt>` (référence remise au niveau
  courant après l'alerte), `mint_reactivated:<observedAt>`, `freeze_reactivated:<observedAt>`,
  `holder_sold:<owner>:<observedAt précédent>`. Délai de grâce `ALERT_COOLDOWN_MINUTES` (6 h) par mint et type, sauf
  aggravation (Prudence → Danger).
- Diffusion : suivis **actifs** du mint créés avant `detectedAt`. Livraison réservée par
  `UPDATE … SET pushedAt/emailedAt = now() WHERE … IS NULL` avant l'envoi (jamais deux fois), relâchée si l'envoi
  échoue (reprise BullMQ, 5 tentatives). E-mail **groupé** par utilisateur (`ALERT_EMAIL_BATCH_DELAY_S`, job
  `email:<userId>:<fenêtre>`), plafonné à `ALERT_EMAIL_DAILY_MAX`/jour, exige un e-mail vérifié ; push par alerte
  (`tag` = mint, les notifications d'un même token se remplacent). Gratuit : e-mail seulement ; Pro et essai : push et/ou
  e-mail selon les préférences.

### 11.7 Push : service worker Angular et sécurité
- **`@angular/service-worker`** (déjà en dépendance) : `ngsw-config.json` (coquille et assets en cache, **aucun
  `dataGroups` sur `/api`** : données toujours fraîches), `provideServiceWorker('ngsw-worker.js', { enabled:
  !isDevMode(), registrationStrategy: 'registerWhenStable:30000' })` (enregistré après le rendu : sans effet sur le LCP).
  `SwPush.requestSubscription({ serverPublicKey })` ; l'affichage et le clic sont gérés par `ngsw-worker.js` grâce à
  la charge utile `{ notification: { …, data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen',
  url } } } } }` (`pushNotificationPayloadSchema`) : **aucun service worker maison**, compatible CSP `script-src 'self'`.
- **Permission demandée au bon moment** : jamais au chargement ; seulement après un geste explicite (bouton
  « Activer les notifications » dans Compte, ou carte proposée après le premier suivi d'un compte Pro). iOS hors PWA
  installée (`navigator.standalone !== true`) : explication « Partager → Sur l'écran d'accueil » au lieu de la demande.
  Refus : message neutre, pas de relance automatique.
- **Sécurité** : `VAPID_PRIVATE_KEY` uniquement dans l'environnement de l'API (config Zod : les deux clés ou aucune) ;
  la clé publique est servie par l'API (pas compilée dans le front). Endpoint filtré par `PUSH_SERVICE_HOSTS` (https,
  pas de SSRF), timeout 5 s, TTL 24 h, urgence `high` pour Danger. Réponse 404/410 du service push → abonnement
  supprimé ; autres erreurs → code seulement dans les logs (jamais l'endpoint, qui identifie l'appareil). 10 abonnements
  max par compte (le plus ancien remplacé) ; un endpoint ré-abonné par un autre compte lui est réattribué (appareil
  partagé). Déconnexion : le front se désabonne. Charge utile sans e-mail ni donnée de compte, texte nettoyé.
- Dev : service worker inactif en `serve` ; le push se teste sur le build de production servi en local (`localhost`
  est un contexte sécurisé). e2e : `PUSH_PROVIDER=fake` (notifications enregistrées par l'API, lues par le test).

### 11.8 E-mails d'alerte et Rai en PNG 2x
- Template `alert` (thème clair, logo, **Rai pose alerte au-dessus du verdict**, `width="120" height="140"`,
  alt « Rai, la mascotte de Raijin, en alerte »), une ligne par alerte (type, token tronqué « non vérifié », chiffres),
  bouton vers `/alertes`, rappel « pas un conseil en investissement », lien de désactivation vers les préférences.
- PNG rendus depuis `libs/brand/mascot/rai-alerte.svg` et `rai-bravo.svg` (viewBox 240×280) en 2x (240×280 px pour un
  affichage 120×140) par `tools/scripts/render-mascot-png.mjs` avec `@resvg/resvg-wasm` (déjà en dépendance, aucun
  binaire natif) ; fichiers commités dans `apps/web/public/email/` (`rai-alerte@2x.png`, `rai-bravo@2x.png`), test de
  dimensions et de fraîcheur (hash du SVG source).
- **Hébergement** : `APP_URL/email/…` (même origine publique que le logo déjà utilisé, servie par le conteneur web) ;
  `MAIL_ASSETS_BASE_URL` permet de pointer ailleurs. La landing n'est pas retenue (déployée à part, phase 7).

### 11.9 Purges (job quotidien `PURGE_CRON`, par lots de 5 000 lignes)
`TokenAnalysis`, `ProductEvent` (après l'agrégation nocturne de la phase 6 bis), `UsageCounter`, `TrialFingerprint`,
`Alert`, `WatchEvent` : plus de `RETENTION_DAYS` (90) jours. `JobRun` : 30 jours. Sessions expirées depuis plus d'un
jour ou révoquées depuis plus de 7 jours (cascade sur leurs refresh tokens ; les refresh utilisés d'une session vivante
restent, ils servent à détecter la réutilisation). `AuthToken` expirés depuis plus d'un jour. `MintWatchState` sans
suivi. Chaque purge écrit son `JobRun` (nombre de lignes par table).

### 11.10 404 et maintenance
`rj-status-page` (`web-ui`, présentation pure : Rai bravo, titre, phrase, lien de retour) ; route `**` → 404 (au lieu
de la redirection actuelle vers `/analyse`), route `/maintenance`. `MAINTENANCE_MODE=1` : l'API répond 503
`MAINTENANCE` (sauf `health`) et un intercepteur de `web-data-access` affiche `/maintenance`. Une page statique
`maintenance-static.html` (sans JS) est aussi produite pour la page d'erreur Traefik (phase 8).

## 12. Scan de wallet (phase 5)

### 12.1 Découpage
- **Contrats** (`@raijin/shared-contracts`, `src/lib/wallet/`) : `walletScanRequestSchema` (`{address}` strict, base58,
  refus des programmes et mints connus `KNOWN_NON_WALLET_ADDRESSES`), `walletScanResultSchema` (`summary`, `tokens` ≤ 100
  triés par valeur, `delegations` ≤ 100, `sources`, `engineVersion`, `scannedAt`, `cached`, `partial`),
  `walletTokenSchema` (mint, programme, métadonnées **non fiables**, `balance` {raw u64, decimals, ui exact},
  `valueUsd` indicatif, `accountCount`, `frozen`, `delegated`, `assessment` union `analyzed` (verdict, explication,
  `coverage` full | light, `checksEvaluated` /9, `degraded`, `fromCache`) | `not_analyzed` (over_limit | dust) |
  `unavailable` (upstream | timeout | budget | unanalyzable)), `walletDelegationSchema` (compte, mint, `delegate`,
  `delegatedAmount`, solde, `coversFullBalance`), `walletScanResponseSchema` (`{scan, quota}` kind `wallet_scan`),
  `walletScanQuotaResponseSchema` (`{allowed, quota}` : Gratuit `false`/`null`), `WALLET_ERROR_CODES` (`WALLET_INVALID`,
  `WALLET_IS_TOKEN`, `WALLET_SCAN_PLAN_REQUIRED`, `WALLET_TOO_LARGE`, `WALLET_SCAN_QUOTA_EXCEEDED`) + messages,
  `WALLET_REVOKE_GUIDES` (liste blanche d'URLs exactes), `WALLET_SCAN_READ_ONLY_NOTICE`, `WALLET_DELEGATION_EXPLANATION`.
- **`libs/api/solana`** (solana-data) : `listWalletHoldings(address)` (nature du compte, comptes SPL + Token-2022,
  délégations, agrégation par mint, prix DexScreener par lots) et `collectFactsLightBatch(mints)` (faits `light` d'un lot
  de mints, appels groupés) ; voie de budget `wallet` (`CreditLane = 'interactive' | 'watch' | 'wallet'`).
- **`libs/shared/risk-engine`** (solana-data) : règle **D3** (12.4) ; aucune autre règle modifiée.
- **`libs/api/wallet`** (`api-wallet`, `scope:api`, `type:feature`, généré vide) : contrôleur, droits par plan, quota,
  cache, orchestration, `ProductEvent`.
- **Web** (ui-mobile-first) : `web-feature-wallet` (écran `/wallet`, déjà routé), `web-data-access` (`WalletScanService`,
  messages via la table exhaustive `api-error.ts`, déjà complétée par les codes `WALLET_*`).

### 12.2 Routes (`/api/v1`, session obligatoire, CSRF sur la mutation)
`POST wallet-scans` (`WalletScanRequest` → `WalletScanResponse`) · `GET wallet-scans/quota` (`WalletScanQuotaResponse`).
Ordre des contrôles : session (401 `UNAUTHORIZED`) → plan (Gratuit, e-mail non vérifié compris : 403
`WALLET_SCAN_PLAN_REQUIRED`, aucun compteur touché) → schéma (400 `WALLET_INVALID`, aussi pour un programme connu ;
422 `WALLET_IS_TOKEN` pour un mint connu) → cache du wallet → réservation du quota (429 `WALLET_SCAN_QUOTA_EXCEEDED`) →
collecte. Throttler dédié : 5 scans/min par utilisateur (en plus du global). L'adresse ne passe **jamais** dans l'URL
(ni chemin ni query) : pas d'historique de navigateur ni de journal d'accès Traefik qui la contienne.

### 12.3 Sources et coût par scan (Helius : RPC standard 1 crédit, toute méthode DAS 10 crédits, vérifié le 2026-11-22 sur https://www.helius.dev/docs/billing/credits)
1. Nature de l'adresse : `getAccountInfo` jsonParsed (1) → programme exécutable ou compte de token : `WALLET_INVALID` ;
   mint : `WALLET_IS_TOKEN` ; compte absent = wallet sans SOL, scan normal (résultat vide possible).
2. Comptes : `getTokenAccountsByOwner` jsonParsed × 2 programmes (SPL `Tokenkeg…`, Token-2022 `Tokenz…`) en parallèle (2).
   jsonParsed donne pour les deux programmes `mint`, `tokenAmount`, `state` (frozen), `delegate`, `delegatedAmount` : c'est
   la source des délégations (**sur tous les comptes**, vides, poussière et NFT compris). Plus de
   `WALLET_SCAN_MAX_ACCOUNTS` (1 000) comptes → 422 `WALLET_TOO_LARGE` (quota remboursé). DAS `getAssetsByOwner` /
   `getTokenAccounts` **écartés** (10 crédits par page, et `getAssetsByOwner` ne donne pas le délégué).
3. Classement : comptes à solde 0 → `emptyAccountCount` ; 0 décimale et solde 1 → `nftCount` (ignorés) ; le reste agrégé
   par mint (somme u64 en `BigInt`). Prix DexScreener `tokens/v1` par lots de 30 (gratuit, ≈ 4 req/s) pour
   `WALLET_SCAN_PRICE_LOOKUP_MAX` (150) mints au plus. Prix connu et valeur < `WALLET_SCAN_DUST_USD` (1 USD) →
   `not_analyzed: dust`. **Prix inconnu ≠ poussière** (les airdrops d'arnaque n'ont souvent pas de prix : ce sont eux
   qu'il faut vérifier). Tri : valeur connue décroissante, puis valeur inconnue ; les `WALLET_SCAN_MAX_TOKENS` (20 ; 8
   sans clé) premiers sont analysés, les suivants `not_analyzed: over_limit`.
4. Verdicts : d'abord le cache (12.5), puis `collectFactsLightBatch` pour les manquants seulement : `getMultipleAccounts`
   des mints (1 par lot de 100), DAS `getAssetBatch` (10 pour tout le lot, métadonnées et update authority), DexScreener
   déjà en main (gratuit), holders par mint `getTokenLargestAccounts` + propriétaires `getMultipleAccounts` (≈ 2, cache
   des propriétaires 24 h). Pas de devis Jupiter, ni historique du créateur, ni RugCheck, ni GeckoTerminal.

| Scan avec clé, 20 tokens à analyser | Crédits |
|---|---|
| Nature de l'adresse + comptes (1 + 2) | 3 |
| Mints (1 lot) + `getAssetBatch` (1 lot) | 11 |
| Holders (20 × ≈ 2) | ≈ 40 |
| **Total à froid** | **≈ 54** (contre ≈ 263 avec 20 × `collectFacts(light)` : DAS `getAsset` à 10 par mint) |
| Wallet en cache / tous les verdicts en cache | 0 / 3 |

- Budget : voie `wallet` plafonnée à **3 000 crédits/jour** (`WALLET_DAILY_CREDIT_BUDGET`, compteur Redis
  `helius:credits:wallet:<jour>`, même script Lua que §11.4), prise sur la part interactive : API 22 000 = suivis 12 000 +
  wallet 3 000 + analyses ≥ 7 000 (≈ 500 analyses fraîches à ~14). 3 000 / 54 ≈ **55 scans à froid par jour** au pire,
  bien plus en pratique (verdicts en cache sur les tokens courants). Validation au démarrage :
  `WATCH_DAILY_CREDIT_BUDGET + WALLET_DAILY_CREDIT_BUDGET ≤ HELIUS_DAILY_CREDIT_BUDGET`.
- Voie épuisée : la liste et les délégations restent servies (3 crédits, sinon RPC public), les tokens non verdictés
  passent `unavailable: budget`, `partial: true` ; jamais d'erreur bloquante. Liste impossible (sources en panne) → 503
  `UPSTREAM_UNAVAILABLE`, quota remboursé.
- Échéance globale `WALLET_SCAN_DEADLINE_MS` (15 s) : les tokens non terminés passent `unavailable: timeout`. Durée
  attendue avec clé : ≈ 4 à 6 s à froid (holders à 7 req/s partagés), < 300 ms en cache.

### 12.4 Verdict rapide (`coverage: light`) et règle D3
Le profil `light` laisse trois groupes à `null` (devis de vente, créateur, RugCheck) : avec D2 (≥ 3 indisponibles →
jamais Sain), aucun token ne pourrait être Sain. **D3** (à écrire dans `docs/SCORING.md` par solana-data) : un groupe
**non demandé par le profil** est « non évalué », pas « indisponible » ; il ne compte pas pour D2, qui s'applique aux
seuls contrôles demandés. Mise en œuvre sans changer la signature `EvaluateRisk` : une seconde instance
`createRiskEngine({ ...config, notEvaluated: ['sellSimulation', 'creator', 'rugcheck'] })`. D1 inchangée (compte de mint
illisible → `unavailable: upstream`). Le front affiche « Sain · contrôle rapide (6/9) » avec le rappel
`SAFE_VERDICT_REMINDER` et le lien vers l'analyse complète ; un Danger reste un Danger (critères mint, freeze et LP
retirée évalués ; honeypot non évalué en rapide, ce que dit la phrase d'explication).

### 12.5 Caches et réutilisation par mint
1. Analyse complète récente : Redis `analysis:result:<engineVersion>:<mint>` (60 s), sinon dernière `TokenAnalysis`
   ≤ `WALLET_REUSE_ANALYSIS_MAX_AGE_S` (1 h) → `coverage: full`, `fromCache: true`.
2. Verdict rapide : Redis `wallet:verdict:<engineVersion>:<mint>` (`WALLET_TOKEN_VERDICT_TTL_S`, 1 h), partagé entre
   utilisateurs. Les verdicts rapides ne sont **pas** écrits dans `TokenAnalysis` (la page publique `/t/<mint>` et les
   suivis ne montrent que des analyses complètes).
3. Résultat du wallet : Redis `wallet:scan:<engineVersion>:<HMAC(IP_HASH_SECRET, adresse)>`, TTL 120 s (600 s sans clé),
   *single-flight* + verrou `wallet:lock:<hmac>` comme §9.5. Le même wallet re-scanné par le même utilisateur dans les
   10 min ne recompte pas le quota (`quota:seen:<userId>:wallet:<hmac>`).

### 12.6 Sans clé Helius
RPC public (1 req/s) : nature de l'adresse et comptes (3 appels ≈ 3 s ; `getTokenAccountsByOwner` y est accepté mais
lent, échéance 15 s), mints par `getMultipleAccounts`. Pas de DAS (métadonnées : extension Token-2022 ou nom
DexScreener, sinon `null`), `getTokenLargestAccounts` refusé (holders indisponibles). Plafond **8 tokens** analysés,
cache du wallet 600 s. `checksEvaluated` plus bas (≈ 4/9), `degraded: true` : rarement Sain, ce qui est honnête.

### 12.7 Quotas et droits
`UsageCounter` kind `wallet_scan` (déjà prévu), réservation atomique + remboursement (`WALLET_INVALID`, `WALLET_IS_TOKEN`,
`WALLET_TOO_LARGE`, `UPSTREAM_UNAVAILABLE`) comme §9.6. Pro `WALLET_SCAN_DAILY_LIMIT_PRO` (20), essai
`WALLET_SCAN_DAILY_LIMIT_TRIAL` (10, même logique que les analyses plafonnées pendant l'essai), Gratuit 0 (403). Plan et
essai relus en base à chaque requête ; la phase 6 branchera Stripe sans changer ce contrat.

### 12.8 Persistance et RGPD
Une adresse de wallet est une **donnée pseudonyme** (rattachable à une personne par l'historique on-chain) et la lier à
un compte révèle un patrimoine. Décision : **aucune persistance** de l'adresse ni du résultat en base (pas de table
`WalletScan`) ; cache Redis ≤ 10 min, clé HMAC ; rien à exporter ni à supprimer au titre du RGPD. `ProductEvent`
`wallet_scanned` sans adresse ni mint : `{ tokenCountBucket (0, 1-5, 6-20, 21-100, >100), analyzedCount, delegationCount,
cached, partial, durationMs, credits, plan, trialActive }`. Journaux : adresse tronquée (`truncateMiddle` 4…4) au plus,
jamais l'adresse du délégué ni la liste des mints. Pas d'historique des scans en v1 (une évolution demanderait un
consentement explicite et une purge courte). À mentionner dans la politique de confidentialité (phase 7).

### 12.9 Délégations et liens de révocation
- Délégation = `delegate` non nul sur un compte de token (SPL ou Token-2022), avec `delegatedAmount` ; listée même si le
  compte est vide. `coversFullBalance` si `delegatedAmount ≥ solde`. Le délégué permanent Token-2022 (au niveau du mint,
  non révocable par le holder) relève du verdict du token, pas de cette liste.
- Raijin ne propose **aucun** bouton de révocation (ce serait une transaction à signer) : il explique et renvoie vers la
  documentation officielle, liste blanche d'URLs exactes `WALLET_REVOKE_GUIDES` vérifiée le 2026-11-22 (HTTP 200,
  contenu relu) :
  - Phantom : `https://help.phantom.com/articles/revoke-token-approvals-19142125651731` (la page recommande un outil
    tiers pour Solana ; Raijin ne le lie pas directement, l'utilisateur suit le guide de Phantom) ;
  - Solflare : `https://www.solflare.com/glossary/token-approval/` (révocation dans Paramètres → Sécurité et
    confidentialité) et `https://help.solflare.com/en/articles/9267797-understanding-delegations-aka-spending-approvals-in-solflare`.
  Liens `target="_blank" rel="noopener noreferrer"`. URLs à revérifier en phase 9 (test-e2e : requête HEAD, statut 200).

### 12.10 Fixtures (solana-data)
Synthétiques au format jsonParsed réel : wallet avec délégation SPL et délégation Token-2022 (dont une sur compte vide),
wallet avec un token Danger (fixture « mint actif » existante) + un Sain + poussière + NFT, wallet vide (compte absent),
wallet > 1 000 comptes (`WALLET_TOO_LARGE`), adresse de mint (`WALLET_IS_TOKEN`), compte de programme (`WALLET_INVALID`).
Mêmes fixtures pour Jest, api-e2e (`ANALYSIS_FIXTURES=1`) et Playwright (réponses simulées issues des contrats).

## 13. Stripe et essai Pro (phase 6)

### 13.1 Découpage
- **`libs/api/auth`** (nestjs-api) : démarrage de l'essai dans `markEmailVerified` (même transaction que
  `emailVerifiedAt`), anti-abus (`TrialEligibilityService`), liste des domaines jetables. L'essai n'a **aucune** route
  de démarrage : il ne peut naître que de la vérification de l'e-mail.
- **`libs/api/core`** (nestjs-api) : `resolvePlanPolicy(row, limits, now)` et `buildTrialDetails(row, now)` **purs**
  (aucun accès base) + `PLAN_POLICY_USER_SELECT` ; seul calcul des droits et de l'état d'essai de toute l'API (§13.4).
- **`libs/api/trial`** (`api-trial`, généré vide ; nestjs-api) : job horaire de fin d'essai, e-mails J+1 / J-2 / J0,
  `GET trial/recap`, `POST trial/end-screen/seen`, événements `trial_*`, `GET admin/trial-conversion`.
- **`libs/api/billing`** (`api-billing`, vide ; stripe-billing) : `BillingProvider`, Checkout, portail, webhook,
  `Subscription`, passage Pro / Gratuit, simulation, e-mails reçu / échec de paiement (templates dans
  `api-notifications`).
- **`libs/api/alerts`** (nestjs-api) : `POST watches/keep`, `WatchesService.resumePlanLimited(userId)` (appelé par
  billing au passage Pro), `enforcePlanLimit` existant (appelé par trial et billing).
- Dépendances : `billing → alerts, notifications, core, prisma` ; `trial → alerts, notifications, core, prisma` ;
  `auth → notifications, core, prisma`. Ni billing ↔ trial (la fin d'essai à l'abonnement est une écriture `User` dans la
  transaction du webhook, documentée ici), ni cycle.
- **Front** (`ui-mobile-first`) : `libs/web/feature-compte` (page Abonnement, succès, simulation, écran de fin d'essai,
  choix des suivis), `libs/web/data-access` (`BillingApi`, `BillingStore`, `TrialApi`), bandeau d'essai dans la coque de
  l'app (`apps/web` ne fait que le placer : composant dans `feature-compte` ou `web-ui`).

### 13.2 Routes (`/api/v1`, contrats `billing/`, `trial/`, `watch/`)
| Route | Accès | Contrat |
|---|---|---|
| `GET billing/plans` | public | `BillingPlansResponse` |
| `GET billing/subscription` | session | `BillingAccount` |
| `POST billing/checkout-sessions` | session, e-mail vérifié, CSRF, 10/min | `CheckoutSessionRequest` → `BillingRedirect` |
| `POST billing/portal-sessions` | session, CSRF, 10/min | → `BillingRedirect` (`NO_BILLING_ACCOUNT`) |
| `POST billing/webhook` | Stripe (signature), sans CSRF ni session, corps brut ≤ 1 Mo | 200 / 400 `BILLING_WEBHOOK_INVALID` |
| `POST billing/simulation/checkout`, `…/portal` | `BILLING_PROVIDER=fake` hors production, session, CSRF | `FakeCheckoutCompleteRequest`, `FakePortalActionRequest` |
| `GET trial/recap` | session | `TrialRecap` (`TRIAL_NOT_FOUND`) |
| `POST trial/end-screen/seen` | session, CSRF | 204 |
| `POST watches/keep` | session, e-mail vérifié, CSRF | `WatchKeepRequest` → `WatchListResponse` |
| `GET admin/trial-conversion` | session, rôle ADMIN (garde `@Roles('ADMIN')` dans `api-auth`) | `TrialConversionReport` |
| `POST internal/billing/webhook-fixtures/:name` | `JOBS_TEST_TRIGGER=1` uniquement (404 sinon, refusé en prod) | fixture signée rejouée |

### 13.3 Modèle et machine d'états
- **Essai = base uniquement** (`User.trialStatus/trialStartedAt/trialEndsAt`). Stripe ne crée jamais d'essai
  (`trial_period_days` interdit) ; un statut Stripe `trialing` reçu est traité comme `active` (garde-fou).
- `User.trialStatus` : `NONE` → (`markEmailVerified` + éligible) `ACTIVE` | (refus) `INELIGIBLE` ;
  `ACTIVE` → `ENDED` par le job (échéance dépassée) **ou** par l'activation d'un abonnement (fin anticipée,
  `trialEndsAt = now`, `trial_converted {phase: during}`). `ENDED` et `INELIGIBLE` sont terminaux.
- `User.plan` = **plan payé** : `PRO` seulement si un `Subscription` a un statut Pro (`active`, `trialing`,
  `past_due`) ; il reste `FREE` pendant l'essai. Mis à jour **dans la transaction** qui écrit `Subscription`.
- `Subscription` (une ligne par abonnement Stripe) : + `lastEventAt` (horodatage Stripe du dernier événement appliqué),
  + `latestInvoiceId`. `past_due` garde Pro pendant les relances Stripe ; `unpaid`, `canceled`, `incomplete_expired`,
  `paused` → `FREE` + `enforcePlanLimit`. Réglage Stripe attendu : « si toutes les relances échouent : annuler
  l'abonnement » (https://dashboard.stripe.com/test/settings/billing/automatic).
- Nouvelles colonnes `User` : `notifyTrialEmails` (true), `trialDay1MailAt`, `trialDayMinus2MailAt`, `trialEndMailAt`,
  `trialEndScreenSeenAt`. Nouvelle table `TrialClaim` (§13.6). Migration par nestjs-api, colonnes `Subscription` par
  stripe-billing (deux migrations distinctes, nestjs-api d'abord).
- Un seul abonnement Pro à la fois : `ALREADY_SUBSCRIBED` à la création du Checkout (verrou `SELECT … FOR UPDATE` sur
  `User`) ; un second abonnement actif reçu par webhook est enregistré, journalisé (code) et laissé au portail.

### 13.4 Source de vérité des droits : `resolvePlanPolicy`
- Entrée : `{ plan, trialStatus, trialEndsAt, emailVerifiedAt }` relu en base **à chaque requête** ; sortie :
  `{ effectivePlan, source: free|trial|subscription, trialActive, entitlements }` (`entitlementsSchema`).
- Essai actif ⇔ `trialStatus = ACTIVE` **et** `trialEndsAt > now` (le job peut avoir une heure de retard : les droits,
  eux, s'arrêtent à la seconde). Priorité : abonnement Pro > essai actif > Gratuit.
- Valeurs (configuration, aucune en dur) : analyses anon 3 / Gratuit 5 / essai 50 / Pro illimité ; suivis Gratuit 3 /
  Pro et essai 50 ; push Pro et essai ; scan de wallet Pro 20 / essai 10 / Gratuit 0 ; historique d'alertes Gratuit
  30 j / Pro et essai 90 j. E-mail vérifié requis pour suivre et pour le push (inchangé).
- `QuotaService` (analysis), `PlanLimitsService` (alerts), `WalletAccessService` (wallet) et `api-billing` remplacent leurs
  trois calculs actuels par cette fonction (aucune règle dupliquée). Le front n'affiche que ce que l'API renvoie.

### 13.5 Webhooks : signature, idempotence, ordre
- Corps **brut** (`rawBody: true` sur cette route seulement), `Stripe-Signature` vérifiée par le SDK
  (`webhooks.constructEvent`, tolérance 300 s), `event.livemode` égal au mode de la clé, sinon 400 sans détail.
- **Idempotence transactionnelle** : dans une transaction, `INSERT StripeEvent(id, type)` puis application ; conflit
  d'unicité → 200 « déjà traité » ; erreur → rollback (l'événement n'est pas marqué) → 500 → Stripe réessaie.
- **Ordre** : jamais d'hypothèse. Pour un événement d'abonnement, l'état est relu via
  `BillingProvider.retrieveSubscription(id)` (source Stripe) puis appliqué si `event.created ≥ lastEventAt` ; plus ancien
  → marqué traité, ignoré. `checkout.session.completed` relit aussi l'abonnement (il peut arriver après `updated`).
- Rattachement à l'utilisateur : `subscription.metadata.userId` (posé via `subscription_data.metadata`), sinon
  `stripeCustomerId` ; inconnu → marqué traité, journalisé (code), 200.
- **Effets de bord après commit** : e-mails (reçu sur `invoice.paid`, échec sur `invoice.payment_failed`) en file BullMQ
  `notify` avec `jobId` = id de facture (aucun doublon) ; `resumePlanLimited` / `enforcePlanLimit` dans la transaction.
  Implémentation : job `billing-email` déclaré dans le `JobRegistry` d'`api-alerts` (réessais BullMQ ; le traitement
  relit l'adresse en base et le montant chez le prestataire) ; jobs désactivés (tests, dev sans Redis) : envoi direct,
  un échec est alors journalisé et l'e-mail perdu (Stripe peut aussi envoyer ses propres reçus).
  Décision (phase 9, T7) : la file `notify` est la voie de production (déjà en place depuis l'audit de la phase 6) ;
  l'envoi direct reste réservé aux environnements sans Redis, aucun changement supplémentaire.
- **Suppression du compte** (audit phase 6, I1) : `BillingAccountCloser.closeForUser(userId)` (exporté par
  `api-billing`, branché par `apps/api` dans `api-users`) résilie immédiatement, sans prorata, tout abonnement
  `active` / `trialing` / `past_due` connu de Stripe ou de la base, puis supprime le client Stripe ; échec du
  prestataire (ou Stripe non configuré alors qu'un client existe) → `BillingAccountCloseError` (503), compte conservé.
  Idempotent (client détaché du compte une fois clôturé).
- Rattachement : une `metadata.userId` est ignorée si le client Stripe de l'événement appartient à un autre compte.
- Checkout : refusé (`ALREADY_SUBSCRIBED`) si Stripe connaît déjà un abonnement Pro pour ce client (webhook pas
  encore reçu) ; client Stripe créé hors transaction (clé d'idempotence `customer:<userId>:<génération>`, génération
  = `User.updatedAt` lu avant l'appel : même client sur un double clic, nouveau client après une clôture, phase 9 n1),
  rattaché par `UPDATE … WHERE stripeCustomerId IS NULL` ; client perdant d'une course : supprimé (au mieux).
  Portail affiché seulement s'il existe ou a existé un abonnement.
- Clôture : les sessions Checkout ouvertes du client sont expirées avant toute résiliation et avant `deleteCustomer`
  (`BillingProvider.expireOpenCheckoutSessions`, phase 9 n2).
- `BILLING_PROVIDER=fake` refusé en production **et** si `APP_URL` n'est pas locale (localhost, 127.0.0.1,
  `*.localhost`). Routes `internal/billing/*` enregistrées seulement avec `JOBS_TEST_TRIGGER=1` hors production.
- Événements traités : `STRIPE_WEBHOOK_EVENT_TYPES` (les 4 de PROMPT.md + `invoice.paid` pour les reçus) ; les autres
  → 200 ignorés.

### 13.6 Anti-abus de l'essai et rétention (tranche le mineur m5 de l'audit de la phase 4)
- Contrôles à la vérification de l'e-mail, dans l'ordre ; le premier qui échoue donne `INELIGIBLE`, un `ProductEvent`
  `trial_refused {reason}` et **aucun message spécifique** (`TRIAL_INELIGIBLE_NOTICE`) :
  1. `email_already_used` : `TrialClaim.emailHash` = HMAC-SHA256(`IP_HASH_SECRET`, `"trial-email:" + emailNormalized`)
     déjà présent (normalisation existante : casse, alias `+`, points Gmail, googlemail) ;
  2. `disposable_domain` : domaine **ou domaine parent** dans la liste jetable ;
  3. `fingerprint_seen` : `TrialFingerprint.hash` = HMAC-SHA256(`IP_HASH_SECRET`, `"trial-fp:" + IP (IPv6 /64) + "\n"
     + user-agent`) déjà accordé dans les 90 jours. Empreinte de la requête de vérification (le clic sur le lien).
- Accord : `TrialClaim` + `TrialFingerprint` écrits dans la transaction du démarrage, sous
  `pg_advisory_xact_lock(hashtext(fingerprint))` (deux vérifications simultanées ne donnent pas deux essais).
- **Rétention (décision m5)** : `TrialFingerprint` purgé à **90 jours** comme le demande PROMPT.md (IP + UA, donnée
  faible qui change vite ; au-delà elle ne prouve plus rien). La règle durable est portée par **`TrialClaim`**
  (HMAC de l'e-mail normalisé, sans e-mail en clair, `SetNull` à la suppression du compte, **conservé 24 mois**,
  `TRIAL_CLAIM_RETENTION_DAYS=730`, intérêt légitime anti-fraude à mentionner dans la politique de confidentialité en
  phase 7). Une suppression puis recréation du compte ne redonne donc pas d'essai. Risque résiduel accepté : même
  machine + nouvelle boîte non jetable après 90 jours (coût réel pour l'abuseur, plafonné par 50 analyses/jour et les
  budgets Helius).
- **Domaines jetables** : source https://github.com/disposable-email-domains/disposable-email-domains (fichier
  `disposable_email_blocklist.conf`, licence CC0), copiée dans `libs/api/auth/src/lib/trial/disposable-domains.generated.ts`
  (date et commit source en tête) + `disposable-domains.local.ts` (ajouts et exceptions maison). Mise à jour par
  `node tools/scripts/update-disposable-domains.mjs` (lancé à la main, une fois par trimestre et en phase 9, diff relu
  et commité) ; **aucun téléchargement au runtime**, aucune dépendance npm.

### 13.7 Job de fin d'essai et e-mails
- File `maintenance`, Job Scheduler `trial-tick` (`TRIAL_JOB_CRON`, par défaut toutes les heures à :05), verrou Redis,
  `JobRun`. Par lots de 200 :
  1. **Expiration** : `trialStatus = ACTIVE` et `trialEndsAt ≤ now` → transaction : `ENDED`, `enforcePlanLimit`
     (Gratuit 3 : les plus récents mis en pause `plan_limit`, jamais supprimés), `trial_expired {pausedWatches}` ;
     après commit, e-mail J0 (`jobId trial-j0:<userId>`, `trialEndMailAt`). Compte avec abonnement Pro : déjà `ENDED`.
  2. **J+1** et **J-2** : envoyés à la première exécution où l'heure **Europe/Paris** ≥ `TRIAL_EMAIL_HOUR` (10 h) et où
     `now ≥ trialStartedAt + 24 h` (J+1), resp. `now ≥ trialEndsAt − 48 h` (J-2), essai encore actif,
     `notifyTrialEmails = true`, colonne d'envoi nulle (idempotence par colonne posée avant l'envoi, `jobId` dédié).
     J0 n'est pas désactivable. Rai sur J0 seulement (PROMPT.md : accueil, fin d'essai, alerte).
- Écran de fin (`endScreenDue`) : dernières 24 h de l'essai, ou `ENDED` sans abonnement et `trialEndScreenSeenAt` nul.
- Bandeau « Essai Pro : plus que N jours » (`thunder-soft`, « se termine aujourd'hui » à N ≤ 1) : pendant tout l'essai
  actif, jours calculés par `trialDaysRemaining` (contrats) ; fermeture mémorisée **par jour** côté navigateur
  (`localStorage`, date seulement, aucune donnée personnelle). Aucune urgence, aucun compte à rebours animé.
- Conversion : `trial_converted` si abonnement pendant l'essai (`during`) ou ≤ `TRIAL_CONVERSION_WINDOW_DAYS` (30) après
  sa fin (`after`). Taux = convertis / (convertis + expirés), par cohorte hebdomadaire de démarrage (lundi UTC).

### 13.8 Sans compte Stripe : `BillingProvider`
- Interface (`libs/api/billing`) : `createCheckoutSession({userId, email, customerId, interval})`,
  `createPortalSession(customerId)`, `retrieveSubscription(id)`, `constructWebhookEvent(rawBody, signature)`,
  `verifyPrices()`. Implémentations : `StripeBillingProvider` (SDK officiel `stripe`, `apiVersion` épinglée dans une
  constante unique `STRIPE_API_VERSION`, même version sur l'endpoint du dashboard) et `FakeBillingProvider`.
- `BILLING_PROVIDER=fake` (défaut en dev et tests ; **refusé au démarrage en production**) : le Checkout renvoie
  `${APP_URL}/abonnement/simulation?session=cs_fake_…` ; la page appelle `POST billing/simulation/checkout`, qui
  **signe localement** l'événement (`stripe.webhooks.generateTestHeaderString` avec `STRIPE_WEBHOOK_SECRET`, ou un secret
  éphémère s'il est absent) et le passe **par le même chemin** que le webhook (vérification de signature comprise).
  Fixtures JSON des 5 événements dans `libs/api/billing/src/testing/fixtures/`, signées à la volée (Jest, api-e2e).
- `BILLING_PROVIDER=stripe` avec clé absente ou factice, ou prix manquants : l'API démarre, `mode: unavailable`, routes
  de paiement en 503 `BILLING_NOT_CONFIGURED`, avertissement au démarrage, `health/config` à `not_configured`. Au
  démarrage, `verifyPrices()` compare les montants Stripe à `PRO_PRICE_*_CENTS` (écart → `unavailable` + journal).
- Clé `sk_live_` : acceptée par le code, mais l'activation du mode réel est une décision de l'utilisateur (phase 8).

### 13.9 Sécurité
- Prix, montant, devise, client et URLs de retour **jamais venus du front** : seul `interval` est accepté (schéma
  `.strict()`), traduit en `STRIPE_PRICE_PRO_MONTHLY|YEARLY`. URLs de retour fixes : `APP_URL` + `BILLING_RETURN_PATHS`.
- Le plan n'est jamais accordé par le retour de Checkout : la page de succès relit `GET billing/subscription` (sondage
  ≤ 20 s), seul le webhook écrit `Subscription`.
- Front : redirection uniquement si `isAllowedBillingRedirect` (hôtes Stripe exacts en https, ou même origine en simulation).
- Aucune clé secrète côté front ; la clé publiable n'est pas nécessaire (Checkout hébergé par redirection).
- Secrets Stripe et signature jamais journalisés ; journaux avec id d'événement et code seulement.
- Webhook : exempté de CSRF (déjà prévu §8.5) et de session, throttler large, corps ≤ 1 Mo, aucune lecture de
  l'utilisateur depuis la requête. Routes de simulation et `internal/*` : 404 hors simulation, refusées en production.
- `idempotencyKey` Stripe sur la création de client et de session (`checkout:<userId>:<interval>:<minute>`).

## 14. Admin et analytics (phase 6 bis)

### 14.1 Découpage et propriété des fichiers (aucun fichier touché par deux agents)
- **Contrats** (`@raijin/shared-contracts`, posés par architect) : `admin/` (`errors`, `common` : périodes, KPI,
  variations, séries, répartitions, textes externes ; `google` : état « Non connecté » / erreur ; `google-reports` :
  Trafic GA4, SEO ; `business-reports` : Acquisition, Revenus, Essais, Produit ; `health` : jobs, quotas, alertes admin ;
  `metrics` : catalogue `DailyMetric` ; `security` : 2FA ; `users` : liste, fiche, actions ; `audit`) et `analytics/ga4.ts`
  (événements GA4, consentement, paramètres d'attribution ; sans Zod). `planSourceSchema` gagne `gift`,
  `BillingAccount.giftEndsAt` (facultatif). Codes `ADMIN_*` + `ACCOUNT_SUSPENDED` ajoutés à `apiErrorCodeSchema` et à
  la table de `web-data-access/http/api-error.ts`.
- **Libs à générer** (générateurs Nx, tags `scope:*` / `type:feature`, cible `typecheck` comme `api-trial` /
  `web-feature-wallet`, alias `@raijin/...`) : `api-admin` (`libs/api/admin`) et `api-analytics` (`libs/api/analytics`)
  par **nestjs-api** dès T1 ; `web-feature-admin` (`libs/web/feature-admin`) par **ui-mobile-first** dès T3.
  Les générer une seule fois, par un seul agent, avant tout travail parallèle dans ces dossiers.
- **nestjs-api** : migration Prisma unique de la phase (§14.4), `libs/api/auth/src/lib/admin-security/**` (TOTP,
  codes de secours, `AdminGuard`, `@AdminRoute()`, session admin, routes `admin/security/*`), `AuditService`
  (`libs/api/auth/src/lib/audit/**`), CLI (`apps/api/src/cli.ts` mince + logique dans `api-auth`), suspension et Pro
  offert dans `api-auth` / `api-core` (`resolvePlanPolicy`) / `api-trial` (fin du Pro offert), `libs/api/admin/src/lib/users/**`
  (liste, fiche, actions, journal), retrait de `GET health/config`, `GET admin/trial-conversion` passé sous `AdminGuard`.
- **admin-analytics** : `libs/api/analytics/**` (clients GA4 Data API et Search Console, simulation), le reste de
  `libs/api/admin/src/lib/**` (`overview`, `traffic`, `seo`, `acquisition`, `revenue`, `trials`, `product`, `health`,
  `metrics` : job `metrics-aggregate`, `alerts` : job `admin-alerts`), `api-admin.module.ts` (racine, il importe le
  `AdminUsersModule` exporté par nestjs-api), le module d'e-mail d'alerte admin (template dans `api-notifications`,
  dossier `templates/admin-alert*` seulement), `libs/web/feature-admin/src/lib/pages/**` (9 écrans) et
  `libs/web/data-access/src/lib/admin/*.ts` (API et stores des écrans, hors `security/`).
- **ui-mobile-first** : `libs/web/feature-admin/src/lib/{shell,ui,security}/**` (coque admin, `rj-chart`, `rj-kpi-card`,
  grille de KPI, tableau → cartes, bottom sheet de filtres, état « Non connecté », écrans d'enrôlement / saisie du code /
  codes de secours / session expirée), `lib.routes.ts` de la feature (les pages s'y branchent par une ligne chacune),
  `libs/web/data-access/src/lib/admin/security/**` (`AdminSecurityApi`, `AdminSessionStore`, intercepteur des 403
  admin), `apps/web` (route `/admin` lazy + garde), lien « Espace admin » dans `feature-compte` (admins seulement),
  libellé `gift` dans `feature-compte/abonnement`.
- **solana-data** : compteurs d'appels par source et par jour UTC dans `libs/api/solana` (`UpstreamGate`, Redis
  `upstream:calls:<source>:<jour>`, TTL 8 jours) + lecteur `UpstreamUsageReader` exporté.
- **seo-astro** : `apps/landing/src/{components/consent,lib/analytics}/**`, `Base.astro` (meta de vérification, bannière,
  lien « Gérer les cookies »), `docs/ANALYTICS.md`.
- `index.ts` des libs partagées (`web-data-access`) : chaque agent n'ajoute que ses lignes d'export, dans son bloc commenté.
- Dépendances : `admin → auth, analytics, trial, billing (lecture), alerts (lecture), notifications, core, prisma, solana
  (UpstreamUsageReader)` ; `analytics → core` seulement (aucune base). Aucun cycle ; `auth` ne dépend jamais d'`admin`.

### 14.2 2FA TOTP du compte admin
- RFC 6238 implémentée avec `node:crypto` (HMAC-SHA1, 6 chiffres, pas de 30 s, fenêtre ±1 pas) et un encodeur base32
  local : **aucune dépendance** (`otplib`, `speakeasy` écartés). Secret de 20 octets aléatoires (`randomBytes`).
- Rejeu impossible : `TotpSecret.lastUsedStep` ; un code dont le pas est ≤ au dernier pas utilisé est refusé.
- **Chiffrement du secret** : AES-256-GCM, clé `TOTP_ENCRYPTION_KEY` (32 octets en base64, obligatoire en production),
  IV 12 octets aléatoires par chiffrement, **AAD = `totp:<userId>`** (un secret copié sur une autre ligne ne se déchiffre
  pas). Format `v1.<iv>.<tag>.<ciphertext>` (base64url) : le préfixe de version permet une rotation de clé future.
  Le secret clair n'existe qu'en mémoire, le temps d'un calcul ; jamais journalisé ni renvoyé après l'enrôlement.
- Enrôlement : `POST admin/security/enrollment` écrit le secret chiffré avec `enabledAt = null` (remplace un enrôlement
  inachevé), valable `ADMIN_ENROLLMENT_TTL_SECONDS` (10 min) ; l'URI `otpauth://totp/<issuer>:<email>?secret=…&issuer=…`
  est rendue en **QR SVG côté API** (paquet `uqr`, zéro dépendance ; repli `qrcode-generator` si `uqr` pose un problème
  d'ESM/CJS ; vérifier licence, `pnpm audit --prod`, absence de script d'installation) et renvoyée en data URI.
  `…/confirm` vérifie le code, pose `enabledAt`, génère 10 codes de secours et vérifie la session dans la foulée.
- **Codes de secours** : 10 codes `XXXXX-XXXXX` (base32, 50 bits), stockés en **HMAC-SHA256** (clé dérivée de
  `TOTP_ENCRYPTION_KEY` par HKDF, info `raijin-recovery-codes`), usage unique (`usedAt`), régénération (invalide les
  anciens) sur code TOTP frais. Le front les montre une fois, avec copie et téléchargement `.txt`.
- **Anti-force brute** : `ADMIN_TOTP_MAX_ATTEMPTS` (5) codes faux par compte en `ADMIN_TOTP_LOCKOUT_MINUTES` (15) →
  429 `ADMIN_2FA_LOCKED` ; compteur Redis par `userId` (même script Lua atomique et même repli mémoire que §8.4).
  Chaque échec est audité (`admin.2fa_failed`), chaque succès aussi (`admin.2fa_verified`, `admin.recovery_code_used`).
- Perte du téléphone et des codes : `pnpm nx run api:admin-reset-2fa --email=…` (CLI, auditée), jamais depuis l'interface.

### 14.3 Rôle ADMIN, garde et session admin
- **Rôle par CLI uniquement** : `pnpm nx run api:make-admin --email=… [--revoke]` (cible `run-commands` de `api` qui lance
  `dist/apps/api/cli.js`, entrée secondaire du build ; logique dans `api-auth`, `apps/api/src/cli.ts` ne fait que
  l'appeler). E-mail validé par `emailSchema`, compte existant et vérifié exigé, audit `admin.role_granted` /
  `admin.role_revoked` (`actorKind: cli`). Le retrait révoque les sessions admin. En production : commande
  `docker compose exec` documentée dans `docs/DEPLOY.md` (l'utilisateur la lance, jamais l'agent).
- **`@AdminRoute()`** = `AuthGuard` → `AdminGuard`, sur **chaque** contrôleur `admin/*` :
  1. rôle **relu en base** ; pas ADMIN → **404 `NOT_FOUND`** (espace invisible ; remplace le 403 de
     `GET admin/trial-conversion`) ;
  2. 2FA non activée → 403 `ADMIN_2FA_ENROLLMENT_REQUIRED` (sauf `admin/security/status|enrollment*`) ;
  3. session non vérifiée → 403 `ADMIN_2FA_REQUIRED` ; vérifiée mais `now − adminLastSeenAt > ADMIN_SESSION_IDLE_MINUTES`
     (30) ou `now − adminVerifiedAt > ADMIN_SESSION_MAX_HOURS` (8) → 403 `ADMIN_SESSION_EXPIRED` (colonnes remises à null) ;
  4. sinon `adminLastSeenAt` mis à jour (au plus une écriture par minute : `UPDATE … WHERE adminLastSeenAt < now − 60 s`).
- État porté par la ligne `Session` (`adminVerifiedAt`, `adminLastSeenAt`) : la déconnexion, le changement de mot de passe,
  la réutilisation d'un refresh et le retrait du rôle le font tomber avec la session ; aucun nouveau cookie.
- Codes en **403** (jamais 401) : l'intercepteur de refresh de l'app n'intervient pas ; l'intercepteur admin
  (`data-access/admin/security`) redirige vers l'écran de saisie du code avec retour à la page courante et vide les
  stores admin. Le front arme aussi un minuteur d'inactivité aligné sur `idleTimeoutSeconds` qui masque les données.
- Toutes les réponses `admin/*` : `Cache-Control: no-store` ; throttler `admin` 120 requêtes/min/utilisateur ;
  CSRF sur toutes les mutations (inchangé).

### 14.4 Modèle (migration unique, nestjs-api, au début de la phase)
- `Session.adminVerifiedAt DateTime?`, `Session.adminLastSeenAt DateTime?`.
- `AdminRecoveryCode { id, userId → User (Cascade), codeHash @unique, usedAt?, createdAt }`, index `userId`.
- `User.suspendedAt DateTime?` (index) ; `User.proGrantedUntil DateTime?` (Pro offert).
- `AuditLog` : index `actorId` et `(userId, createdAt)` ; colonne `actorKind String @default("user")`.
- `AdminAlert { id, kind, subject, level, dedupeKey @unique, details Json, createdAt, notifiedAt?, resolvedAt? }`, index
  `(resolvedAt, createdAt)`.
- `TokenAnalysis.durationMs Int?` **si absent** (temps de réponse de l'écran Produit ; vérifier d'abord le schéma).
- Pas de colonne d'agrégat ailleurs : `DailyMetric` existe déjà (`@@unique([date, key])`).

### 14.5 Agrégats `DailyMetric` et ordre agrégation → purge (clôt le mineur m6 de la phase 4)
- Catalogue fermé : `DAILY_METRICS` + familles `checks.<source>`, `checks_unavailable.<source>`, `upstream_calls.<source>`
  (`admin/metrics.ts`) ; une clé hors catalogue est refusée. **Aucune donnée personnelle** : comptes, sommes, moyennes,
  instantanés ; aucun identifiant, e-mail, IP, mint saisi par un anonyme.
- Job **`metrics-aggregate`** (file `maintenance`, `METRICS_CRON` = 02:15 UTC, verrou Redis, `JobRun`) : calcule J-1 et
  **recalcule J-2 et J-3** (événements tardifs, webhooks rejoués) par `upsert` idempotent ; au premier passage (table vide),
  rattrapage de tous les jours encore présents (≤ `RETENTION_DAYS`). Sources : `User`, `ProductEvent`, `TokenAnalysis`,
  `Subscription`, `Alert`, `Watch`, `PushSubscription`, `AuditLog` (`account.deleted`), compteurs Redis journaliers
  (requêtes et 5xx de l'API, e-mails envoyés / en échec, crédits Helius, appels par source, TTL 8 jours) et
  `pg_database_size`. Les instantanés (`last`) sont pris au passage du job et datés J-1.
- **Ordre** : `METRICS_CRON` (02:15) précède `PURGE_CRON` (03:30). La purge ne supprime les `ProductEvent` et
  `TokenAnalysis` d'un jour que si un `JobRun` `metrics-aggregate` en succès couvre ce jour (`details.through`) ; sinon elle
  saute ces deux tables, l'écrit dans son `JobRun` (`skippedUnaggregated`) et l'alerte « job en échec » finit par prévenir.
- Jour en cours : calculé en direct sur les tables sources (cache Redis 60 s). Périodes passées : `DailyMetric` seule.
  Acquisition : calculée en direct sur `User` (petit volume, cache 5 min), pas de dimension libre dans `DailyMetric`.
- `DailyMetric` est conservée sans limite (≈ 60 lignes par jour). `AuditLog` : `AUDIT_LOG_RETENTION_DAYS` (365) dans la purge.

### 14.6 Accès Google (`libs/api/analytics`)
- **Compte de service**, JSON dans `GOOGLE_SERVICE_ACCOUNT_JSON` (brut ou base64), jamais commité ni journalisé.
  Portées **en lecture seule** : `https://www.googleapis.com/auth/analytics.readonly` et
  `https://www.googleapis.com/auth/webmasters.readonly`. Accès « Lecteur » GA4 et « Restreint » Search Console.
- **Aucun SDK Google** (`googleapis` pèse des dizaines de Mo) : JWT RS256 signé avec `node:crypto`, échange sur
  `https://oauth2.googleapis.com/token`, jeton gardé en mémoire jusqu'à 5 min avant expiration ; appels REST en `fetch`
  vers des hôtes fixes (pas de SSRF) : `https://analyticsdata.googleapis.com/v1beta/properties/{GA4_PROPERTY_ID}:batchRunReport`
  et `https://searchconsole.googleapis.com/webmasters/v3/sites/{site}/searchAnalytics/query`. Délai 10 s, une reprise.
- **Cache Redis** `analytics:v1:<service>:<sha256(requête)>`, TTL `ANALYTICS_CACHE_TTL_S` (1 h) ; erreurs gardées 5 min
  (pas de martèlement). `fetchedAt` / `cachedUntil` renvoyés au front.
- **Search Console** : `dataState: final`, `dataThrough` = dernier jour présent, `lagDays` affiché (« données jusqu'au … ,
  décalage de 2 à 3 jours ») ; opportunités = positions 5 à 20 triées par impressions.
- **Sans compte Google** (cas actuel) : `not_connected`, jamais de 5xx ; l'écran affiche « Non connecté » et le lien vers
  `docs/DEPLOY.md`. `ANALYTICS_PROVIDER=fake` (dev, e2e ; refusé en production) sert des fixtures déterministes
  (`libs/api/analytics/src/testing/fixtures`) et marque `simulated: true`.
- Erreurs Google traduites en `auth_failed | permission_denied | quota_exceeded | unavailable` ; journaux : code HTTP et
  code interne seulement (jamais le corps de Google, le JSON ni le jeton).

### 14.7 Alertes admin
- Job **`admin-alerts`** (`ADMIN_ALERTS_CRON`, toutes les 10 min) : (1) chaque job dont les `ADMIN_ALERT_JOB_FAILURES` (3)
  derniers `JobRun` sont en échec ; (2) chaque quota de `QUOTA_SERVICES` dont `used / limit ≥ ADMIN_ALERT_QUOTA_RATIO` (0,8)
  (Helius global et voies : compteurs existants ; Jupiter et RugCheck : `*_DAILY_CALL_BUDGET`, sans plafond = pas d'alerte).
- Déduplication par `AdminAlert.dedupeKey` (`job_failing:<job>:<id du premier échec>`, `quota:<service>:<jour>`) : une
  alerte par incident ; résolue au prochain succès du job ou au jour UTC suivant.
- Canal : **e-mail** (thème clair, `api-notifications`) à chaque compte ADMIN + **push** à ses abonnements (sans condition
  de plan pour ce type) ; `notifiedAt` posé après envoi, nouvel essai au passage suivant sinon. Contenu : job ou service,
  compteurs, code d'erreur ; jamais de secret, d'URL d'API ni de donnée utilisateur. Le job `admin-alerts` apparaît
  lui-même dans la santé technique.

### 14.8 Audit, actions utilisateurs et RGPD
- `AuditService.record(tx, { action, actorKind, actorId, userId, metadata })` dans **la même transaction** que la
  modification ; `metadata` validé par `auditMetadataSchema` (avant / après = champs modifiés seulement, motif, détails).
  Jamais d'e-mail, d'IP en clair, de secret, de code TOTP ni de hash dans `metadata`.
- Actions (`POST admin/users/:id/actions`, union discriminée `type`) : motif obligatoire (sauf renvoi de vérification) ;
  **suspendre** et **supprimer** exigent de recopier l'e-mail du compte (`ADMIN_CONFIRMATION_MISMATCH`), **supprimer** exige
  en plus un code TOTP frais (compte dans l'anti-force brute). Interdites sur un compte ADMIN et sur soi-même
  (`ADMIN_ACTION_NOT_ALLOWED`). Le front ouvre une confirmation (bottom sheet sur mobile, dialogue sur desktop) résumant
  l'effet avant l'envoi.
  - `extend_trial` (1 à 14 j) : essai actif → `trialEndsAt += j` ; essai terminé sans abonnement → réouvert jusqu'à
    `now + j` (drapeaux d'e-mails d'essai remis à zéro) ; `none` / `ineligible` / abonné → 409.
  - `grant_pro_month` : `proGrantedUntil = max(now, actuel) + 30 j`, au plus `now + 365 j` ; refusé avec un abonnement Pro
    en cours. `resolvePlanPolicy` : subscription > trial > gift > free (source `gift`). À l'échéance, le job horaire
    d'essai applique la même limite de suivis qu'en fin d'essai (e-mail neutre, pas d'urgence).
  - `suspend` : `suspendedAt`, toutes les sessions révoquées (`revokedReason: suspended`), alertes et e-mails non envoyés ;
    connexion, lien magique et refresh → 403 `ACCOUNT_SUSPENDED` **seulement après des identifiants valides** (pas
    d'énumération). L'abonnement Stripe n'est pas résilié automatiquement : la fiche le signale. `reactivate` l'annule.
  - `resend_verification` : compte non vérifié seulement, même service que `POST auth/verify-email/resend`.
  - `delete` : même service que `DELETE users/me` (résiliation Stripe, cascade, `SetNull` de l'audit) ; l'entrée d'audit
    est écrite avant la suppression et survit sans e-mail.
- **Pas d'usurpation** : aucune route ni action « se connecter en tant que » ; un test e2e vérifie qu'aucune route admin
  ne pose de cookie de session.
- **Consultation de données personnelles auditée** : recherche par e-mail (`admin.user_searched`, `details` = nombre de
  résultats et HMAC du texte cherché, jamais le texte) et ouverture d'une fiche (`admin.user_viewed`, une entrée par
  admin et par fiche toutes les 10 min). Recherche : fragment ≥ 3 caractères, `%`, `_` et `\` échappés.
- L'export RGPD de l'utilisateur (`GET users/me/export`) inclut les entrées le visant, auteur réduit à « admin ».
- Agrégats et écrans statistiques : aucune donnée personnelle ; seuls l'écran Utilisateurs et le journal en montrent.

### 14.9 Graphiques : Chart.js 4 (complète §5)
- Dépendance `chart.js` (4.x) ajoutée au seul usage de `web-feature-admin` ; vérifier l'absence de script d'installation
  et `pnpm audit --prod`. Chargée par **import dynamique** dans `rj-chart` (chunk séparé, rien dans le bundle initial).
- Enregistrement modulaire : `LineController`, `LineElement`, `PointElement`, `BarController`, `BarElement`,
  `DoughnutController`, `ArcElement`, `CategoryScale`, `LinearScale`, `Tooltip`, `Filler`. Pas d'échelle `time` (pas
  d'adaptateur de dates) : axe catégoriel avec dates formatées par `Intl.DateTimeFormat('fr-FR')`. Pas de `Legend`
  Chart.js : légende HTML (icône + texte, jamais la couleur seule).
- Thème : couleurs, police mono des chiffres, grilles et textes lus dans les variables CSS des tokens
  (`getComputedStyle`) au rendu et au changement de thème ; `thunder` = série principale, `info` = comparaison,
  `safe | warn | danger` = verdicts. Aucune valeur en dur.
- **Accessibilité** : `<canvas role="img" aria-label="résumé chiffré">` + bouton « Voir les données » qui affiche un
  `<table>` équivalent (aussi lisible au clavier et par les lecteurs d'écran) ; `prefers-reduced-motion` → aucune animation.
- 360 px : `maxTicksLimit` 4 à 6, infobulle au toucher, hauteur fixée par un token ; pas de scroll horizontal.
- Mobile first : KPI en grille de 2 (`rj-kpi-card`, chiffres mono, variation avec flèche + signe + couleur), graphiques
  pleine largeur, tableaux en cartes < 768 px, filtres en bottom sheet < 1024 px. Coque admin : sidebar des 9 écrans
  ≥ 1024 px ; en dessous, barre du haut avec menu des écrans en bottom sheet et bouton « Quitter l'admin ».

### 14.10 Landing : consentement, GA4, attribution (fait dès cette phase, par seo-astro)
- **Pourquoi maintenant** : PROMPT.md §10 range « GA4 + consentement sur la landing, attribution UTM » dans la phase 6 bis,
  la chaîne d'attribution landing → app → `User` doit être testée de bout en bout avec l'écran Acquisition, et ces
  composants ne dépendent pas du design des pages. La phase 7 branche les événements (`guide_lu`, `faq_ouverte`…) sur les
  pages qu'elle construit, avec le module `track()` livré ici.
- **Consent Mode v2, mode basique** : avant le choix, **aucun script Google n'est chargé** (pas de ping sans cookie) ;
  au clic sur « Tout accepter » : `gtag('consent','default',{…denied})` puis `update` `analytics_storage: granted`
  (`ad_storage`, `ad_user_data`, `ad_personalization` toujours `denied`), chargement de `gtag.js`,
  `allow_google_signals: false`. Refus : rien n'est chargé. Sans `GA4_MEASUREMENT_ID` : ni GA4 ni bannière.
- Bannière maison (bottom sheet < 768 px, encart en bas à gauche au-delà) : « Tout accepter » et « Tout refuser » au
  même niveau visuel, « Personnaliser » (un interrupteur « Mesure d'audience »). Choix dans le cookie `rj_consent`
  (`v1.granted|denied.<date>`, 182 jours, `SameSite=Lax`, `Secure`) ; lien « Gérer les cookies » dans le footer.
  Script module groupé (pas de script inline, CSP), budget ≤ 4 ko gzip ; focus géré, Échap ne vaut jamais acceptation.
- `track(name, params)` typé par `Ga4EventName` / `Ga4EventParams` (`import type`, aucun Zod dans la landing) ; sans
  consentement, aucun envoi ni file d'attente.
- **Attribution** : à la première visite, UTM, référent externe et page d'arrivée relevés ; gardés en `sessionStorage`
  sans consentement, dans le cookie `rj_attr` (90 jours) après consentement ; les liens vers l'app sont complétés au clic
  avec `ATTRIBUTION_QUERY_PARAMS` (`utm_*`, `rj_ref`, `rj_lp`). L'app (`AttributionTracker`) lit ces paramètres en priorité.
  Un test de la landing compare ses constantes à celles des contrats.
- **RGPD (décision sur le `sessionStorage` de l'app, phase 2)** : conservé. Stockage de premier niveau, limité à l'onglet,
  non partagé, lu uniquement pour l'envoyer à l'inscription, finalité d'attribution interne sans outil tiers : mentionné
  dans la politique de confidentialité (phase 7). Le cookie durable de la landing, lui, reste soumis au consentement.
- Conversions : l'inscription confirmée et l'abonnement ont lieu dans l'app (sans GA4) : mesurés en interne et reliés
  aux sources dans l'écran Acquisition ; dans GA4, `inscription_debut` et `cta_essai_clic` sont les événements clés
  (écart assumé, Measurement Protocol écarté : il exigerait un secret et un identifiant GA transmis à l'app).
- `GOOGLE_SITE_VERIFICATION` et `GA4_MEASUREMENT_ID` lus au build par `astro:env` (publics) ; CSP de la landing :
  `script-src 'self' https://www.googletagmanager.com`, `connect-src` / `img-src` `https://*.google-analytics.com
  https://*.analytics.google.com https://www.googletagmanager.com` (posée en phase 8 côté Traefik, documentée ici).

### 14.11 Sécurité (synthèse pour security-reviewer)
- 404 pour tout non-admin ; rôle relu en base ; 2FA obligatoire ; session admin 30 min / 8 h ; codes 403 sans refresh.
- Secret TOTP chiffré (AES-256-GCM + AAD), codes de secours hachés, rejeu et force brute bloqués, tout audité.
- Aucune usurpation ; confirmations renforcées ; audit avant / après dans la transaction ; actions interdites sur un admin
  et sur soi-même ; motif obligatoire.
- `no-store` sur `admin/*` ; aucune donnée admin dans `localStorage` ; stores vidés à l'expiration.
- Textes Google, UTM, symboles : hostiles, bornés par les contrats, affichés par interpolation (jamais `innerHTML`) ;
  QR en `<img>` data URI produit par l'API.
- `GET health/config` retiré (404) ; état des services dans `GET admin/health`.
- `GOOGLE_SERVICE_ACCOUNT_JSON`, `TOTP_ENCRYPTION_KEY` : jamais journalisés ; portées Google en lecture seule ; hôtes Google
  fixes ; `ANALYTICS_PROVIDER=fake` refusé en production.

## 15. Landing Astro (phase 7)

### 15.1 Découpage et propriété des fichiers
- **seo-astro** : tout `apps/landing/**` (pages, contenus, composants, îlots, OG, sitemap, tests Vitest), `docs/ANALYTICS.md`
  (mise à jour des déclencheurs), `docs/DEPLOY.md` (section landing : variables du build, sitemap Search Console, URLs
  sans `.html`). Aucune lib nouvelle : le contenu est propre à la landing (pas de logique métier, seulement de la
  présentation ; le verdict de démonstration est calculé par `@raijin/shared-risk-engine`).
- **ui-mobile-first** : `libs/web/feature-analyse` (repli sans JS `/analyse?mint=` → `/analyse/<mint>`).
- **nestjs-api** : défauts de configuration tirés de `PUBLIC_PLAN_CATALOG` (`api-core`, `api-billing`) + avertissement
  de désalignement au démarrage en production.
- **test-e2e** : `apps/web-e2e` (specs landing, `scripts/serve-landing.mjs`, cible `lighthouse`).
- Dépendances autorisées pour la landing : `scope:shared` uniquement (`shared-contracts` en `import type` côté client,
  valeurs au build ; `shared-util` pour `isSolanaAddress` ; `shared-risk-engine` au build seulement). **Aucune nouvelle
  dépendance npm** (pas de `@astrojs/sitemap`, pas de framework d'îlot : scripts TypeScript natifs d'Astro).

### 15.2 Source des prix et des quotas affichés : catalogue partagé, lu au build
- Tranché : `PUBLIC_PLAN_CATALOG` (`libs/shared/contracts/src/lib/billing/catalog.ts`, sans Zod, testé contre
  `billingPlansResponseSchema`) est importé au build par la landing (tarifs, hero « N analyses gratuites sans compte »,
  FAQ, JSON-LD `offers`).
- Écartés : **lecture de `GET billing/plans` au build** (le build et la CI dépendraient d'une API démarrée ; une API
  injoignable casserait le déploiement) ; **lecture à l'exécution** (JS client, requête inter-origines, CLS, Lighthouse) ;
  **duplication** dans la landing (dérive silencieuse).
- Alignement : l'API tire ses défauts (`PRO_PRICE_*_CENTS`, `ANON_/FREE_/TRIAL_ANALYSIS_DAILY_LIMIT`, `*_WATCH_LIMIT`,
  `*_ALERT_HISTORY_DAYS`, `WALLET_SCAN_DAILY_LIMIT_*`, `TRIAL_DAYS`) du catalogue ; en production, toute variable qui
  s'en écarte est journalisée au démarrage (`warn`, nom de la variable seulement). Changer un prix = modifier le
  catalogue, reconstruire API et landing. L'app continue d'afficher `GET billing/plans` (valeurs effectives).
- Format des prix : `Intl.NumberFormat('fr-FR', { style: 'currency', currency })` au build, mention « TTC ».

### 15.3 Analyse sans compte depuis la landing : redirection vers l'app (tranché)
- Le champ du hero est un `<form method="get" action="{APP_URL}/analyse">` (`name="mint"`, `inputmode="text"`,
  `autocomplete="off"`, `spellcheck="false"`). Îlot `analyse-form.ts` (≤ 2 ko gzip) : `isSolanaAddress` (shared-util, sans
  Zod), message d'erreur inline (`aria-describedby`, `aria-invalid`), puis navigation vers
  `{APP_URL}/analyse/<mint>` + paramètres d'attribution (`decorateAppUrl` existant), `track('analyse_demo_lancee')`
  en `transport_type: 'beacon'`. Sans JS : le GET arrive sur `/analyse?mint=…`, l'app redirige (ui-mobile-first).
- L'analyse est faite par l'app, qui sait déjà le faire sans compte (quota anonyme par empreinte d'IP,
  `ANON_ANALYSIS_DAILY_LIMIT`, CSRF double-submit **même site** `app` ↔ `api`, déjà audité). « Une analyse gratuite sans
  compte » est tenue (3 par jour, valeur du catalogue).
- **Écarté : POST depuis la landing** (`GET auth/csrf` avec `credentials: 'include'` puis `POST /analyses`). Techniquement
  possible (`raijinshield.com` et `api.raijinshield.com` sont même site, les cookies `SameSite=Lax` partiraient), mais
  il faut ajouter l'origine de la landing à `CORS_ORIGINS` avec credentials (surface d'attaque élargie : tout XSS de la
  landing devient un client authentifié de l'API), dupliquer le rendu du verdict dans la landing (JS, Zod ou parsing
  maison, données hostiles à échapper une seconde fois) et alourdir la page (Lighthouse ≥ 95). Aucune modification
  de l'API : `CORS_ORIGINS` de production reste `https://app.raijinshield.com` (celui de dev garde `:4321` pour les e2e
  existants).
- Le verdict réel n'est donc pas visible par GA4 (l'app n'embarque pas GA4) : mesuré en interne (`ProductEvent`
  + attribution `rj_lp`). `analyse_demo_resultat` correspond à l'**analyse de démonstration** (§15.4).

### 15.4 Visuel du verdict et analyse de démonstration
- Token fictif, explicitement nommé « Exemple » (aucun mint réel, aucune marque, aucune promesse) : faits définis dans
  `apps/landing/src/lib/demo/facts.ts`, verdict et contrôles calculés **au build** par `evaluateRisk` /
  `summarizeCheck` de `shared-risk-engine` → la démo ne peut pas contredire le moteur. Un test Vitest fige le verdict attendu
  (`warn` recommandé : montre les 3 statuts).
- Rendu HTML statique (icône + mot + couleur de verdict, liste des 9 contrôles avec `ANALYSIS_CHECK_LABELS`,
  `VERDICT_LABELS`, `CHECK_STATUS_LABELS`). Bouton « Lancer la démonstration » : révèle le résultat (classe CSS,
  animation désactivée en reduced-motion) et envoie `analyse_demo_resultat { verdict }`. Sans JS : résultat visible.

### 15.5 Contenus : content collections Astro
- `src/content.config.ts` : collection `guides` (loader `glob` sur `src/content/guides/*.md`), schéma
  `astro/zod` (title ≤ 60 car., description 120–160 car., `publishedAt`, `updatedAt`, `related: slug[]`, `faq?`).
  Zod reste au build (aucun JS client). Collection `faq` (fichier YAML/JSON unique) partagée par l'accueil et `/faq`.
- Guides minimum : `rug-pull-solana` (« Comment repérer un rug pull sur Solana »), `mint-authority`
  (« Mint authority : c'est quoi ? »), `honeypot-solana` (« Honeypot : comment le détecter »). Liens internes croisés
  (`related`), CTA vers l'analyse, mention légale en pied d'article.
- Pages : `/`, `/tarifs`, `/comment-ca-marche`, `/faq`, `/guides`, `/guides/<slug>`, `/mentions-legales`, `/cgu`
  (CGU + CGV), `/confidentialite`, `404`. Mentions légales et CGV : éditeur, SIRET, adresse, contact, médiateur marqués
  **« À compléter »** (constante `LEGAL_TODO` affichée visiblement, jamais d'identité inventée) ; hébergeur : OVHcloud
  (raison sociale publique) ; la confidentialité cite `rj_consent` (182 j), `rj_attr` (90 j, après consentement),
  `_ga`/`_ga_*` (GA4, après consentement), le `sessionStorage` d'attribution (onglet, sans consentement, finalité interne),
  les cookies de session de l'app (`rj_at`, `rj_rt`, `rj_csrf`, strictement nécessaires) et l'empreinte d'IP hachée du
  quota anonyme.

### 15.6 SEO technique
- **Canonical corrigé** : `build.format: 'file'` conservé (URLs sans barre finale, `trailingSlash: 'never'`) ;
  `canonicalUrl(pathname)` (`src/lib/seo.ts`, testé) retire `.html` et `/index` → `https://raijinshield.com/`,
  `https://raijinshield.com/tarifs`. Même fonction pour `og:url`, sitemap et `BreadcrumbList`. Le serveur (Traefik /
  serveur statique, phase 8) sert `/tarifs` → `tarifs.html` ; `serve-landing.mjs` fait de même pour les e2e.
- `sitemap.xml` : endpoint statique `src/pages/sitemap.xml.ts` (pages + guides avec `lastmod`), sans dépendance ;
  `robots.txt` existant. `404` en `noindex`.
- Composant `Seo.astro` : title/description uniques (test qui parcourt `dist` : unicité, longueurs), `lang="fr"`,
  OG + Twitter `summary_large_image`, JSON-LD dans `<script type="application/ld+json">` (non exécutable, compatible
  `script-src 'self'`) : `Organization` + `SoftwareApplication` (offers depuis le catalogue) sur l'accueil, `FAQPage`
  (accueil et `/faq`), `BreadcrumbList` (pages internes), `Article` (guides). Échappement de `<` dans le JSON.
- **Images OG au build** : endpoint `src/pages/og/[slug].png.ts` (`getStaticPaths` : une image par page et par guide),
  `satori` + `@resvg/resvg-wasm` (déjà dans le workspace, aucun binaire natif), polices WOFF `@fontsource` (comme
  `api-analysis/og`), couleurs lues dans `libs/brand/tokens.json` (aucune valeur en dur), Rai et logo depuis
  `libs/brand`. 1200 × 630, PNG ≤ 150 ko.

### 15.7 Performance et budget (Lighthouse mobile ≥ 95 sur chaque page, PROMPT.md §9.5)
- Zéro JS par défaut ; JS total par page ≤ 12 ko gzip (analytics + consentement ≤ 4 ko, formulaire ≤ 2 ko, démo ≤ 1 ko,
  suivi de lecture des guides ≤ 1 ko). Aucun script inline.
- CSS : Tailwind + tokens, ≤ 20 ko gzip, critique inline toléré par Astro (`inlineStylesheets: 'auto'`) — à vérifier
  contre la CSP `style-src` de la phase 8 ; sinon fichier unique.
- Polices : 2 graisses préchargées max (Space Grotesk 700 du hero, Inter 400), `font-display: swap`, latin seulement.
- Rai du hero : SVG inline (≈ LCP texte, pas d'image bitmap), 160 px sur mobile, respiration 3 s et éclat au survol en
  CSS, arrêtés sous `prefers-reduced-motion`. Images : `astro:assets`, dimensions explicites, `loading="lazy"` sous la
  ligne de flottaison. Poids total de l'accueil ≤ 200 ko transférés (hors GA4 après consentement).
- Mesure : cible `web-e2e:lighthouse` étendue aux pages de la landing (accueil, tarifs, un guide), médiane de 3 sur le
  runner GitHub ; Performance, Accessibilité, Bonnes pratiques, SEO ≥ 95.

## 16. Banc : mesure des verdicts (phase 7 bis)

Préparée maintenant en code pur et testé dans `libs/bench/verdicts` (`@raijin/bench-verdicts`, `scope:bench`,
`type:util`, sans I/O ni horloge : `now` est toujours un paramètre). Branchée en phase 8 bis sur la base
`raijin_bench` et les jobs BullMQ. Aucune écriture sur Supabase ni Vercel. Contrats Zod dans
`libs/bench/verdicts/src/lib/contracts.ts` (propres au banc, donc hors `shared-contracts`).

### 16.1 Enregistrement et fenêtres de suivi
- Un `VerdictRecord` par token analysé et version du moteur : verdict, codes de raison, contrôles en `warn`/`danger`,
  `baseline` (prix USD, liquidité USD, supply brute en chaîne décimale comparée en `bigint`), et les `RiskFacts`
  complets (rejeu des variantes). `verdictAt` = `facts.observedAt`.
- Horizons : 24 h (tolérance + 6 h), 72 h (+ 12 h), 7 j (+ 24 h) après `verdictAt`. Une observation hors fenêtre
  est écartée (comptée comme « manquante »), jamais réaffectée à un autre horizon.

### 16.2 Définition des issues (`DEFAULT_OUTCOME_THRESHOLDS`, configurables)
- `LP_REMOVED` : `lpRemoved === true`, ou liquidité ≤ 10 % de la liquidité au verdict si celle-ci ≥ 1 000 $.
- `PRICE_CRASH_90` : prix ≤ 10 % du prix au verdict (chute ≥ 90 %).
- `MINT_USED` : supply brute observée > supply au verdict (nouveaux tokens émis).
- `TOKEN_DEAD` : aucun pool trouvé, ou liquidité < 1 000 $, ou volume 24 h < 100 $.
- Statut : `rug` si au moins un des trois premiers événements ; sinon `dead` si `TOKEN_DEAD` ; sinon `alive` ;
  `unknown` si prix et liquidité sont tous deux inconnus et qu'aucun événement n'est constaté. **Cumulatif** :
  un événement constaté à 24 h reste acquis à 72 h et 7 j (l'issue à un horizon = union des observations
  jusqu'à cet horizon). Les `unknown` sont exclus des métriques, et leur nombre est affiché.

### 16.3 Métriques de justesse (par horizon, par version du moteur)
- Classe positive par défaut : `rug` (« X % des rugs signalés à l'avance ») ; vue secondaire `rug` ∪ `dead`.
- Précision du verdict Danger = rugs parmi les Danger ; rappel = Danger parmi les rugs ; taux de faux « Sain » =
  rugs parmi les Sain. Prudence n'est ni positif ni négatif prédit : affiché à part (taux de rug des Prudence).
- Pouvoir prédictif par code de raison et par contrôle signalé : taux de rug avec / sans le signal, et lift
  (taux avec / taux global). Classement seulement pour un support ≥ 10 tokens portant le signal.
- Chaque proportion porte son effectif et un **intervalle de Wilson à 95 %** (z = 1,96). Effectif < 30 :
  `insufficient = true`, l'écran affiche « échantillon insuffisant » au lieu du pourcentage, et aucun chiffre
  n'est réutilisable pour le marketing (PROMPT.md §4.8 : « uniquement si les chiffres le justifient »).

### 16.4 Variantes du moteur
- `EngineVariant` = identifiant (`^[a-z0-9][a-z0-9-]{0,31}$`, `reference` réservé), libellé, surcharges numériques
  de `RiskEngineConfig` et poids de raisons ; moteur = `createRiskEngine({ ...overrides, version })`, la config
  étant validée par `resolveRiskEngineConfig` (une surcharge inconnue est refusée par la lib du banc).
- Version : `<RISK_ENGINE_VERSION>-variante.<id>` (`variantEngineVersion`) + **empreinte** déterministe
  (FNV-1a 32 bits sur le JSON à clés triées de la config résolue) stockée avec chaque rejeu : deux contenus
  différents sous le même identifiant ne sont jamais confondus.
- Rejeu : sur les `VerdictRecord` dont `facts.version === RISK_FACTS_VERSION` (les autres sont comptés et
  écartés), mêmes issues pour la référence et la variante. Sortie : métriques des deux côtés, matrice des
  changements de verdict (de → vers) et changements « corrigés » / « dégradés » par rapport à l'issue.
- Une variante ne passe dans Raijin que via une PR qui modifie `DEFAULT_RISK_ENGINE_CONFIG` et la version du
  moteur (docs/SCORING.md) ; le banc ne modifie jamais le moteur de Raijin.

### 16.5 Rétention et alerte de taille (`DEFAULT_RETENTION_POLICY`)
- Snapshots détaillés de collecte : 30 j ; verdicts et observations de suivi : 365 j (minimum 30 j, toujours
  au-delà de la fenêtre 7 j + tolérance) ; `job_runs` : 30 j ; agrégats quotidiens : conservés.
  Les agrégats sont calculés avant la purge (même ordre que Raijin, §14.5).
- Alerte de taille : `used / allocated` ≥ 0,8 → `warn`, ≥ 0,95 → `critical` ; notification seulement au
  changement de niveau à la hausse (pas de répétition). Envoi (e-mail + push du banc) en phase 8 bis.

### 16.6 Écran du banc
- Route `/justesse` dans la zone connectée de `apps/raijin-banc-de-test` (lien dans l'onglet Performance) :
  tableau de justesse par horizon et comparaison côte à côte référence / variante. Mobile first : cartes empilées
  < 768 px, tableau au-delà. Badge « BANC DE TEST », pas de mascotte, thème du banc.
- Données : **simulées** (`simulation.ts` de la lib, jeu déterministe à graine, bandeau « Données simulées »)
  tant que l'API du banc n'existe pas ; un port `VerdictQualitySource` est remplacé par le client HTTP en 8 bis.

## 17. Banc sur le VPS (phase 8 bis)

Portage de Raijin-banc-de-test (Supabase + Vercel) sur le VPS : API NestJS `apps/raijin-banc-de-test-api`,
base `raijin_bench`, BullMQ préfixé `raijin-bench`, front `apps/raijin-banc-de-test` branché sur l'API.
Inventaire de l'existant et équivalents cibles : `docs/BENCH.md` (T1). Aucune écriture sur Supabase ni
Vercel par un agent ; migration et bascule lancées par l'utilisateur.

### 17.1 Scopes et frontières
| Tag | Projets | Peut dépendre de |
|---|---|---|
| `scope:bench` | `raijin-banc-de-test`, `raijin-banc-de-test-api`, `libs/bench/*` | `bench`, `server`, `solana`, `shared` |
| `scope:server` | `libs/server/push` (`@raijin/server-push`), `libs/server/security` (`@raijin/server-security`) | `server`, `shared` |
| `scope:api` | `api`, `libs/api/*` | `api`, `server`, `solana`, `shared` |

- `scope:server` : briques Node **sans métier** partagées par les deux API (envoi web-push VAPID ;
  argon2id, TOTP, codes de secours, secret-box). Elles ne lisent aucune variable d'environnement : clés,
  paires VAPID et paramètres sont passés par l'application appelante (paires et secrets distincts par API).
  Le code est extrait de `libs/api/notifications` et `libs/api/auth` en T3 ; un éventuel `server-http`
  (filtre d'erreur, pipe Zod, CSRF, cookies) ne sera créé que si l'extraction depuis `api-core` est sans métier.
- Inchangé : aucun projet Raijin (`web`, `api`, `landing`, `shared`, `solana`, `server`) ne dépend de
  `scope:bench` ; `scope:bench` ne dépend jamais de `scope:api`. Règle dans `eslint.config.mjs`
  (`@nx/enforce-module-boundaries`), vérifiée par sondes temporaires et par `nx graph`.

### 17.2 Projets
Créés (tous `scope:bench`, alias `@raijin/bench-*`, aucun import de `scope:api` ; `bench-solana` passe par
`@raijin/api-solana`, tag `scope:solana`) :

| Projet | Type | Rôle |
|---|---|---|
| `apps/raijin-banc-de-test-api` | app (`@nx/nest`) | app **fine** : `main.ts` (bootstrap, port `API_PORT`, 3000 dans `raijin-bench-api`) et `cli.ts` (`create-owner`, `set-password`, `reset-2fa`, alias `enroll-totp` / `reset-totp`, via `benchCliMain` de `bench-core`) ; le métier vit dans les libs |
| `apps/raijin-banc-de-test` | app Angular | front du banc, **affichage seulement** (composants, stores à signaux, routes, PWA) ; client HTTP et SSE dans l'app (`src/app/core/api/` : `BenchApi`, `BenchEvents`), pas de lib `bench-data-access` séparée ; exceptions §17.8 |
| `libs/bench/web-logic` | `type:util` | logique pure du front (`@raijin/bench-web-logic`) : modèles et lecture des lignes de l'API, backtest, performance, presets, portefeuille simulé, graphe de prix, alertes, coût aller-retour, formatage ; points d'entrée par domaine (`/opportunities`, `/alerts`, `/strategy-lab`, `/portfolio`, `/performance`, `/paper-trade`, `/settings`, `/shadow`, `/verdict-quality`, `/testing` pour les specs) ; ni Angular ni API Node |
| `libs/bench/contracts` | `type:contracts` | contrats Zod (§17.3) et seuils officiels de bascule `SHADOW_ACCEPTANCE` / `evaluateShadowAcceptance` (§17.6) |
| `libs/bench/core` | `type:feature` | config validée au démarrage, auth du compte unique, CSRF, limites par IP, jobs BullMQ (`BenchJobRegistry`, `BenchJobRunner`, `BenchJobScheduler`, `job_runs`), SSE, mode `shadow`/`primary` (`BenchModeService`, `BenchNotifier`), `/api/health`, `/api/status`, CLI |
| `libs/bench/prisma` | `type:data-access` | schéma, migrations SQL (fonctions et déclencheurs d'origine à l'identique, schémas `shadow_ref` et `archive`), `BenchPrismaService`, `BenchSqlService` (pool `pg` + `SqlBenchDbExecutor`), listes de tables partagées avec `infra/bench-migrate.sh` (`bench-tables.ts`) |
| `libs/bench/engine` | `type:util` | port Node des 7 Edge Functions et de `_shared` (sans Nest), client `BenchDb` (ci-dessous) |
| `libs/bench/collect` | `type:feature` | jobs `scan-tokens`, `enrich-tokens`, `label-outcomes`, `wallet-study-collect`, lectures tokens / alertes / réglages / push |
| `libs/bench/trading` | `type:feature` | SIMULATION : `paper-engine`, `backtest-run`, `backtest-nightly`, ex-RPC `paper_*`, `performance_*`, labo |
| `libs/bench/quality` | `type:feature` | mesure du risque (§16) : `verdict-follow-up`, `verdict-aggregate` (agrégats, rejeu, précalcul du rapport de justesse), `retention-purge`, `storage-check`, `GET /api/verdicts/quality` (lit le précalcul), `GET /api/shadow/comparison` |
| `libs/bench/solana` | `type:data-access` | `createBenchSolana` : `SolanaDataService` de `api-solana` avec les paramètres du banc (§17.5), budget Redis préfixé, recul sur 429, source `getTransactionsForAddress` de wallet-study |
| `libs/bench/verdicts` | `type:util` | code pur de la mesure (§16), seuils de stockage |

**Client `BenchDb`** (`libs/bench/engine/src/db/bench-db.ts`) : remplace `createClient(SUPABASE_URL, SERVICE_ROLE_KEY)`
dans le code porté, pour que les requêtes des Edge Functions restent **à l'identique** (même interface fluide
`from().select().eq()…`, `rpc()`, mêmes résultats `{ data, error, count }` ; alias de type `SupabaseClient`). Chaque
requête devient un `QuerySpec` exécuté par un `BenchDbExecutor` : en production `SqlBenchDbExecutor`
(`@raijin/bench-prisma`) exécute le SQL paramétré produit par `compileQuery` / `compileRpc` (`engine/src/db/sql-compiler.ts`,
façon PostgREST : `json_agg`, plafond `max-rows` de 1 000 lignes, fonctions SQL appelées à arguments nommés, types lus
dans `pg_proc`) sur `raijin_bench` avec l'utilisateur `raijin_bench` seul ; dans les tests `MemoryDbExecutor` (tables en
mémoire, avec les réponses d'API enregistrées). Sous-ensemble couvert = celui des 7 fonctions (vérifié par grep) : une
méthode hors de ce sous-ensemble n'existe pas sur l'interface (erreur de compilation).

### 17.3 Contrats (`@raijin/bench-contracts`)
- Propres au banc, donc hors `shared-contracts` ; ils réutilisent les schémas partagés (`mintAddressSchema`,
  `emailSchema`, `currentPasswordSchema`, `totpCodeSchema`, `pushSubscriptionRequestSchema`) et les seuils de
  stockage de `bench-verdicts`. Types par `z.infer` uniquement : le front et l'API du banc n'en dupliquent aucun.
- Format : noms de colonnes `snake_case` identiques aux tables Supabase portées (les parseurs et libellés du
  front restent valables), dates ISO 8601, `numeric` sérialisé en `number` fini. Textes externes bornés et
  nettoyés à l'affichage.
- Modules : `common` (préfixe `/api`, erreurs `{ code, message }`, listes `{ items, truncated }`), `mode`
  (`shadow` | `primary`), `auth`, `jobs` (`job_runs`, statut `running|success|failed|skipped`, erreur ≤ 500
  caractères sans secret), `tokens` (tokens, briefs, snapshots, taux `scan_runs`), `alerts` (journal, réglages,
  push de test), `paper` (carnets, positions + jambes, ouverture / annulation / remise à zéro, ex-RPC
  `paper_*`), `performance` (ex-RPC `performance_by_preset`, `paper_book_comparison`, `performance_breakdown`),
  `lab` (runs et résultats de backtest, ex-`backfill_progress` et `backtest_request_run`), `shadow`
  (comparaison), `health` (liveness publique derrière basicAuth, statut authentifié, stockage), `sse`
  (événements), `routes` (table unique `BENCH_ROUTES` partagée par le contrôleur et le client).
- Les contrats suivent l'inventaire de T1 : une table, vue ou RPC « morte, non portée » dans `docs/BENCH.md`
  n'a pas d'endpoint ; une entrée portée absente d'ici est ajoutée avant T6.

### 17.4 SSE (remplace Supabase Realtime)
- `GET /api/events`, authentifié, `text/event-stream` ; `event: <type>` + `data: <JSON>` (`benchEventSchema`,
  union discriminée sur `type`) : `heartbeat` (25 s), `token.upsert` / `token.delete` (ex-canal `tokens-live`),
  `paper.changed` (ex-`paper-positions-live`, le front recharge), `job.finished`, `backtest.progress`.
- Pas de rejeu : après reconnexion (`EventSource`), le front recharge ses listes. Traefik : ni compression ni
  tampon sur ce chemin (T10).

### 17.5 Helius et Redis
- `api-solana` instancié par le banc avec ses propres paramètres (`BENCH_HELIUS_API_KEY`, 3 req/s RPC,
  0,5 req/s DAS, 10 000 crédits/jour, compteurs `raijin-bench:`), sans jamais lire `HELIUS_API_KEY` (T4).
  Wallet-study : voie de crédits `wallet` plafonnée à `BENCH_WALLET_STUDY_DAILY_CREDITS` (2 000 par défaut) dans
  les 10 000. Sources publiques (DexScreener, GeckoTerminal, Jupiter, RugCheck, RPC public) à la moitié des débits
  de Raijin, pause dès le 1er 429 puis recul exponentiel 30 s → 15 min (BENCH.md §9 P6) : Raijin reste prioritaire.
- Redis : ACL par application, `raijin-api` limité à `~raijin:*`, `raijin-bench` à `~raijin-bench:*`,
  `default` désactivé (T10) ; toutes les clés de l'API Raijin passent sous `raijin:` (T3).
- Préfixe posé **par connexion** (`keyPrefix` d'ioredis, `raijinRedisOptions()` / `REDIS_KEY_PREFIX` d'`api-core`) sur
  les six connexions de l'API : throttler, tentatives de connexion, analyse (cache, verrous, quotas, budget Helius,
  compteurs d'usage), `RedisKeyValueStore.connect`, admin, analytics. Il couvre GET/SET, MULTI, pipelines et les
  `KEYS[]` des scripts Lua (`call('eval')` du throttler compris) ; aucun `KEYS`/`SCAN` (non préfixés) dans l'API.
  BullMQ refuse `keyPrefix` : ses connexions gardent `BULLMQ_PREFIX=raijin` (clés `raijin:<file>:*`).
  Changement de clé sans migration : compteurs, verrous et caches repartent à neuf, aucune clé n'est supprimée.
- Motifs de clés de l'API (tous sous `raijin:`) :
  throttler `{<traceur>:<throttler>}:hits|blocked` ; tentatives `rj:auth-fail:<hmac>`, `rj:admin-2fa-fail:<userId>` ;
  verrous `lock:watch-planner`, `lock:watch:mint:<mint>`, `lock:trial-tick`, `lock:admin-alerts`,
  `lock:metrics-aggregate`, `analysis:lock:<mint>`, `wallet:lock:<clé>` ; analyse `analysis:result|notfound|unanalyzable|unavailable:…`,
  `og:<mint>:…`, `quota:<service>:<jour>`, `quota:seen:<type>:<sujet>:<mint>` ; Helius `helius:credits:<jour>`,
  `helius:credits:watch|wallet:<jour>` ; cache Solana `solana:rugcheck|token-created|creator|token-owner|account-program|light-facts:v1|wallet-pairs:…` ;
  wallet `wallet:scan|verdict|rejected:…` ; essai `trial-email:…`, `trial-fp:…` ; admin `admin:counters:<jour>`,
  `admin:live:v1:<jour>`, `admin:acquisition:v1:…` ; analytics `analytics:v1:<service>:<sha256>` ; BullMQ `raijin:<file>:*`.
  Attention au double préfixe : un `PrefixedRedisCreditBudget` (T4) branché sur une connexion `raijinRedisOptions()`
  écrirait `raijin:raijin:helius:…` ; l'API Raijin garde donc `RedisCreditBudget`, le banc (connexion sans
  `keyPrefix`) passe `raijin-bench:` au budget préfixé.

### 17.6 Mode ombre
- `BENCH_MODE=shadow` : collecte et jobs actifs, **aucune notification** (push, e-mail), pas d'ouverture
  automatique de positions paper (`BENCH_SHADOW_MODE`). `primary` après bascule.
- Comparaison sans accès Supabase depuis l'API : `infra/bench-migrate.sh --shadow-snapshot --since <date>`
  (utilisateur, `pg_dump` en lecture) copie la fenêtre dans le schéma `shadow_ref` ; `GET /api/shadow/comparison`
  confronte `public` et `shadow_ref` par table et par jour (écart en %, mints d'un seul côté), 31 jours au plus, et
  renvoie la fenêtre de l'instantané (`snapshot_window`, `shadow_ref.snapshot_meta`).
- Seuils officiels de bascule : `SHADOW_ACCEPTANCE` (`@raijin/bench-contracts`), appliqués par
  `evaluateShadowAcceptance` sur les seuls jours UTC complets de l'instantané ; l'écran `/comparaison` les lit sans
  copie. Procédure, budget Helius, jobs et retour arrière : `docs/BENCH.md` §12.

### 17.7 Authentification du banc
- Un seul compte (`BENCH_OWNER_EMAIL`) ; ni inscription ni réinitialisation par e-mail. Mot de passe argon2id
  et TOTP posés par la CLI du conteneur (`create-owner`, puis `set-password`, `reset-2fa` ; alias `enroll-totp`,
  `reset-totp`), lancée par l'utilisateur (`docs/BENCH.md` §12 étape 2).
- Connexion en une étape (`email`, `password`, `totp`) : une seule erreur `AUTH_INVALID_CREDENTIALS`, throttler
  renforcé. Session httpOnly courte (2 h d'inactivité, 12 h au plus), CSRF double-submit (`X-CSRF-Token`).
- Cookies `__Host-rjb_session` / `__Host-rjb_csrf` (sans préfixe en HTTP local), distincts de ceux de Raijin
  (`rj_*`), secrets de signature distincts : un cookie ou jeton Raijin, même admin, vaut 401 côté banc.
- Double verrou : basicAuth Traefik en amont, puis cette auth applicative sur toute route sauf `health` et
  `auth/login`.

### 17.8 Exceptions : fichiers sans Angular restés dans `apps/raijin-banc-de-test`
Règle : tout calcul pur du front vit dans `libs/bench/web-logic` (tests déplacés avec le code). Restent dans l'app,
parce qu'ils sont liés à son infrastructure et non au métier :
- `core/api/token-briefs.ts`, `features/opportunities/token-query.ts` : assemblent des appels au client `BenchApi`
  (classe de l'app, injectée par Angular) ; les déplacer tirerait le client HTTP dans une lib `type:util`.
- `core/pwa/notification-url.ts` : liste blanche des routes de l'app qu'une notification push peut ouvrir ; elle
  reflète la table des routes de l'app (`app.routes.ts`) et sert la navigation PWA, pas le métier du banc.
- `features/strategy-lab/lab-test-data.ts`, `features/performance/performance-test-data.ts`,
  `features/opportunities/components/price-chart-test-data.ts` : doublures de test du client de l'app
  (`FakeBenchApi`, `provideFakeBench`), utilisées par les specs de composants et de stores ; les fabriques de lignes
  pures (`runRow`, `breakdownRow`…) vivent dans `@raijin/bench-web-logic/testing`, que les deux premières réexportent.
- `src/types/text-imports.d.ts` : déclaration de type du builder Angular.
