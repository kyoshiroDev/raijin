#!/usr/bin/env bash
# =====================================================================================================
# Déploiement de Raijin sur le VPS (PROMPT.md §7) — lancé par l'utilisateur depuis le dépôt cloné sur le VPS
# (docs/DEPLOY.md, partie A). Jamais par un agent.
#
#   infra/deploy.sh                 prod : build + migrations + démarrage + contrôles
#   infra/deploy.sh --env dev       idem pour l'environnement dev (projet raijin-dev, infra/.env.dev, .env.dev.api)
#   infra/deploy.sh --skip-build    redémarre sur les images déjà construites (migrations comprises)
#   infra/deploy.sh --rollback      revient aux images du déploiement précédent (sans build ni migration)
#   infra/deploy.sh --bench         prod seulement : inclut le banc (profil « bench ») : images, migrations
#                                   raijin_bench, démarrage (infra/.env.bench-api et REDIS_BENCH_PASSWORD requis, A14)
#   Options : --yes (pas de question), --no-external-check (pas de contrôle HTTPS depuis l'extérieur)
#   Déploiement continu : ce script n'y sert pas (infra/deploy-gate.sh et infra/release.sh, docs/DEPLOY.md partie C).
#
# Garanties : aucun `docker compose down`, aucune suppression de volume, d'image ou de réseau, aucune
# commande sur un conteneur qui n'est pas « raijin-… ». Le réseau Traefik existant est seulement lu.
# Une sauvegarde locale est faite avant chaque migration en production.
# =====================================================================================================
set -Eeuo pipefail
RAIJIN_SCRIPT=deploy

external=1
# Tests (infra/ci/test-dev-env.sh) : pas de contrôle par le DNS public (le contrôle de routage local reste fait).
[[ "${RAIJIN_NO_EXTERNAL_CHECK:-0}" == 1 ]] && external=0
skip_build=0 rollback=0 bench=0 assume_yes=0 env=prod bad_arg=''
while (( $# > 0 )); do
  case "$1" in
    --skip-build) skip_build=1 ;;
    --rollback) rollback=1 ;;
    --bench) bench=1 ;;
    --yes) assume_yes=1 ;;
    --no-external-check) external=0 ;;
    --env)
      (( $# >= 2 )) || { echo "deploy.sh : --env attend une valeur." >&2; exit 1; }
      env="$2"; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) bad_arg="$1" ;;
  esac
  shift
done

[[ "$env" == prod || "$env" == dev ]] || { echo "deploy.sh : --env prod ou --env dev (reçu : « $env »)." >&2; exit 1; }
RAIJIN_ENV="$env"
# shellcheck source=infra/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

[[ -z "$bad_arg" ]] || die "option inconnue : $bad_arg"
[[ "$env" == dev && "$bench" == 1 ]] && die "--bench : le banc n'existe qu'en production."

trap "warn \"déploiement interrompu (ligne \$LINENO). Rien n'a été supprimé ; voir docs/DEPLOY.md A12 (retour arrière).\"" ERR

confirm() {
  [[ "$assume_yes" == 1 ]] && return 0
  local answer
  read -r -p "$1 [o/N] " answer
  [[ "$answer" == o || "$answer" == O || "$answer" == oui ]]
}

cd "$RAIJIN_ROOT"
require_cmd docker curl awk grep
require_cmd git
log "environnement $RAIJIN_ENV (projet Compose $RAIJIN_PROJECT, fichiers Compose : $RAIJIN_COMPOSE_DIR)."

# --- 1. Prérequis ---------------------------------------------------------------------------------------
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 manquant (docs/DEPLOY.md A1)."
compose_version="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
log "Docker $(docker version -f '{{.Server.Version}}' 2>/dev/null || echo '?'), Docker Compose $compose_version."
# Options utilisées : env_file.required (2.24), up --wait / --wait-timeout / --no-build, run --rm (sans --no-build,
# absent de certaines versions : l'image est vérifiée avant).
if [[ "$(printf '%s\n2.24.0\n' "$compose_version" | sort -V | head -n1)" != "2.24.0" ]]; then
  die "Docker Compose $compose_version trop ancien (2.24 minimum)."
fi
[[ -r "$RAIJIN_ENV_FILE" ]] || die "fichier $RAIJIN_ENV_FILE absent (modèle : docs/ENV.md, bloc « Production (VPS) » ou « Dev (VPS) »)."
[[ -r "$RAIJIN_API_ENV_FILE" ]] || die "fichier $RAIJIN_API_ENV_FILE absent (modèle : docs/ENV.md)."
for f in "$RAIJIN_ENV_FILE" "$RAIJIN_API_ENV_FILE"; do
  perms="$(stat -L -c '%a' "$f")"
  # 640 admis pour le .env du dev (root:deploy-dev, docs/DEPLOY.md C3).
  [[ "$perms" == 600 || "$perms" == 400 || ( "$perms" == 640 && "$RAIJIN_ENV" == dev && "$f" == "$RAIJIN_ENV_FILE" ) ]] \
    || warn "$f est lisible par d'autres comptes (droits $perms) : chmod 600 $f"
done

for key in TRAEFIK_NETWORK TRAEFIK_CERTRESOLVER LANDING_DOMAIN APP_DOMAIN API_DOMAIN \
           POSTGRES_SUPERUSER_PASSWORD RAIJIN_DB_PASSWORD BENCH_DB_PASSWORD REDIS_PASSWORD; do
  [[ -n "$(env_get "$RAIJIN_ENV_FILE" "$key")" ]] || die "$key est vide dans $RAIJIN_ENV_FILE."
done
for key in RAIJIN_DB_PASSWORD BENCH_DB_PASSWORD REDIS_PASSWORD; do
  # Insérés dans des URL de connexion : caractères sûrs uniquement (openssl rand -hex 32).
  [[ "$(env_get "$RAIJIN_ENV_FILE" "$key")" =~ ^[A-Za-z0-9_-]{24,}$ ]] \
    || die "$key doit faire au moins 24 caractères parmi A-Z a-z 0-9 _ - (génère-le avec : openssl rand -hex 32)."
done
for key in JWT_ACCESS_SECRET COOKIE_SECRET IP_HASH_SECRET TOTP_ENCRYPTION_KEY; do
  [[ -n "$(env_get "$RAIJIN_API_ENV_FILE" "$key")" ]] || die "$key est vide dans $RAIJIN_API_ENV_FILE (l'API refuserait de démarrer)."
done
file_name="$(env_get "$RAIJIN_ENV_FILE" RAIJIN_NAME)"
[[ -z "$file_name" || "$file_name" == "$RAIJIN_NAME" ]] \
  || die "RAIJIN_NAME=$file_name dans $RAIJIN_ENV_FILE, attendu $RAIJIN_NAME pour l'environnement $RAIJIN_ENV."

if [[ "$RAIJIN_ENV" == dev ]]; then
  # Le dev ne doit jamais toucher l'argent réel, ni partager un nom ou un secret avec la production.
  [[ -n "$(env_get "$RAIJIN_ENV_FILE" DEV_BASIC_AUTH_USERS)" ]] || die "DEV_BASIC_AUTH_USERS est vide dans $RAIJIN_ENV_FILE (docs/DEPLOY.md C4)."
  stripe_key="$(env_get "$RAIJIN_API_ENV_FILE" STRIPE_SECRET_KEY)"
  [[ "$stripe_key" != sk_live_* && "$stripe_key" != rk_live_* ]] || die "STRIPE_SECRET_KEY : clé live interdite en dev (mode test uniquement)."
  unset stripe_key
  # Chaque nom du dev commence par « dev. » ou « <nom>-dev. » (jamais un nom de la production).
  for key in APP_DOMAIN API_DOMAIN LANDING_DOMAIN; do
    host="$(env_get "$RAIJIN_ENV_FILE" "$key" | tr '[:upper:]' '[:lower:]')"
    [[ "$host" =~ ^(dev|[a-z0-9-]+-dev)\.[a-z0-9.-]+$ ]] || die "$key : nom du dev attendu (dev.… ou …-dev.…)."
  done
  # Réseau d'entrée (docs/DEPLOY.md C2) : RAIJIN_DEV_EDGE=traefik-shared (défaut, option B) → réseau du Traefik
  # existant, comme la prod, sans toucher au conteneur Traefik ; dedicated (option A) → réseau raijin-dev-… propre au
  # dev, que Traefik doit avoir rejoint (« docker network connect », décision de l'utilisateur).
  dev_edge="$(env_get "$RAIJIN_ENV_FILE" RAIJIN_DEV_EDGE)"; dev_edge="${dev_edge:-traefik-shared}"
  dev_net="$(env_get "$RAIJIN_ENV_FILE" TRAEFIK_NETWORK)"
  case "$dev_edge" in
    traefik-shared)
      [[ "$dev_net" != raijin* ]] \
        || die "TRAEFIK_NETWORK : avec RAIJIN_DEV_EDGE=traefik-shared, réseau du Traefik existant attendu (le même que la prod), jamais raijin-… (docs/DEPLOY.md C2)." ;;
    dedicated)
      [[ "$dev_net" == raijin-dev-* ]] \
        || die "TRAEFIK_NETWORK : avec RAIJIN_DEV_EDGE=dedicated, réseau propre au dev attendu (raijin-dev-edge, docs/DEPLOY.md C2)." ;;
    *) die "RAIJIN_DEV_EDGE : traefik-shared ou dedicated attendu (docs/DEPLOY.md C2)." ;;
  esac
  log "réseau d'entrée du dev : $dev_net (RAIJIN_DEV_EDGE=$dev_edge)."
  unset dev_edge dev_net
fi

TRAEFIK_NETWORK="$(env_get "$RAIJIN_ENV_FILE" TRAEFIK_NETWORK)"
docker network inspect "$TRAEFIK_NETWORK" >/dev/null 2>&1 \
  || die "réseau Traefik « $TRAEFIK_NETWORK » introuvable : vérifie le nom avec « docker network ls » (docs/DEPLOY.md A2)."
# Traefik doit être relié à ce réseau (option B : le réseau du Traefik existant ; option A : raijin-dev-edge connecté).
traefik_on_network "$TRAEFIK_NETWORK" \
  || die "aucun conteneur Traefik n'est relié au réseau « $TRAEFIK_NETWORK » (docs/DEPLOY.md A2, C2)."

if [[ "$bench" == 1 ]]; then
  [[ -d apps/raijin-banc-de-test-api ]] || die "--bench : apps/raijin-banc-de-test-api introuvable dans ce dépôt."
  [[ -n "$(env_get "$RAIJIN_ENV_FILE" BENCH_BASIC_AUTH_USERS)" ]] || die "--bench : BENCH_BASIC_AUTH_USERS est vide (docs/DEPLOY.md A14)."
  [[ -r "$RAIJIN_BENCH_API_ENV_FILE" ]] || die "--bench : fichier $RAIJIN_BENCH_API_ENV_FILE absent (modèle : docs/ENV.md, bloc « Banc »)."
  perms="$(stat -L -c '%a' "$RAIJIN_BENCH_API_ENV_FILE")"
  [[ "$perms" == 600 || "$perms" == 400 ]] || warn "$RAIJIN_BENCH_API_ENV_FILE est lisible par d'autres comptes (droits $perms) : chmod 600 $RAIJIN_BENCH_API_ENV_FILE"
  # Utilisateur Redis raijin-bench (ACL limitée à raijin-bench:*) : mot de passe propre, différent de celui de l'API.
  [[ "$(env_get "$RAIJIN_ENV_FILE" REDIS_BENCH_PASSWORD)" =~ ^[A-Za-z0-9_-]{24,}$ ]] \
    || die "--bench : REDIS_BENCH_PASSWORD doit faire au moins 24 caractères parmi A-Z a-z 0-9 _ - (openssl rand -hex 32)."
  [[ "$(env_get "$RAIJIN_ENV_FILE" REDIS_BENCH_PASSWORD)" != "$(env_get "$RAIJIN_ENV_FILE" REDIS_PASSWORD)" ]] \
    || die "--bench : REDIS_BENCH_PASSWORD doit être différent de REDIS_PASSWORD."
  [[ -n "$(env_get "$RAIJIN_BENCH_API_ENV_FILE" BENCH_OWNER_EMAIL)" ]] || die "--bench : BENCH_OWNER_EMAIL est vide dans $RAIJIN_BENCH_API_ENV_FILE."
  bench_mode="$(env_get "$RAIJIN_BENCH_API_ENV_FILE" BENCH_MODE)"
  [[ "$bench_mode" == shadow || "$bench_mode" == primary ]] || die "--bench : BENCH_MODE doit valoir shadow ou primary dans $RAIJIN_BENCH_API_ENV_FILE."
  log "banc : mode $bench_mode."
  export COMPOSE_PROFILES=bench
fi

avail_mb="$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)"
need_mb=$(( skip_build == 1 || rollback == 1 ? 1400 : 2600 ))
log "RAM disponible : ${avail_mb} Mo (conseillé pour cette opération : ${need_mb} Mo)."
if (( avail_mb < need_mb )); then
  warn "RAM disponible insuffisante : le build ou le démarrage pourrait ralentir les autres sites du VPS."
  confirm "Continuer quand même ?" || die "abandon."
fi
disk_free_gb="$(df -P --block-size=1G /var/lib/docker 2>/dev/null | awk 'NR==2 {print $4}')"
[[ -z "$disk_free_gb" ]] && disk_free_gb="$(df -P --block-size=1G / | awk 'NR==2 {print $4}')"
(( disk_free_gb >= 5 )) || { warn "moins de 5 Go libres sur le disque de Docker."; confirm "Continuer ?" || die "abandon."; }

# Variables PUBLIQUES du build de la landing (astro:env) : exportées pour l'interpolation de Compose. En dev, jamais de
# mesure d'audience ni de vérification Search Console (les visites de test fausseraient les chiffres de la prod).
APP_URL="https://$(env_get "$RAIJIN_ENV_FILE" APP_DOMAIN)"
GA4_MEASUREMENT_ID="$(env_get "$RAIJIN_ENV_FILE" GA4_MEASUREMENT_ID)"
GOOGLE_SITE_VERIFICATION="$(env_get "$RAIJIN_ENV_FILE" GOOGLE_SITE_VERIFICATION)"
[[ "$RAIJIN_ENV" == dev ]] && GA4_MEASUREMENT_ID='' GOOGLE_SITE_VERIFICATION=''
export APP_URL GA4_MEASUREMENT_ID GOOGLE_SITE_VERIFICATION
[[ -z "$GA4_MEASUREMENT_ID" || "$GA4_MEASUREMENT_ID" =~ ^G-[A-Z0-9]{4,20}$ ]] || die "GA4_MEASUREMENT_ID invalide (attendu : G-XXXXXXXXXX)."

compose config -q || die "fichiers Compose invalides avec ces variables."

services=(raijin-api raijin-web raijin-landing)
[[ "$RAIJIN_ENV" == dev ]] && services+=(raijin-mailpit)
[[ "$bench" == 1 ]] && services+=(raijin-bench-api raijin-bench-web)
images=(api web landing migrate)
[[ "$bench" == 1 ]] && images+=(bench-api bench-web bench-migrate)

# --- Retour arrière ---------------------------------------------------------------------------------
# Étiquettes : « deployed » = dernier déploiement RÉUSSI, « previous » = celui d'avant. Elles ne bougent qu'après
# un déploiement réussi : un déploiement raté ne remplace jamais la version de secours.
image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || true; }
if [[ "$rollback" == 1 ]]; then
  for img in "${images[@]}"; do
    latest="$(image_id "$RAIJIN_NAME/$img:latest")" deployed="$(image_id "$RAIJIN_NAME/$img:deployed")"
    if [[ -n "$deployed" && "$latest" != "$deployed" ]]; then
      # Le dernier déploiement a échoué : retour à la dernière version réussie.
      docker image tag "$RAIJIN_NAME/$img:deployed" "$RAIJIN_NAME/$img:latest"
      log "$RAIJIN_NAME/$img : dernière version déployée avec succès remise en service."
    elif [[ -n "$(image_id "$RAIJIN_NAME/$img:previous")" ]]; then
      docker image tag "$RAIJIN_NAME/$img:previous" "$RAIJIN_NAME/$img:latest"
      docker image tag "$RAIJIN_NAME/$img:previous" "$RAIJIN_NAME/$img:deployed"
      log "$RAIJIN_NAME/$img : version précédente remise en service."
    fi
  done
  warn "les migrations de base déjà appliquées NE sont PAS annulées (docs/DEPLOY.md A12)."
  compose up -d --wait --wait-timeout 240 --no-build "${services[@]}"
  log "retour arrière terminé."
  exit 0
fi

# --- 2. Build (ou images livrées) ----------------------------------------------------------------------
commit="$(git rev-parse --short HEAD)"
branch="$(git rev-parse --abbrev-ref HEAD)"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || warn "le dépôt a des modifications locales non commitées."
log "déploiement de $branch @ $commit"
log "landing : APP_URL=$APP_URL, GA4 $([[ -n "$GA4_MEASUREMENT_ID" ]] && echo activé || echo désactivé)."

if [[ "$skip_build" == 0 ]]; then
  # Un build à la fois : la RAM du VPS est partagée avec les autres sites.
  for svc in raijin-api raijin-web raijin-landing; do
    log "build de $svc…"
    compose build "$svc"
  done
  log "build de raijin-migrate…"
  compose --profile tools build raijin-migrate
  if [[ "$bench" == 1 ]]; then
    for svc in raijin-bench-api raijin-bench-web; do log "build de $svc…"; compose build "$svc"; done
    log "build de raijin-bench-migrate…"
    compose --profile tools build raijin-bench-migrate
  fi
  for img in "${images[@]}"; do
    docker image inspect "$RAIJIN_NAME/$img:latest" >/dev/null 2>&1 && docker image tag "$RAIJIN_NAME/$img:latest" "$RAIJIN_NAME/$img:$commit"
  done
fi

# --- 3. Base de données -------------------------------------------------------------------------------
log "démarrage de $RAIJIN_NAME-postgres et $RAIJIN_NAME-redis…"
compose up -d --wait --wait-timeout 120 --no-build raijin-postgres raijin-redis
log "bases et utilisateurs (idempotent)…"
docker exec -i "$RAIJIN_PG_CONTAINER" sh /docker-entrypoint-initdb.d/10-raijin-databases.sh

has_migrations() { [[ "$(pg_sql -d "$1" -c "SELECT to_regclass('public._prisma_migrations') IS NOT NULL;" 2>/dev/null || echo f)" == "t" ]]; }
if [[ "$RAIJIN_ENV" == prod ]] && { has_migrations raijin || { [[ "$bench" == 1 ]] && has_migrations raijin_bench; }; }; then
  # backup.sh sauvegarde raijin ET raijin_bench (si elle existe).
  log "sauvegarde avant migration…"
  "$RAIJIN_INFRA/backup.sh" --no-offsite || die "sauvegarde avant migration en échec : migration annulée."
elif [[ "$RAIJIN_ENV" == dev ]]; then
  log "dev : pas de sauvegarde avant migration (données de test)."
fi
log "migrations Prisma (migrate deploy)…"
# `run` ne construit pas une image déjà présente ; on vérifie qu'elle l'est pour ne jamais lancer de build ici.
docker image inspect "$RAIJIN_NAME/migrate:${RAIJIN_TAG:-latest}" >/dev/null 2>&1 \
  || die "image $RAIJIN_NAME/migrate absente : relance sans --skip-build."
compose --profile tools run --rm raijin-migrate
if [[ "$bench" == 1 ]]; then
  log "migrations Prisma du banc (raijin_bench, utilisateur raijin_bench)…"
  docker image inspect "$RAIJIN_NAME/bench-migrate:${RAIJIN_TAG:-latest}" >/dev/null 2>&1 \
    || die "image $RAIJIN_NAME/bench-migrate absente : relance sans --skip-build."
  compose --profile tools run --rm raijin-bench-migrate
fi

# --- 4. Démarrage -----------------------------------------------------------------------------------
log "démarrage de ${services[*]}…"
compose up -d --wait --wait-timeout 240 --no-build "${services[@]}"
compose ps

API_DOMAIN="$(env_get "$RAIJIN_ENV_FILE" API_DOMAIN)"
APP_DOMAIN="$(env_get "$RAIJIN_ENV_FILE" APP_DOMAIN)"
LANDING_DOMAIN="$(env_get "$RAIJIN_ENV_FILE" LANDING_DOMAIN)"

# --- 5. Contrôle de routage par Traefik (sans DNS ni certificat) ------------------------------------------
# Requêtes envoyées au Traefik local (RAIJIN_TRAEFIK_ADDR, 127.0.0.1:443 par défaut) avec le bon nom d'hôte : prouve
# que les routeurs et l'API répondent, même avant la propagation DNS ou l'émission du certificat (informatif ici).
traefik_addr="${RAIJIN_TRAEFIK_ADDR:-127.0.0.1:443}"
route_code() {
  curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$1:${traefik_addr##*:}:${traefik_addr%:*}" \
    "https://$1:${traefik_addr##*:}$2" 2>/dev/null || echo 000
}
route_failed=0
expect_route() {
  local host="$1" path="$2" want="$3" code=000
  for _ in $(seq 1 12); do
    code="$(route_code "$host" "$path")"
    [[ "$code" == "$want" ]] && break
    sleep 5
  done
  if [[ "$code" == "$want" ]]; then log "OK   routage $host$path → $code"; else warn "routage $host$path : $code ($want attendu)"; route_failed=1; fi
}
if [[ "$external" == 1 ]]; then
  expect_route "$API_DOMAIN" /api/v1/health 200
  if [[ "$RAIJIN_ENV" == dev ]]; then
    # Dev : tout est derrière la basicAuth (401 sans mot de passe), sauf robots.txt et la santé de l'API.
    expect_route "$APP_DOMAIN" / 401
    expect_route "$APP_DOMAIN" /robots.txt 200
    expect_route "$LANDING_DOMAIN" / 401
  else
    expect_route "$APP_DOMAIN" / 200
    expect_route "$APP_DOMAIN" /api/v1/health 200
    expect_route "$LANDING_DOMAIN" / 200
  fi
  if [[ "$route_failed" == 1 ]]; then
    warn "routage incomplet par le Traefik local ($traefik_addr) : vérifie TRAEFIK_NETWORK et les routeurs (A11)."
  fi
fi

# --- 6. Contrôles depuis l'extérieur (DNS, Traefik, TLS) : informatifs ---------------------------------------
if [[ "$external" == 1 ]]; then
  failed=0
  if [[ "$RAIJIN_ENV" == dev ]]; then
    urls=("https://$API_DOMAIN/api/v1/health")
  else
    urls=("https://$API_DOMAIN/api/v1/health" "https://$APP_DOMAIN/" "https://$LANDING_DOMAIN/" "https://$APP_DOMAIN/api/v1/health")
  fi
  for url in "${urls[@]}"; do
    code=000
    for _ in $(seq 1 12); do
      code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo 000)"
      [[ "$code" == 200 ]] && break
      sleep 5
    done
    if [[ "$code" == 200 ]]; then log "OK   $url"; else warn "$url répond $code"; failed=1; fi
  done
  if [[ "$RAIJIN_ENV" == prod ]]; then
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://www.$LANDING_DOMAIN/" 2>/dev/null || echo 000)"
    if [[ "$code" == 301 ]]; then
      log "OK   https://www.$LANDING_DOMAIN/ → 301"
    else
      warn "https://www.$LANDING_DOMAIN/ répond $code (301 attendu)"; failed=1
    fi
  else
    for url in "https://$APP_DOMAIN/" "https://$LANDING_DOMAIN/"; do
      code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo 000)"
      if [[ "$code" == 401 ]]; then log "OK   $url → 401 sans mot de passe"; else warn "$url répond $code (401 attendu sans basicAuth)"; failed=1; fi
    done
  fi
  if [[ "$bench" == 1 ]]; then
    # Double verrou : sans basicAuth, Traefik doit répondre 401 partout (front, API, robots.txt).
    BENCH_DOMAIN="$(env_get "$RAIJIN_ENV_FILE" BENCH_DOMAIN)"
    BENCH_DOMAIN="${BENCH_DOMAIN:-banc.raijinshield.com}"
    for url in "https://$BENCH_DOMAIN/" "https://$BENCH_DOMAIN/api/health"; do
      code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo 000)"
      if [[ "$code" == 401 ]]; then log "OK   $url → 401 sans mot de passe"; else warn "$url répond $code (401 attendu sans basicAuth)"; failed=1; fi
    done
  fi
  [[ "$failed" == 0 ]] || warn "certains contrôles extérieurs échouent : DNS pas encore propagé, certificat en cours d'émission, ou routeur Traefik (docs/DEPLOY.md A11)."
fi

# Succès : l'ancienne version réussie devient « previous », la nouvelle « deployed ».
for img in "${images[@]}"; do
  [[ -n "$(image_id "$RAIJIN_NAME/$img:latest")" ]] || continue
  if [[ -n "$(image_id "$RAIJIN_NAME/$img:deployed")" && "$(image_id "$RAIJIN_NAME/$img:deployed")" != "$(image_id "$RAIJIN_NAME/$img:latest")" ]]; then
    docker image tag "$RAIJIN_NAME/$img:deployed" "$RAIJIN_NAME/$img:previous"
  fi
  docker image tag "$RAIJIN_NAME/$img:latest" "$RAIJIN_NAME/$img:deployed"
done
history_dir="${XDG_STATE_HOME:-$HOME/.local/state}/raijin"
mkdir -p "$history_dir"
printf '%s %s %s@%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$RAIJIN_ENV" "$branch" "$commit" >>"$history_dir/deploy-history"
log "déploiement terminé ($RAIJIN_ENV, $commit). Retour arrière : infra/deploy.sh --env $RAIJIN_ENV --rollback"
