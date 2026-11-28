# Raijin Shield

**Raijin Shield**, le bouclier anti-rug des memecoins Solana : tu colles l'adresse d'un token, Raijin
vérifie les signaux de rug (autorités, liquidité, concentration des détenteurs, taxes, revente possible…)
et te rend un verdict clair **avant que tu signes**. Tu peux aussi suivre des tokens (alertes e-mail et
push), scanner un wallet en lecture seule et partager un verdict par lien public `/t/<mint>`.

Raijin lit la chaîne **en lecture seule** : aucune signature, aucun swap, aucune clé privée demandée.
Raijin Shield n'est **pas un conseil en investissement** : un verdict résume des signaux techniques à un
instant donné, il ne garantit rien.

## Arborescence (monorepo Nx, pnpm)

```
apps/
  web/                       App Angular (mobile first, PWA, zoneless, signals)
  web-e2e/                   Playwright : e2e, responsive, axe, captures, Lighthouse
  api/                       API NestJS (/api/v1), sert aussi /t/<mint> et les images OG
  api-e2e/                   Tests e2e de l'API
  landing/                   Landing Astro (SEO, guides)
  raijin-banc-de-test/       Front du banc de test (mesure des verdicts)
  raijin-banc-de-test-api/   API du banc
  raijin-banc-de-test-e2e/   Tests e2e du banc
libs/
  brand/                     Tokens, logos, icônes, mascotte (BRAND.md)
  shared/                    contracts (schémas Zod, seule source des types front/back), risk-engine, util
  web/                       ui, data-access, feature-analyse, feature-suivis, feature-wallet, feature-compte, feature-admin
  api/                       core, prisma, auth, users, analysis, solana, wallet, alerts, notifications, billing, trial, admin, analytics
  server/                    push, security (partagés par l'API et l'API du banc)
  bench/                     contracts, core, collect, engine, prisma, quality, solana, trading, verdicts
infra/                       Docker, Compose, Nginx, systemd, sauvegardes, déploiement (lancés par toi, jamais par les agents)
docs/                        Architecture, environnement, déploiement, banc, sécurité, API, états UI
```

Les apps ne contiennent pas de logique métier : tout vit dans les libs, avec des frontières vérifiées par
`@nx/enforce-module-boundaries` (tags `scope:*` et `type:*`, voir `docs/ARCHITECTURE.md` §1 et §2). Pour
voir le graphe : `pnpm nx graph`.

## Prérequis

- **Node 24.14** (voir `.nvmrc`) et **pnpm 11.6** (`corepack enable`, la version vient de `packageManager`)
- Docker avec `docker compose` (Postgres, Redis et Mailpit en local)
- Facultatif : `gh` (GitHub CLI) pour la CI et les PR

```bash
corepack enable
pnpm install
```

Variables d'environnement : copie le modèle de `docs/ENV.md` dans `.env` (valeurs factices suffisantes en
local). Aucune clé de service n'est nécessaire pour démarrer : sans clé, chaque service passe en simulation
locale.

## Démarrage local

```bash
# 1. Infra de dev (projet Compose raijin-dev) : Postgres 5433, Redis 6380, Mailpit 1026 / 8026
pnpm nx run api:dev-infra

# 2. Base : migrations Prisma
pnpm nx run api-prisma:migrate-dev

# 3. API en mode fixtures (sources Solana rejouées, sans réseau) sur http://localhost:3100
ANALYSIS_FIXTURES=1 pnpm nx serve api

# 4. App web sur http://localhost:4200 (proxy /api vers l'API)
pnpm nx serve web

# 5. Landing sur http://localhost:4321
pnpm nx serve landing

# 6. Banc de test (facultatif) : API du banc, puis front sur http://localhost:4300
pnpm nx serve raijin-banc-de-test-api
pnpm nx serve raijin-banc-de-test
pnpm bench:create-owner        # compte propriétaire unique du banc (voir docs/BENCH.md)

# Arrêter l'infra de dev
pnpm nx run api:dev-infra-stop
```

Les e-mails envoyés en local arrivent dans Mailpit : http://localhost:8026. Pour te donner le rôle admin :
`pnpm nx run api:make-admin`.

## Commandes Nx principales

```bash
pnpm nx run-many -t lint typecheck test build   # tout le dépôt (ce que vérifie la CI)
pnpm nx affected -t lint typecheck test build   # seulement ce qui a changé
pnpm nx build web --configuration=production    # build de prod de l'app
pnpm nx build api
pnpm nx build landing
pnpm nx graph                                   # graphe des projets et des dépendances
```

## Tests

```bash
pnpm nx test <projet>                 # tests unitaires (ex. shared-risk-engine, api-analysis, web-ui)
pnpm nx e2e api-e2e                   # e2e de l'API (infra de dev démarrée)
pnpm nx e2e web-e2e                   # e2e Playwright de l'app : parcours, responsive, axe, captures
pnpm nx e2e raijin-banc-de-test-e2e   # e2e du banc
node apps/web-e2e/scripts/lighthouse.mjs   # Lighthouse mobile (diagnostic local)
```

La mesure Lighthouse qui fait foi (objectif ≥ 95 sur mobile) est celle du job `lighthouse` de la CI
GitHub (`docs/ARCHITECTURE.md` §10.4).

## Documentation

| Document | Contenu |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Structure Nx, frontières, conventions, perf mobile, choix par phase |
| [`docs/ENV.md`](docs/ENV.md) | Toutes les variables d'environnement, avec où obtenir chaque clé |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Déploiement sur le VPS (`infra/deploy.sh`), sauvegardes, restauration |
| [`docs/BENCH.md`](docs/BENCH.md) | Banc de test : portage, migration de l'historique, mesure des verdicts |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Modèle de menace, mesures, audits de phase |
| [`docs/API.md`](docs/API.md) | Référence de l'API `/api/v1` |
| [`docs/UI-STATES.md`](docs/UI-STATES.md) | États de chaque écran (chargement, vide, erreur, partiel) |
| [`docs/COMPTES.md`](docs/COMPTES.md) | Services en ligne à créer et à brancher |
| [`libs/brand/BRAND.md`](libs/brand/BRAND.md) | Charte : nom, ton, couleurs, typographie, mascotte |

L'avancement du projet et les points « À brancher » sont suivis dans `docs/PROGRESS.md`.

---

Raijin Shield ne fournit aucun conseil en investissement. Fais toujours tes propres vérifications.
