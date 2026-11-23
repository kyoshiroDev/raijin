#!/usr/bin/env bash
# =====================================================================================================
# Déploiement de Raijin sur le VPS (PROMPT.md §7) — lancé UNIQUEMENT par l'utilisateur, depuis la racine
# du dépôt cloné sur le VPS (docs/DEPLOY.md, partie A). Jamais par un agent.
#
#   infra/deploy.sh                 build + migrations + démarrage + contrôles
#   infra/deploy.sh --skip-build    redémarre sur les images déjà construites (migrations comprises)
#   infra/deploy.sh --rollback      revient aux images du déploiement précédent (sans build ni migration)
#   infra/deploy.sh --bench         inclut le banc (profil « bench », phase 8 bis seulement)
#   Options : --yes (pas de question), --no-external-check (pas de contrôle HTTPS depuis l'extérieur)
#
# Garanties : aucun `docker compose down`, aucune suppression de volume, d'image ou de réseau, aucune
# commande sur un conteneur qui n'est pas « raijin-… ». Le réseau Traefik existant est seulement lu.
# Une sauvegarde locale est faite avant chaque migration.
# =====================================================================================================
set -Eeuo pipefail
RAIJIN_SCRIPT=deploy
# shellcheck source=infra/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

skip_build=0 rollback=0 bench=0 assume_yes=0 external=1
for arg in "$@"; do
  case "$arg" in
    --skip-build) skip_build=1 ;;
    --rollback) rollback=1 ;;
    --bench) bench=1 ;;
    --yes) assume_yes=1 ;;
    --no-external-check) external=0 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "option inconnue : $arg" ;;
  esac
done

trap "warn \"déploiement interrompu (ligne \$LINENO). Rien n'a été supprimé ; voir docs/DEPLOY.md A12 (retour arrière).\"" ERR

confirm() {
  [[ "$assume_yes" == 1 ]] && return 0
  local answer
  read -r -p "$1 [o/N] " answer
  [[ "$answer" == o || "$answer" == O || "$answer" == oui ]]
}

cd "$RAIJIN_ROOT"
require_cmd docker git curl awk grep

# --- 1. Prérequis ---------------------------------------------------------------------------------------
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 manquant (docs/DEPLOY.md A1)."
compose_version="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
if [[ "$(printf '%s\n2.24.0\n' "$compose_version" | sort -V | head -n1)" != "2.24.0" ]]; then
  die "Docker Compose $compose_version trop ancien (2.24 minimum)."
fi
[[ -r "$RAIJIN_ENV_FILE" ]] || die "fichier $RAIJIN_ENV_FILE absent (modèle : docs/ENV.md, bloc « Production (VPS) »)."
[[ -r "$RAIJIN_API_ENV_FILE" ]] || die "fichier $RAIJIN_API_ENV_FILE absent (modèle : docs/ENV.md)."
for f in "$RAIJIN_ENV_FILE" "$RAIJIN_API_ENV_FILE"; do
  perms="$(stat -c '%a' "$f")"
  [[ "$perms" == 600 || "$perms" == 400 ]] || warn "$f est lisible par d'autres comptes (droits $perms) : chmod 600 $f"
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

TRAEFIK_NETWORK="$(env_get "$RAIJIN_ENV_FILE" TRAEFIK_NETWORK)"
docker network inspect "$TRAEFIK_NETWORK" >/dev/null 2>&1 \
  || die "réseau Traefik « $TRAEFIK_NETWORK » introuvable : vérifie le nom avec « docker network ls » (docs/DEPLOY.md A2)."

if [[ "$bench" == 1 ]]; then
  [[ -d apps/raijin-banc-de-test-api ]] || die "--bench : apps/raijin-banc-de-test-api n'existe pas encore (phase 8 bis)."
  [[ -n "$(env_get "$RAIJIN_ENV_FILE" BENCH_BASIC_AUTH_USERS)" ]] || die "--bench : BENCH_BASIC_AUTH_USERS est vide (docs/DEPLOY.md A5)."
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

compose config -q || die "infra/docker-compose.yml invalide avec ces variables."

services=(raijin-api raijin-web raijin-landing)
[[ "$bench" == 1 ]] && services+=(raijin-bench-api raijin-bench-web)
images=(api web landing migrate)
[[ "$bench" == 1 ]] && images+=(bench-api bench-web)

# --- Retour arrière ---------------------------------------------------------------------------------
if [[ "$rollback" == 1 ]]; then
  for img in "${images[@]}"; do
    if docker image inspect "raijin/$img:previous" >/dev/null 2>&1; then
      docker image tag "raijin/$img:previous" "raijin/$img:latest"
      log "raijin/$img : image précédente remise en service."
    fi
  done
  warn "les migrations de base déjà appliquées NE sont PAS annulées (docs/DEPLOY.md A12)."
  compose up -d --wait --wait-timeout 240 --no-build "${services[@]}"
  log "retour arrière terminé."
  exit 0
fi

# --- 2. Build ---------------------------------------------------------------------------------------
commit="$(git rev-parse --short HEAD)"
branch="$(git rev-parse --abbrev-ref HEAD)"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || warn "le dépôt a des modifications locales non commitées."
log "déploiement de $branch @ $commit"

# Variables PUBLIQUES du build de la landing (astro:env) : exportées pour l'interpolation de Compose.
APP_URL="https://$(env_get "$RAIJIN_ENV_FILE" APP_DOMAIN)"
GA4_MEASUREMENT_ID="$(env_get "$RAIJIN_ENV_FILE" GA4_MEASUREMENT_ID)"
GOOGLE_SITE_VERIFICATION="$(env_get "$RAIJIN_ENV_FILE" GOOGLE_SITE_VERIFICATION)"
export APP_URL GA4_MEASUREMENT_ID GOOGLE_SITE_VERIFICATION
[[ -z "$GA4_MEASUREMENT_ID" || "$GA4_MEASUREMENT_ID" =~ ^G-[A-Z0-9]{4,20}$ ]] || die "GA4_MEASUREMENT_ID invalide (attendu : G-XXXXXXXXXX)."
log "landing : APP_URL=$APP_URL, GA4 $([[ -n "$GA4_MEASUREMENT_ID" ]] && echo activé || echo désactivé)."

if [[ "$skip_build" == 0 ]]; then
  # Les images actuelles deviennent « previous » (retour arrière en une commande).
  for img in "${images[@]}"; do
    docker image inspect "raijin/$img:latest" >/dev/null 2>&1 && docker image tag "raijin/$img:latest" "raijin/$img:previous"
  done
  # Un build à la fois : la RAM du VPS est partagée avec les autres sites.
  for svc in raijin-api raijin-web raijin-landing; do
    log "build de $svc…"
    compose build "$svc"
  done
  log "build de raijin-migrate…"
  compose --profile tools build raijin-migrate
  if [[ "$bench" == 1 ]]; then
    for svc in raijin-bench-api raijin-bench-web; do log "build de $svc…"; compose build "$svc"; done
  fi
  for img in "${images[@]}"; do
    docker image inspect "raijin/$img:latest" >/dev/null 2>&1 && docker image tag "raijin/$img:latest" "raijin/$img:$commit"
  done
fi

# --- 3. Base de données -------------------------------------------------------------------------------
log "démarrage de raijin-postgres et raijin-redis…"
compose up -d --wait --wait-timeout 120 --no-build raijin-postgres raijin-redis
log "bases et utilisateurs (idempotent)…"
docker exec -i raijin-postgres sh /docker-entrypoint-initdb.d/10-raijin-databases.sh

if [[ "$(pg_sql -d raijin -c "SELECT to_regclass('public._prisma_migrations') IS NOT NULL;" 2>/dev/null || echo f)" == "t" ]]; then
  log "sauvegarde avant migration…"
  "$RAIJIN_INFRA/backup.sh" --no-offsite || die "sauvegarde avant migration en échec : migration annulée."
fi
log "migrations Prisma (migrate deploy)…"
compose --profile tools run --rm --no-build raijin-migrate

# --- 4. Démarrage -----------------------------------------------------------------------------------
log "démarrage de ${services[*]}…"
compose up -d --wait --wait-timeout 240 --no-build "${services[@]}"
compose ps

# --- 5. Contrôles depuis l'extérieur (DNS, Traefik, TLS) ----------------------------------------------
if [[ "$external" == 1 ]]; then
  API_DOMAIN="$(env_get "$RAIJIN_ENV_FILE" API_DOMAIN)"
  APP_DOMAIN="$(env_get "$RAIJIN_ENV_FILE" APP_DOMAIN)"
  LANDING_DOMAIN="$(env_get "$RAIJIN_ENV_FILE" LANDING_DOMAIN)"
  failed=0
  for url in "https://$API_DOMAIN/api/v1/health" "https://$APP_DOMAIN/" "https://$LANDING_DOMAIN/" "https://$APP_DOMAIN/api/v1/health"; do
    code=000
    for _ in $(seq 1 12); do
      code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo 000)"
      [[ "$code" == 200 ]] && break
      sleep 5
    done
    if [[ "$code" == 200 ]]; then log "OK   $url"; else warn "$url répond $code"; failed=1; fi
  done
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://www.$LANDING_DOMAIN/" 2>/dev/null || echo 000)"
  if [[ "$code" == 301 ]]; then
    log "OK   https://www.$LANDING_DOMAIN/ → 301"
  else
    warn "https://www.$LANDING_DOMAIN/ répond $code (301 attendu)"; failed=1
  fi
  [[ "$failed" == 0 ]] || warn "certains contrôles extérieurs échouent : DNS pas encore propagé, certificat en cours d'émission, ou routeur Traefik (docs/DEPLOY.md A11)."
fi

history_dir="${XDG_STATE_HOME:-$HOME/.local/state}/raijin"
mkdir -p "$history_dir"
printf '%s %s@%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$branch" "$commit" >>"$history_dir/deploy-history"
log "déploiement terminé ($commit). Retour arrière : infra/deploy.sh --rollback"
