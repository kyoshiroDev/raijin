#!/usr/bin/env bash
# Fonctions communes des scripts d'infra Raijin (deploy, backup, restore, watchdog). Sourcé, jamais exécuté.
# Règles : aucun secret affiché ni journalisé ; aucune commande sur des conteneurs, volumes ou réseaux qui
# ne sont pas à Raijin (tout est filtré par le projet Compose « raijin » / « raijin-dev » ou par un nom « raijin-… »).

# Racine du dépôt (dossier parent de infra/) : celle des SCRIPTS. En déploiement continu, ce sont les copies figées
# de /opt/raijin-deploy (root), et les fichiers Compose viennent de la version livrée (RAIJIN_COMPOSE_DIR).
RAIJIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RAIJIN_INFRA="$RAIJIN_ROOT/infra"

# Environnement (docs/DEPLOY.md, partie C) : « prod » (projet Compose raijin, défaut) ou « dev » (projet raijin-dev,
# surcouche docker-compose.env-dev.yml). Aucun nom commun entre les deux : RAIJIN_NAME préfixe conteneurs, images,
# routeurs Traefik, réseau interne et volumes.
RAIJIN_ENV="${RAIJIN_ENV:-prod}"
case "$RAIJIN_ENV" in
  prod) RAIJIN_PROJECT=raijin; raijin_env_suffix='' ;;
  dev) RAIJIN_PROJECT=raijin-dev; raijin_env_suffix='.dev' ;;
  *) printf 'RAIJIN_ENV invalide : « %s » (prod ou dev)\n' "$RAIJIN_ENV" >&2; exit 1 ;;
esac
RAIJIN_NAME="$RAIJIN_PROJECT"
RAIJIN_COMPOSE_DIR="${RAIJIN_COMPOSE_DIR:-$RAIJIN_INFRA}"
RAIJIN_COMPOSE_FILE="$RAIJIN_COMPOSE_DIR/docker-compose.yml"
RAIJIN_COMPOSE_DEV_FILE="$RAIJIN_COMPOSE_DIR/docker-compose.env-dev.yml"
# Fichiers de variables : infra/.env et infra/.env.api (prod), infra/.env.dev et infra/.env.dev.api (dev) dans un
# dépôt cloné ; chemins imposés par deploy-gate.sh en déploiement continu (/srv/raijin/<env>/env/).
RAIJIN_ENV_FILE="${RAIJIN_ENV_FILE:-$RAIJIN_INFRA/.env$raijin_env_suffix}"
RAIJIN_API_ENV_FILE="${RAIJIN_API_ENV_FILE:-$RAIJIN_INFRA/.env$raijin_env_suffix.api}"
RAIJIN_BENCH_API_ENV_FILE="${RAIJIN_BENCH_API_ENV_FILE:-$RAIJIN_INFRA/.env.bench-api}"
RAIJIN_PG_CONTAINER="${RAIJIN_PG_CONTAINER:-$RAIJIN_NAME-postgres}"
# Lus par l'interpolation de Compose (l'environnement l'emporte sur --env-file) et par les scripts appelés.
export RAIJIN_ENV RAIJIN_NAME RAIJIN_ENV_FILE RAIJIN_API_ENV_FILE RAIJIN_BENCH_API_ENV_FILE

log() { printf '%s [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${RAIJIN_SCRIPT:-raijin}" "$*"; }
warn() { log "ATTENTION : $*" >&2; }
die() { log "ERREUR : $*" >&2; exit 1; }

# Lit UNE variable d'un fichier .env sans l'exécuter (pas de `source` : aucune substitution, aucun code).
# Accepte KEY=valeur, KEY="valeur", KEY='valeur' ; la dernière occurrence l'emporte. Vide si absente.
env_get() {
  local file="$1" key="$2" line value
  [[ -r "$file" ]] || { printf ''; return 0; }
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" | tail -n 1 || true)"
  [[ -n "$line" ]] || { printf ''; return 0; }
  value="${line#*=}"
  # Commentaire en fin de ligne seulement pour une valeur non entre guillemets.
  if [[ "$value" =~ ^\"(.*)\"[[:space:]]*(#.*)?$ ]]; then
    value="${BASH_REMATCH[1]}"
  elif [[ "$value" =~ ^\'(.*)\'[[:space:]]*(#.*)?$ ]]; then
    value="${BASH_REMATCH[1]}"
  else
    value="${value%%[[:space:]]#*}"
    value="${value%"${value##*[![:space:]]}"}"
  fi
  printf '%s' "$value"
}

# docker compose du projet de l'environnement (raijin ou raijin-dev, jamais un autre projet).
compose() {
  local files=(-f "$RAIJIN_COMPOSE_FILE")
  [[ "$RAIJIN_ENV" == dev ]] && files+=(-f "$RAIJIN_COMPOSE_DEV_FILE")
  docker compose --project-name "$RAIJIN_PROJECT" --env-file "$RAIJIN_ENV_FILE" "${files[@]}" "$@"
}

require_cmd() {
  local c
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || die "commande « $c » introuvable (voir docs/DEPLOY.md, prérequis)."; done
}

# Le conteneur Postgres de Raijin doit exister, s'appeler raijin-… et tourner.
require_pg_container() {
  [[ "$RAIJIN_PG_CONTAINER" == raijin-* ]] || die "conteneur Postgres refusé : « $RAIJIN_PG_CONTAINER » (seuls les conteneurs raijin-… sont autorisés)."
  [[ "$(docker inspect -f '{{.State.Running}}' "$RAIJIN_PG_CONTAINER" 2>/dev/null || true)" == "true" ]] \
    || die "le conteneur $RAIJIN_PG_CONTAINER ne tourne pas."
}

# psql / pg_dump / pg_restore dans le conteneur Postgres (socket local, superutilisateur postgres).
pg_exec() { docker exec -i "$RAIJIN_PG_CONTAINER" "$@"; }
pg_sql() { pg_exec psql -v ON_ERROR_STOP=1 --no-psqlrc -X -q -t -A -U postgres "$@"; }
# Vrai/faux seulement sur une réponse certaine (« 1 » / « 0 ») ; toute autre réponse (erreur passagère, conteneur
# injoignable) arrête le script AVANT toute modification : une erreur ne doit jamais être lue comme « base absente ».
pg_db_exists() {
  local n
  n="$(pg_sql -d postgres -c "SELECT count(*) FROM pg_database WHERE datname = '$1'" 2>/dev/null)" || n="erreur"
  # Tests seulement (infra/ci/test-restore.sh) : erreur simulée.
  [[ "${RAIJIN_TEST_FAULT:-}" == "db_exists:$1" ]] && n="erreur"
  case "$n" in
    1) return 0 ;;
    0) return 1 ;;
    *) die "impossible de savoir si la base $1 existe (réponse : $n) : arrêt sans rien modifier." ;;
  esac
}

# ---------------------------------------------------------------------------------------------------
# Alertes (watchdog, backup) : e-mail via l'API HTTP de Resend (indépendant de l'API Raijin, qui peut être
# tombée), puis push aux admins via la CLI de l'API (si l'image et la base répondent).
# La clé Resend est lue dans infra/.env.api et passée à curl par un fichier de configuration temporaire
# (jamais sur la ligne de commande, donc invisible dans `ps`).
# ---------------------------------------------------------------------------------------------------
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\r'/}"; s="${s//$'\t'/ }"
  printf '%s' "$s"
}

send_alert_email() {
  local subject="$1" body="$2" key to from cfg payload code
  key="$(env_get "$RAIJIN_API_ENV_FILE" RESEND_API_KEY)"
  to="$(env_get "$RAIJIN_ENV_FILE" WATCHDOG_ALERT_EMAIL)"
  from="$(env_get "$RAIJIN_API_ENV_FILE" MAIL_FROM)"
  from="${from:-Raijin <noreply@raijinshield.com>}"
  if [[ -z "$to" ]]; then warn "WATCHDOG_ALERT_EMAIL vide : pas d'e-mail d'alerte."; return 1; fi
  if [[ -z "$key" || "$key" != re_* || "$key" == *factice* ]]; then warn "RESEND_API_KEY absente ou factice : pas d'e-mail d'alerte."; return 1; fi
  require_cmd curl
  cfg="$(mktemp)"; payload="$(mktemp)"
  chmod 600 "$cfg" "$payload"
  printf 'header = "Authorization: Bearer %s"\n' "$key" >"$cfg"
  printf '{"from":"%s","to":["%s"],"subject":"%s","text":"%s"}' \
    "$(json_escape "$from")" "$(json_escape "$to")" "$(json_escape "$subject")" "$(json_escape "$body")" >"$payload"
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 --config "$cfg" \
    -H 'Content-Type: application/json' --data-binary @"$payload" https://api.resend.com/emails || true)"
  rm -f "$cfg" "$payload"
  if [[ "$code" == 2* ]]; then log "alerte envoyée par e-mail."; return 0; fi
  warn "envoi de l'e-mail d'alerte refusé (HTTP $code)."
  return 1
}

# Push aux comptes ADMIN (et e-mail via l'API) par la CLI de l'image raijin/api : commande `notify-admins`
# (à fournir par nestjs-api, phase 8). Sans effet si la commande n'existe pas encore ou si la base est tombée.
send_alert_push() {
  local subject="$1" body="$2"
  docker ps --format '{{.Names}}' | grep -qx raijin-api || return 1
  docker exec -i raijin-api node dist/apps/api/cli.js notify-admins --title="$subject" --stdin >/dev/null 2>&1 <<<"$body" \
    && { log "alerte envoyée en push aux admins."; return 0; }
  return 1
}

send_alert() {
  local subject="$1" body="$2" ok=1
  if [[ "${RAIJIN_NO_ALERT:-0}" == 1 ]]; then log "alerte non envoyée (RAIJIN_NO_ALERT=1) : $subject"; return 0; fi
  send_alert_email "$subject" "$body" && ok=0
  send_alert_push "$subject" "$body" && ok=0
  return "$ok"
}
