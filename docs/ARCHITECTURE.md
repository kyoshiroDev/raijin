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
| `api-solana` | `libs/api/solana` | Clients Helius / RPC, DexScreener, GeckoTerminal, Jupiter, RugCheck, file de débit, agrégateur de faits (partagé avec l'API du banc) | `scope:solana`, `type:data-access` |
| `api-prisma` | `libs/api/prisma` | Schéma Prisma, migrations, client généré, `PrismaService` | `scope:api`, `type:data-access` |
| `api-core` | `libs/api/core` | Socle Nest transverse : config Zod, filtre d'erreurs, Helmet, CORS, throttler, CSRF, cookies | `scope:api`, `type:util` |
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
annulation des exécutions obsolètes. E2E Playwright uniquement sur les PR vers `main`,
artefacts de captures envoyés seulement en cas d'échec.

- **Job `e2e`** (PR vers `main` uniquement, après le job principal) : conteneurs de service
  Postgres 17 (`postgres:17.12-alpine`), Redis (`redis:8.10.3-alpine`) et Mailpit
  (`axllent/mailpit:v1.34.0`), épinglés par tag précis **et** digest, avec healthchecks, sur les
  mêmes ports hôte que `docker-compose.dev.yml` (5433, 6380, 1026, 8026) : la configuration de
  développement de l'API et des suites s'applique sans adaptation. Variables non secrètes
  (`DATABASE_URL` factice, `REDIS_URL`, `SMTP_*`, `MAILPIT_URL`) ; `JWT_ACCESS_SECRET` et
  `COOKIE_SECRET` tirés au hasard dans le job et masqués (aucun secret GitHub). Étapes :
  `api-prisma:migrate-deploy`, Chromium seul (navigateurs en cache, clé = version de
  Playwright), puis `nx affected -t e2e` en deux passes (api-e2e, puis web-e2e) pour que
  Playwright démarre sa propre API avec `JWT_ACCESS_TTL=20s` et des limites hautes au lieu de
  réutiliser celle de la première suite. Rapport HTML et captures (`dist/.playwright/**`)
  envoyés en artefact (7 jours) uniquement en cas d'échec.
- **E2E en local** : `pnpm nx run api:dev-infra` (Postgres, Redis, Mailpit), puis
  `pnpm nx run api-prisma:migrate-deploy` au premier lancement, puis `pnpm nx e2e api-e2e`
  et `pnpm nx e2e web-e2e` (une API déjà lancée est réutilisée par Playwright : la lancer alors
  avec `JWT_ACCESS_TTL=20s`). Arrêt : `pnpm nx run api:dev-infra-stop`.

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
  | Refresh | `__Secure-rj_rt` | `rj_rt` | `/api/v1/auth` | aucun |
  | CSRF | `__Host-rj_csrf` | `rj_csrf` | `/` | aucun |

  Aucun jeton dans le corps des réponses ni dans le `localStorage`/`sessionStorage`. Le cookie
  d'access vit aussi longtemps que la session (le JWT, lui, expire après 15 min) : son `sid` signé
  reste lisible pour la garde CSRF de `POST /auth/refresh`. Un refresh réutilisé dans les 10 s
  (onglets concurrents) reçoit 409 `CONFLICT` sans révoquer la famille ni effacer les cookies (le
  front rejoue sa requête) ; au-delà, toute la famille est révoquée (401 `AUTH_SESSION_EXPIRED`).
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
  vers l'API, donc pas de CORS ni de cookie inter-origines en local. En prod, `API_BASE_URL` vaut
  `https://api.raijinshield.com/api/v1` et les requêtes partent avec `withCredentials: true`.
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
  qui rejoue `libs/api/solana/src/fixtures` (`ANALYSIS_FIXTURES_DIR`). Utilisé par `api:serve-e2e` (avec
  `TRUST_PROXY=1` pour simuler une IP par test via `X-Forwarded-For`).
- **Quota** : `QuotaService.resolvePolicy` (relu en base : Gratuit, essai actif, Pro ; seul point à étendre en phase 6)
  → `reserve` (`INSERT … ON CONFLICT … DO UPDATE … WHERE count < limit RETURNING count`) → `refund` sur toute
  erreur. Empreinte d'IP : HMAC(`IP_HASH_SECRET`) tronqué, IPv6 regroupée par /64. Throttler `analysis`
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
