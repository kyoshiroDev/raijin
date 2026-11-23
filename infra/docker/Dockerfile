# syntax=docker/dockerfile:1.7
# =====================================================================================================
# Images de production Raijin Shield (multi-étapes, une cible par service de infra/docker-compose.yml).
# Contexte de build : racine du dépôt (filtré par infra/docker/Dockerfile.dockerignore : jamais de .env,
# .secrets/, node_modules, dist, .git).
#
#   deps          installation pnpm complète du monorepo (une seule fois, partagée par toutes les cibles)
#   build-*       build Nx de chaque projet (seule l'étape demandée par la cible est construite)
#   api           Node 24 + dist/apps/api + dépendances de production seules, utilisateur « node »
#   migrate       CLI Prisma (migrate deploy), lancée par deploy.sh avant la nouvelle API
#   web, landing, bench-web   fichiers statiques servis par nginx:alpine, utilisateur « nginx » (101), port 8080
#   bench-api     API du banc (phase 8 bis : apps/raijin-banc-de-test-api n'existe pas encore)
#
# Build : uniquement par infra/deploy.sh sur le VPS (docker compose build). Mémoire : ~2 Go pendant le build
# d'Angular ; les builds sont lancés un par un (docs/DEPLOY.md).
# =====================================================================================================

ARG NODE_IMAGE=node:24.14.0-bookworm-slim
ARG NGINX_IMAGE=nginx:1.29-alpine

# ---------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
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
RUN pnpm nx run api:prune --parallel=1 --outputStyle=static

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
# Phase 8 bis : le projet sera généré avec les mêmes cibles que api (build, prune).
RUN pnpm nx run raijin-banc-de-test-api:prune --parallel=1 --outputStyle=static

# ---------------------------------------------------------------------------------------------------
# Dépendances de production de l'API (package.json + pnpm-lock.yaml élagués par api:prune).
FROM base AS api-prod-deps
COPY --from=build-api /app/dist/apps/api/package.json /app/dist/apps/api/pnpm-lock.yaml /app/dist/apps/api/pnpm-workspace.yaml /app/dist/apps/api/
WORKDIR /app/dist/apps/api
RUN --mount=type=cache,id=raijin-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --prod --frozen-lockfile

# ---------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production \
    API_PORT=3000 \
    WEB_INDEX_HTML_PATH=/app/web/index.html
WORKDIR /app
COPY --from=api-prod-deps --chown=root:root /app/dist/apps/api/node_modules ./dist/apps/api/node_modules
COPY --from=build-api --chown=root:root /app/dist/apps/api ./dist/apps/api
# index.html du build web du MÊME commit (balises OG de /t/<mint>, docs/ARCHITECTURE.md §9.7).
COPY --from=build-web --chown=root:root /app/dist/apps/web/browser/index.html ./web/index.html
# Fichiers en lecture seule pour l'utilisateur d'exécution (le système de fichiers du conteneur l'est aussi).
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/apps/api/main.js"]

# ---------------------------------------------------------------------------------------------------
# Migrations Prisma : CLI et migrations du dépôt (libs/api/prisma), DATABASE_URL fournie par Compose.
FROM build-api AS migrate
ENV NODE_ENV=production
WORKDIR /app/libs/api/prisma
# Télécharge le moteur de schéma au build (node_modules/@prisma/engines) : la migration n'a alors plus besoin
# d'Internet (le réseau raijin-egress reste un filet de sécurité).
RUN /app/node_modules/.bin/prisma version
USER node
CMD ["/app/node_modules/.bin/prisma", "migrate", "deploy"]

# ---------------------------------------------------------------------------------------------------
FROM ${NGINX_IMAGE} AS nginx-base
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
FROM base AS bench-api-prod-deps
COPY --from=build-bench-api /app/dist/apps/raijin-banc-de-test-api/package.json /app/dist/apps/raijin-banc-de-test-api/pnpm-lock.yaml /app/dist/apps/raijin-banc-de-test-api/pnpm-workspace.yaml /app/dist/apps/raijin-banc-de-test-api/
WORKDIR /app/dist/apps/raijin-banc-de-test-api
RUN --mount=type=cache,id=raijin-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --prod --frozen-lockfile

FROM ${NODE_IMAGE} AS bench-api
ENV NODE_ENV=production \
    API_PORT=3000
WORKDIR /app
COPY --from=bench-api-prod-deps /app/dist/apps/raijin-banc-de-test-api/node_modules ./dist/apps/raijin-banc-de-test-api/node_modules
COPY --from=build-bench-api /app/dist/apps/raijin-banc-de-test-api ./dist/apps/raijin-banc-de-test-api
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/apps/raijin-banc-de-test-api/main.js"]
