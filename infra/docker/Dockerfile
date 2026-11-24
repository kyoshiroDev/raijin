# syntax=docker/dockerfile:1.7
# =====================================================================================================
# Images de production Raijin Shield (multi-étapes, une cible par service de infra/docker-compose.yml).
# Contexte de build : racine du dépôt (filtré par infra/docker/Dockerfile.dockerignore : jamais de .env,
# .secrets/, node_modules, dist, .git).
#
#   deps          installation pnpm complète du monorepo (une seule fois, partagée par toutes les cibles)
#   build-*       build Nx de chaque projet (seule l'étape demandée par la cible est construite)
#   api           Node 24 + dist/apps/api + dépendances de production seules (contrôlées par check-externals.cjs), utilisateur « node »
#   migrate       image minimale : CLI Prisma seule + schéma et migrations (migrate deploy), lancée par deploy.sh
#   bench-migrate idem pour la base du banc raijin_bench (libs/bench/prisma), lancée par deploy.sh --bench
#   web, landing, bench-web   fichiers statiques servis par nginx:alpine, utilisateur « nginx » (101), port 8080
#   bench-api     API du banc (apps/raijin-banc-de-test-api), même contrôle check-externals.cjs que l'API
#
# Build : uniquement par infra/deploy.sh sur le VPS (docker compose build). Mémoire : ~2 Go pendant le build
# d'Angular ; les builds sont lancés un par un (docs/DEPLOY.md).
# =====================================================================================================

# Images de base épinglées par digest, écrites en clair dans chaque FROM pour que Dependabot (écosystème docker,
# .github/dependabot.yml) puisse proposer leurs mises à jour.

# ---------------------------------------------------------------------------------------------------
FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NX_DAEMON=false \
    NX_NO_CLOUD=true \
    NX_TUI=false \
    NX_SKIP_NX_CACHE=true \
    HUSKY=0
# openssl : détection de libssl par la CLI Prisma (migrate) ; ca-certificates : téléchargements HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Scripts d'installation : seulement ceux autorisés par pnpm-workspace.yaml (allowBuilds).
RUN --mount=type=cache,id=raijin-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------------------------------
FROM deps AS source
COPY . .
ENV NODE_OPTIONS=--max-old-space-size=2048

FROM source AS build-api
# api:build (webpack, generatePackageJson) écrit dist/apps/api/package.json avec TOUTES les dépendances externes
# des bundles (libs internes comprises) + pnpm-lock.yaml élagué. Les cibles Nx prune / prune-lockfile ont été retirées
# (phase 9) : elles remplaçaient ce package.json par apps/api/package.json (7 dépendances : « Cannot find module 'zod' »).
RUN pnpm nx run api:build --parallel=1 --outputStyle=static

FROM source AS build-web
RUN pnpm nx run web:build:production --parallel=1 --outputStyle=static

FROM source AS build-landing
# Valeurs PUBLIQUES lues au build par astro:env (docs/DEPLOY.md, partie B §6.1) ; jamais de secret ici.
ARG APP_URL=https://app.raijinshield.com
ARG GA4_MEASUREMENT_ID=
ARG GOOGLE_SITE_VERIFICATION=
RUN APP_URL="$APP_URL" GA4_MEASUREMENT_ID="$GA4_MEASUREMENT_ID" GOOGLE_SITE_VERIFICATION="$GOOGLE_SITE_VERIFICATION" \
    pnpm nx run landing:build --parallel=1 --outputStyle=static

FROM source AS build-bench-web
RUN pnpm nx run raijin-banc-de-test:build:production --parallel=1 --outputStyle=static

FROM source AS build-bench-api
# Comme api : webpack + generatePackageJson (package.json et pnpm-lock.yaml élagués dans dist) ; pas de cible prune.
RUN pnpm nx run raijin-banc-de-test-api:build --parallel=1 --outputStyle=static

# ---------------------------------------------------------------------------------------------------
# Dépendances de production de l'API (package.json + pnpm-lock.yaml générés par api:build).
FROM base AS api-prod-deps
COPY --from=build-api /app/dist/apps/api/package.json /app/dist/apps/api/pnpm-lock.yaml /app/dist/apps/api/pnpm-workspace.yaml /app/dist/apps/api/
COPY --from=build-api /app/dist/apps/api/main.js /app/dist/apps/api/cli.js /app/dist/apps/api/
COPY package.json /tmp/root-package.json
COPY infra/docker/check-externals.cjs /usr/local/bin/check-externals.cjs
WORKDIR /app/dist/apps/api
# pnpm à la version EXACTE du dépôt (packageManager de package.json), jamais « la dernière » de Corepack ;
# node_modules « à plat » dans le dossier (pas de magasin global hors image). Puis contrôle : tous les modules
# externes requis par main.js et cli.js doivent se résoudre, sinon le build échoue.
RUN --mount=type=cache,id=raijin-pnpm-store,target=/pnpm/store \
    pm="$(node -p "require('/tmp/root-package.json').packageManager")" \
 && corepack prepare "$pm" --activate \
 && node -e "const p=require('./package.json');p.packageManager=process.argv[1];require('fs').writeFileSync('package.json',JSON.stringify(p,null,2))" "$pm" \
 && pnpm --version \
 && pnpm install --prod --frozen-lockfile --store-dir /pnpm/store --config.node-linker=hoisted --config.enable-global-virtual-store=false \
 && node /usr/local/bin/check-externals.cjs /app/dist/apps/api main.js cli.js \
 && rm -f main.js cli.js

# ---------------------------------------------------------------------------------------------------
FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS api
ENV NODE_ENV=production \
    API_PORT=3000 \
    WEB_INDEX_HTML_PATH=/app/web/index.html
WORKDIR /app
COPY --from=api-prod-deps --chown=root:root /app/dist/apps/api/node_modules ./dist/apps/api/node_modules
COPY --from=build-api --chown=root:root /app/dist/apps/api ./dist/apps/api
# index.html du build web du MÊME commit (balises OG de /t/<mint>, docs/ARCHITECTURE.md §9.7).
COPY --from=build-web --chown=root:root /app/dist/apps/web/browser/index.html ./web/index.html
# Contrôle final dans l'image telle qu'elle sera exécutée (bundles + node_modules réunis).
COPY --from=api-prod-deps /usr/local/bin/check-externals.cjs /tmp/check-externals.cjs
RUN node /tmp/check-externals.cjs /app/dist/apps/api main.js cli.js && rm /tmp/check-externals.cjs
# Fichiers en lecture seule pour l'utilisateur d'exécution (le système de fichiers du conteneur l'est aussi).
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/apps/api/main.js"]

# ---------------------------------------------------------------------------------------------------
# Migrations Prisma : image minimale (CLI Prisma à la version exacte du dépôt + schéma + migrations, sans le
# monorepo ni ses dépendances). Le moteur de schéma est téléchargé AU BUILD : aucune sortie Internet à l'exécution.
FROM base AS migrate-cli
ARG PRISMA_VERSION=7.10.1
WORKDIR /app
COPY package.json /tmp/root-package.json
# Garde-fou : la version doit être celle de package.json (sinon le build échoue).
RUN node -e "const p=require('/tmp/root-package.json');const v=(p.devDependencies||{}).prisma||(p.dependencies||{}).prisma;if(v!==process.env.PRISMA_VERSION){console.error('PRISMA_VERSION='+process.env.PRISMA_VERSION+' différent de package.json ('+v+')');process.exit(1)}" \
 && echo '{"private":true}' > package.json \
 && npm install --no-save --no-audit --no-fund --ignore-scripts "prisma@${PRISMA_VERSION}" \
 && CHECKPOINT_DISABLE=1 node_modules/.bin/prisma version >/dev/null \
 && ls node_modules/@prisma/engines | grep -q '^schema-engine-' \
 && npm cache clean --force

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS migrate-runtime
ENV NODE_ENV=production \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1 \
    HOME=/tmp
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=migrate-cli --chown=root:root /app/node_modules /app/node_modules

FROM migrate-runtime AS migrate
COPY --chown=root:root libs/api/prisma/prisma.config.ts /app/libs/api/prisma/prisma.config.ts
COPY --chown=root:root libs/api/prisma/prisma/schema.prisma /app/libs/api/prisma/prisma/schema.prisma
COPY --chown=root:root libs/api/prisma/prisma/migrations /app/libs/api/prisma/prisma/migrations
WORKDIR /app/libs/api/prisma
USER node
CMD ["/app/node_modules/.bin/prisma", "migrate", "deploy"]

# Base du banc (raijin_bench) : même CLI, schéma et migrations de libs/bench/prisma ; prisma.config.ts lit
# BENCH_DATABASE_URL (utilisateur raijin_bench, imposé par infra/docker-compose.yml).
FROM migrate-runtime AS bench-migrate
COPY --chown=root:root libs/bench/prisma/prisma.config.ts /app/libs/bench/prisma/prisma.config.ts
COPY --chown=root:root libs/bench/prisma/prisma/schema.prisma /app/libs/bench/prisma/prisma/schema.prisma
COPY --chown=root:root libs/bench/prisma/prisma/migrations /app/libs/bench/prisma/prisma/migrations
WORKDIR /app/libs/bench/prisma
USER node
CMD ["/app/node_modules/.bin/prisma", "migrate", "deploy"]

# ---------------------------------------------------------------------------------------------------
FROM nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de AS nginx-base
# Configuration principale non root (pid et fichiers temporaires dans /tmp, port 8080, pas de version).
COPY infra/nginx/nginx.conf /etc/nginx/nginx.conf
RUN rm -f /etc/nginx/conf.d/default.conf
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
# Pas de scripts /docker-entrypoint.d (ils réécrivent la configuration, impossible en lecture seule).
ENTRYPOINT ["nginx", "-g", "daemon off;"]

FROM nginx-base AS web
COPY infra/nginx/web.conf /etc/nginx/conf.d/raijin.conf
COPY --from=build-web /app/dist/apps/web/browser /usr/share/nginx/html

FROM nginx-base AS landing
COPY infra/nginx/landing.conf /etc/nginx/conf.d/raijin.conf
COPY --from=build-landing /app/dist/apps/landing /usr/share/nginx/html

FROM nginx-base AS bench-web
COPY infra/nginx/bench-web.conf /etc/nginx/conf.d/raijin.conf
COPY --from=build-bench-web /app/dist/apps/raijin-banc-de-test/browser /usr/share/nginx/html

# ---------------------------------------------------------------------------------------------------
# Dépendances de production de l'API du banc : même procédé et même contrôle que api-prod-deps. Les bundles
# (main.js, et cli.js dès que l'app en a un : set-password, enroll-totp…) sont tous contrôlés.
FROM base AS bench-api-prod-deps
COPY --from=build-bench-api /app/dist/apps/raijin-banc-de-test-api/package.json /app/dist/apps/raijin-banc-de-test-api/pnpm-lock.yaml /app/dist/apps/raijin-banc-de-test-api/pnpm-workspace.yaml /app/dist/apps/raijin-banc-de-test-api/
COPY --from=build-bench-api /app/dist/apps/raijin-banc-de-test-api/*.js /app/dist/apps/raijin-banc-de-test-api/
COPY package.json /tmp/root-package.json
COPY infra/docker/check-externals.cjs /usr/local/bin/check-externals.cjs
WORKDIR /app/dist/apps/raijin-banc-de-test-api
RUN --mount=type=cache,id=raijin-pnpm-store,target=/pnpm/store \
    pm="$(node -p "require('/tmp/root-package.json').packageManager")" \
 && corepack prepare "$pm" --activate \
 && node -e "const p=require('./package.json');p.packageManager=process.argv[1];require('fs').writeFileSync('package.json',JSON.stringify(p,null,2))" "$pm" \
 && pnpm --version \
 && pnpm install --prod --frozen-lockfile --store-dir /pnpm/store --config.node-linker=hoisted --config.enable-global-virtual-store=false \
 && test -f main.js \
 && node /usr/local/bin/check-externals.cjs /app/dist/apps/raijin-banc-de-test-api $(ls ./*.js | sed 's|^\./||') \
 && rm -f ./*.js

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS bench-api
ENV NODE_ENV=production \
    API_PORT=3000
WORKDIR /app
COPY --from=bench-api-prod-deps --chown=root:root /app/dist/apps/raijin-banc-de-test-api/node_modules ./dist/apps/raijin-banc-de-test-api/node_modules
COPY --from=build-bench-api --chown=root:root /app/dist/apps/raijin-banc-de-test-api ./dist/apps/raijin-banc-de-test-api
# Contrôle final dans l'image telle qu'elle sera exécutée (bundles + node_modules réunis).
COPY --from=bench-api-prod-deps /usr/local/bin/check-externals.cjs /tmp/check-externals.cjs
RUN cd /app/dist/apps/raijin-banc-de-test-api \
 && node /tmp/check-externals.cjs . $(ls ./*.js | sed 's|^\./||') \
 && rm /tmp/check-externals.cjs
USER node
EXPOSE 3000
# Santé publique de l'API du banc : GET /api/health (préfixe /api, BENCH_ROUTES.health), sans données.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/apps/raijin-banc-de-test-api/main.js"]
