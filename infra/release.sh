#!/usr/bin/env bash
# =====================================================================================================
# Mise en service d'une version livrée (déploiement continu, docs/DEPLOY.md partie C). Copie FIGÉE dans
# /opt/raijin-deploy/infra/ (root), lancée EN ROOT par infra/docker-priv.sh (sudo depuis deploy-dev / deploy-prod),
# sur une version importée dans /var/lib/raijin-deploy/<env>/releases/ (copie racine, hors de portée de l'utilisateur). N'utilise QUE la configuration résolue de la version (<version>/compose.resolved.json, produite et
# contrôlée par la porte) : aucune interpolation, environnement vidé (env -i), politique rejouée avant chaque up / run,
# `--pull never` et `--no-build` partout.
#
#   release.sh deploy  <env> <dossier de version>   bases, migrations Prisma (migrate deploy), démarrage, santé, routage
#   release.sh recover <env> <dossier de version>   remet en service cette version (retour arrière), sans migration
#
# Jamais : docker compose down, suppression de volume ou de réseau, prisma migrate reset, conteneur hors raijin-….
# =====================================================================================================
set -Eeuo pipefail
RAIJIN_SCRIPT=release
mode="${1:-}" env="${2:-}" rel="${3:-}"
[[ "$mode" == deploy || "$mode" == recover ]] || { echo "usage : release.sh deploy|recover <env> <dossier>" >&2; exit 2; }
[[ "$env" == dev || "$env" == prod ]] || { echo "release.sh : environnement dev ou prod." >&2; exit 2; }
rel="$(cd "$rel" && pwd)"
RAIJIN_ENV="$env"
# Lancé depuis une session SSH (par la porte) : seules les valeurs figées comptent, sauf tests de la CI (comme la porte).
if [[ -n "${SSH_ORIGINAL_COMMAND+x}" ]] && ! [[ "${GITHUB_ACTIONS:-}" == true && "${RAIJIN_GATE_TEST:-}" == 1 && -z "${SSH_CONNECTION:-}" ]]; then
  unset RAIJIN_DEPLOY_BASE RAIJIN_PRIV_BASE RAIJIN_TRAEFIK_ADDR RAIJIN_ENV_FILE RAIJIN_API_ENV_FILE RAIJIN_BENCH_API_ENV_FILE RAIJIN_PG_CONTAINER RAIJIN_COMPOSE_DIR
fi
DEPLOY_BASE="${RAIJIN_DEPLOY_BASE:-/srv/raijin}"
base="$DEPLOY_BASE/$env"
# Zone racine (versions importées, scripts d'init, historique) : /var/lib/raijin-deploy/<env> (docker-priv.sh).
pbase="${RAIJIN_PRIV_BASE:-/var/lib/raijin-deploy}/$env"
for f in "$base/env/.env" "$base/env/.env.api" "$base/env/.env.bench-api"; do
  [[ ! -L "$f" ]] || { echo "release.sh : $f est un lien symbolique : refusé." >&2; exit 2; }
done
RAIJIN_ENV_FILE="$base/env/.env" RAIJIN_API_ENV_FILE="$base/env/.env.api" RAIJIN_BENCH_API_ENV_FILE="$base/env/.env.bench-api"
# shellcheck source=infra/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
POLICY="$(dirname "${BASH_SOURCE[0]}")/lib/deploy_policy.py"

resolved="$rel/compose.resolved.json"
[[ -f "$resolved" && ! -L "$resolved" ]] || die "$resolved absent."
tag="$(cat "$rel/SHA")"
[[ "$tag" =~ ^[0-9a-f]{40}$ ]] || die "$rel/SHA invalide."
[[ -r "$RAIJIN_ENV_FILE" ]] || die "$RAIJIN_ENV_FILE absent."

TRAEFIK_NETWORK="$(env_get "$RAIJIN_ENV_FILE" TRAEFIK_NETWORK)"
ENTRYPOINT="$(env_get "$RAIJIN_ENV_FILE" TRAEFIK_ENTRYPOINT)"; ENTRYPOINT="${ENTRYPOINT:-websecure}"
CERTRESOLVER="$(env_get "$RAIJIN_ENV_FILE" TRAEFIK_CERTRESOLVER)"
APP_DOMAIN="$(env_get "$RAIJIN_ENV_FILE" APP_DOMAIN)"
API_DOMAIN="$(env_get "$RAIJIN_ENV_FILE" API_DOMAIN)"
LANDING_DOMAIN="$(env_get "$RAIJIN_ENV_FILE" LANDING_DOMAIN)"
hosts="$APP_DOMAIN,$API_DOMAIN,$LANDING_DOMAIN"
EDGE=()
[[ "$env" == dev ]] && EDGE=(--edge "$(env_get "$RAIJIN_ENV_FILE" RAIJIN_DEV_EDGE)")
if [[ "$env" == prod ]]; then
  bench_domain="$(env_get "$RAIJIN_ENV_FILE" BENCH_DOMAIN)"
  hosts+=",www.$LANDING_DOMAIN,${bench_domain:-banc.raijinshield.com}"
fi
CLEAN_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Politique complète sur la configuration résolue (rejouée avant chaque up / run).
check() {
  python3 "$POLICY" compose "$resolved" --name "$RAIJIN_NAME" --root "$pbase/infra-stable" --network "$TRAEFIK_NETWORK" \
    --entrypoint "$ENTRYPOINT" --certresolver "$CERTRESOLVER" --tag "$tag" --hosts "$hosts" "${EDGE[@]}" >/dev/null \
    || die "configuration résolue refusée par la politique : arrêt sans démarrer."
}
# docker compose sur la SEULE configuration résolue, environnement vidé, sans fichier .env.
rc() {
  env -i PATH="$CLEAN_PATH" HOME="$HOME" docker compose --project-name "$RAIJIN_PROJECT" --env-file /dev/null \
    --project-directory "$pbase/infra-stable" -f "$resolved" "$@"
}

docker compose run --help 2>/dev/null | grep -q -- '--pull' || die "docker compose run --pull absent : mets Docker Compose à jour (2.24 minimum, A1)."
docker network inspect "$TRAEFIK_NETWORK" >/dev/null 2>&1 || die "réseau d'entrée « $TRAEFIK_NETWORK » introuvable (docs/DEPLOY.md C2)."

check
# Images tierces (officielles, épinglées par empreinte) : téléchargées ici, puisque up / run ne téléchargent jamais.
while read -r img; do
  docker image inspect "$img" >/dev/null 2>&1 || docker pull -q "$img" >/dev/null
done < <(python3 "$POLICY" thirdparty "$resolved")

services=(raijin-api raijin-web raijin-landing)
[[ "$env" == dev ]] && services+=(raijin-mailpit)
bench=0
if [[ "$env" == prod && -r "$RAIJIN_BENCH_API_ENV_FILE" ]] && docker image inspect "raijin/bench-api:$tag" >/dev/null 2>&1; then
  bench=1
  services+=(raijin-bench-api raijin-bench-web)
fi
images=(api web landing migrate)
[[ "$bench" == 1 ]] && images+=(bench-api bench-web bench-migrate)
for img in "${images[@]}"; do
  docker image inspect "$RAIJIN_NAME/$img:$tag" >/dev/null 2>&1 || die "image $RAIJIN_NAME/$img:$tag absente."
done
profiles=(--profile tools)
[[ "$bench" == 1 ]] && profiles+=(--profile bench)

# Contrôle de routage par le Traefik local (RAIJIN_TRAEFIK_ADDR, 127.0.0.1:443 par défaut), avec attente : Traefik
# met quelques secondes à prendre en compte un conteneur recréé. Utilisé après un déploiement ET après un retour.
traefik_addr="${RAIJIN_TRAEFIK_ADDR:-127.0.0.1:443}"
expect_route() {
  local host="$1" path="$2" want="$3" code=000
  for _ in $(seq 1 12); do
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$host:${traefik_addr##*:}:${traefik_addr%:*}" \
      "https://$host:${traefik_addr##*:}$path" 2>/dev/null || echo 000)"
    [[ "$code" == "$want" ]] && break
    sleep 5
  done
  if [[ "$code" == "$want" ]]; then log "OK   routage $host$path → $code"; return 0; fi
  warn "routage $host$path : $code ($want attendu)"
  return 1
}
check_routes() {
  local failed=0
  expect_route "$API_DOMAIN" /api/v1/health 200 || failed=1
  if [[ "$env" == dev ]]; then
    expect_route "$APP_DOMAIN" / 401 || failed=1
    expect_route "$APP_DOMAIN" /robots.txt 200 || failed=1
    expect_route "$LANDING_DOMAIN" / 401 || failed=1
  else
    expect_route "$APP_DOMAIN" / 200 || failed=1
    expect_route "$APP_DOMAIN" /api/v1/health 200 || failed=1
    expect_route "$LANDING_DOMAIN" / 200 || failed=1
  fi
  return "$failed"
}

if [[ "$mode" == recover ]]; then
  log "retour à la version ${tag:0:12} ($env)…"
  rc "${profiles[@]}" up -d --wait --wait-timeout 240 --pull never --no-build "${services[@]}"
  check_routes || die "version ${tag:0:12} redémarrée mais routage Traefik incomplet (docs/DEPLOY.md C2, C7)."
  log "version ${tag:0:12} remise en service. Les migrations déjà appliquées restent en place (docs/DEPLOY.md A12)."
  exit 0
fi

# --- Bases --------------------------------------------------------------------------------------------
log "démarrage de $RAIJIN_NAME-postgres et $RAIJIN_NAME-redis…"
rc up -d --wait --wait-timeout 120 --pull never --no-build raijin-postgres raijin-redis
docker exec -i "$RAIJIN_PG_CONTAINER" sh /docker-entrypoint-initdb.d/10-raijin-databases.sh
has_migrations() { [[ "$(pg_sql -d "$1" -c "SELECT to_regclass('public._prisma_migrations') IS NOT NULL;" 2>/dev/null || echo f)" == "t" ]]; }
if [[ "$env" == prod ]] && { has_migrations raijin || { [[ "$bench" == 1 ]] && has_migrations raijin_bench; }; }; then
  log "sauvegarde avant migration…"
  "$(dirname "${BASH_SOURCE[0]}")/backup.sh" --no-offsite || die "sauvegarde avant migration en échec : migration annulée."
fi

# --- Migrations ---------------------------------------------------------------------------------------
check
log "migrations Prisma (migrate deploy)…"
rc "${profiles[@]}" run --rm --pull never raijin-migrate
if [[ "$bench" == 1 ]]; then
  check
  rc "${profiles[@]}" run --rm --pull never raijin-bench-migrate
fi

# --- Démarrage ----------------------------------------------------------------------------------------
check
log "démarrage de ${services[*]}…"
rc "${profiles[@]}" up -d --wait --wait-timeout 240 --pull never --no-build "${services[@]}"

# --- Contrôle de routage par le Traefik local (bloquant) --------------------------------------------------
check_routes || die "contrôle de routage en échec : version refusée."

# Succès : étiquettes de secours (compatibles avec infra/deploy.sh --rollback) et historique.
for img in "${images[@]}"; do
  if docker image inspect "$RAIJIN_NAME/$img:deployed" >/dev/null 2>&1; then
    docker image tag "$RAIJIN_NAME/$img:deployed" "$RAIJIN_NAME/$img:previous"
  fi
  docker image tag "$RAIJIN_NAME/$img:$tag" "$RAIJIN_NAME/$img:deployed"
done
mkdir -p "$pbase/state/raijin"
printf '%s %s livraison@%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$env" "$tag" >>"$pbase/state/raijin/deploy-history"
log "version ${tag:0:12} en service ($env)."
