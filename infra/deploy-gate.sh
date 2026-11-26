#!/usr/bin/env bash
# =====================================================================================================
# Porte d'entrée du déploiement continu (docs/DEPLOY.md, partie C). Installée par l'utilisateur, FIGÉE et
# propriété de root dans /opt/raijin-deploy/infra/ (avec lib/common.sh, lib/deploy_policy.py, deploy.sh, backup.sh),
# et lancée UNIQUEMENT comme commande forcée de la clé SSH de GitHub Actions (~deploy/.ssh/authorized_keys) :
#
#   command="/opt/raijin-deploy/infra/deploy-gate.sh dev",restrict ssh-ed25519 AAAA… github-deploy-dev
#   command="/opt/raijin-deploy/infra/deploy-gate.sh prod",restrict ssh-ed25519 AAAA… github-deploy-prod
#
# L'environnement est fixé par la clé (une clé par environnement) ; la commande demandée par le client
# (SSH_ORIGINAL_COMMAND) ne peut être que :
#   deploy <env> <commit>   livraison sur l'entrée standard (archive : images.tar.gz + infra/), puis déploiement
#   status <env>            derniers déploiements (lecture seule)
#
# Étapes de « deploy » : verrou global (un déploiement à la fois sur le VPS, dev et prod confondus) → réception
# bornée → contrôles (deploy_policy.py : archive, étiquettes d'images, configuration Compose) → `docker load` →
# infra/deploy.sh FIGÉ (--release) → si échec : retour automatique à la dernière version réussie (--recover).
# Le déploiement continue même si la connexion SSH tombe (journal dans /srv/raijin/<env>/logs/).
# Jamais : docker compose down, suppression de volume ou de réseau, prisma migrate reset, commande hors raijin-….
# =====================================================================================================
set -Eeuo pipefail
umask 027
RAIJIN_SCRIPT=deploy-gate

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_BASE="${RAIJIN_DEPLOY_BASE:-/srv/raijin}"
MAX_BUNDLE_BYTES="${RAIJIN_MAX_BUNDLE_BYTES:-4294967296}"
KEEP_RELEASES=5

say() { printf '%s [deploy-gate] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
refuse() { say "REFUS : $*" >&2; exit 2; }

# --- Mode interne : exécution détachée de la session SSH (appelé par ce script seulement) -------------------
if [[ "${1:-}" == --run ]]; then
  env="$2" sha="$3" rel="$4" status_file="$5"
  # Une coupure SSH ne doit jamais interrompre une migration : signaux de fin de session ignorés.
  trap '' HUP PIPE
  base="$DEPLOY_BASE/$env"
  export RAIJIN_ENV_FILE="$base/env/.env" RAIJIN_API_ENV_FILE="$base/env/.env.api"
  export RAIJIN_BENCH_API_ENV_FILE="$base/env/.env.bench-api" XDG_STATE_HOME="$base/state"
  name=raijin; [[ "$env" == dev ]] && name=raijin-dev
  bench=()
  if [[ "$env" == prod && -r "$RAIJIN_BENCH_API_ENV_FILE" ]] && docker image inspect "$name/bench-api:$sha" >/dev/null 2>&1; then
    bench=(--bench)
  fi
  previous=''
  [[ -L "$base/current" ]] && previous="$(readlink -f "$base/current")"
  code=0
  "$GATE_DIR/deploy.sh" --env "$env" --release "$rel/infra" --sha "$sha" --yes "${bench[@]}" || code=$?
  if [[ "$code" == 0 ]]; then
    ln -sfn "$rel" "$base/current.tmp" && mv -Tf "$base/current.tmp" "$base/current"
    say "version $sha en service ($env)."
  else
    say "ÉCHEC du déploiement de $sha ($env, code $code)."
    if [[ -n "$previous" && -d "$previous/infra" ]]; then
      say "retour automatique à la dernière version réussie ($(basename "$previous"))…"
      if RAIJIN_COMPOSE_DIR="$previous/infra" "$GATE_DIR/deploy.sh" --env "$env" --recover --yes "${bench[@]}"; then
        say "dernière version réussie remise en service. Les migrations déjà appliquées restent en place (A12)."
      else
        say "le retour automatique a échoué : intervention manuelle (docs/DEPLOY.md C7)."
      fi
    else
      say "aucune version précédente à remettre en service (premier déploiement)."
    fi
  fi
  # Ménage : les KEEP_RELEASES dernières livraisons (et celle en service) ; étiquettes <nom>/<image>:<commit> des
  # livraisons retirées (jamais latest, deployed ni previous ; une image utilisée n'est jamais supprimée).
  current="$(readlink -f "$base/current" 2>/dev/null || true)"
  mapfile -t old < <(find "$base/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | awk -v k="$KEEP_RELEASES" 'NR>k {print $2}')
  for dir in "${old[@]}"; do
    [[ "$dir" == "$current" || "$dir" == "$rel" ]] && continue
    old_sha="$(basename "$dir")"; old_sha="${old_sha%%-*}"
    if [[ "$old_sha" =~ ^[0-9a-f]{40}$ && "$old_sha" != "$sha" ]]; then
      for img in api web landing migrate bench-api bench-web bench-migrate; do
        docker image rm "$name/$img:$old_sha" >/dev/null 2>&1 || true
      done
    fi
    rm -r -- "$dir"
  done
  printf '%s\n' "$code" >"$status_file"
  exit "$code"
fi

# --- Commande forcée -------------------------------------------------------------------------------------
gate_env="${1:-}"
[[ "$gate_env" == dev || "$gate_env" == prod ]] || refuse "environnement de la clé absent ou invalide (authorized_keys)."
read -r -a request <<<"${SSH_ORIGINAL_COMMAND:-}"
verb="${request[0]:-}" env="${request[1]:-}" sha="${request[2]:-}"
[[ "$env" == "$gate_env" ]] || refuse "cette clé ne déploie que « $gate_env »."
base="$DEPLOY_BASE/$env"
[[ -d "$base/env" ]] || refuse "$base/env absent (docs/DEPLOY.md C3)."

case "$verb" in
  status)
    (( ${#request[@]} == 2 )) || refuse "usage : status <env>"
    say "en service : $(basename "$(readlink -f "$base/current" 2>/dev/null || echo aucune)")"
    tail -n 10 "$base/state/raijin/deploy-history" 2>/dev/null || say "aucun déploiement enregistré."
    exit 0
    ;;
  deploy)
    (( ${#request[@]} == 3 )) || refuse "usage : deploy <env> <commit>"
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || refuse "commit invalide (40 caractères hexadécimaux attendus)."
    ;;
  *) refuse "commande non autorisée (deploy ou status seulement)." ;;
esac

command -v python3 >/dev/null 2>&1 || refuse "python3 introuvable sur le VPS (docs/DEPLOY.md C1)."
command -v flock >/dev/null 2>&1 || refuse "flock introuvable (paquet util-linux)."
mkdir -p "$base/releases" "$base/incoming" "$base/logs" "$base/state"

# Un seul déploiement à la fois sur le VPS (dev et prod) : la RAM est partagée. Le verrou est hérité par
# l'exécution détachée, il ne se libère qu'à la fin du déploiement.
exec 9>"$DEPLOY_BASE/.deploy.lock"
if ! flock -n 9; then
  say "un autre déploiement est en cours : attente (40 min au plus)…"
  flock -w 2400 9 || refuse "verrou toujours pris après 40 min."
fi

min_free_gb="${RAIJIN_MIN_FREE_GB:-8}"
free_gb="$(df -P --block-size=1G "$base" | awk 'NR==2 {print $4}')"
(( free_gb >= min_free_gb )) || refuse "moins de $min_free_gb Go libres sous $base : livraison refusée."

stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
incoming="$base/incoming/$sha-$stamp"
rel="$base/releases/$sha-$stamp"
mkdir -m 750 "$incoming"
cleanup() { [[ -d "$incoming" ]] && rm -r -- "$incoming"; return 0; }
trap cleanup EXIT

say "réception de la livraison $sha ($env)…"
head -c "$MAX_BUNDLE_BYTES" >"$incoming/bundle.tar"
size="$(stat -c '%s' "$incoming/bundle.tar")"
(( size < MAX_BUNDLE_BYTES )) || refuse "livraison trop grosse (limite $MAX_BUNDLE_BYTES octets)."
say "livraison reçue ($(( size / 1024 / 1024 )) Mo)."

mkdir -m 750 "$incoming/x"
python3 "$GATE_DIR/lib/deploy_policy.py" bundle "$incoming/bundle.tar" "$incoming/x" || refuse "archive refusée."
rm -- "$incoming/bundle.tar"
name=raijin; [[ "$env" == dev ]] && name=raijin-dev
python3 "$GATE_DIR/lib/deploy_policy.py" images "$incoming/x/images.tar.gz" "$name" "$sha" || refuse "images refusées."

# Configuration Compose de la livraison, interpolée avec les fichiers de l'environnement : jamais affichée (elle
# contient des mots de passe), seulement passée au contrôle.
env_file="$base/env/.env"
[[ -r "$env_file" && -r "$base/env/.env.api" ]] || refuse "$base/env/.env ou .env.api absent (docs/DEPLOY.md C3)."
RAIJIN_ENV="$env" RAIJIN_COMPOSE_DIR="$incoming/x/infra" RAIJIN_ENV_FILE="$env_file"
RAIJIN_API_ENV_FILE="$base/env/.env.api" RAIJIN_BENCH_API_ENV_FILE="$base/env/.env.bench-api"
# shellcheck source=infra/lib/common.sh
source "$GATE_DIR/lib/common.sh"
hosts=("$(env_get "$env_file" APP_DOMAIN)" "$(env_get "$env_file" API_DOMAIN)" "$(env_get "$env_file" LANDING_DOMAIN)")
if [[ "$env" == prod ]]; then
  bench_domain="$(env_get "$env_file" BENCH_DOMAIN)"
  hosts+=("www.$(env_get "$env_file" LANDING_DOMAIN)" "${bench_domain:-banc.raijinshield.com}")
fi
# Profils rendus = ceux que deploy.sh peut activer : tools (+ bench en production seulement).
profiles=(--profile tools)
[[ "$env" == prod ]] && profiles+=(--profile bench)
compose "${profiles[@]}" config --format json --no-env-resolution 2>/dev/null \
  | python3 "$GATE_DIR/lib/deploy_policy.py" compose "$name" "$incoming/x/infra" "$(env_get "$env_file" TRAEFIK_NETWORK)" \
      "$RAIJIN_API_ENV_FILE" "$RAIJIN_BENCH_API_ENV_FILE" -- "${hosts[@]}" \
  || refuse "configuration Compose refusée (ou invalide avec $env_file)."
compose "${profiles[@]}" config --format json --no-interpolate 2>/dev/null \
  | python3 "$GATE_DIR/lib/deploy_policy.py" envfiles "$incoming/x/infra" \
  || refuse "env_file refusé."

# Scripts figés : signale (sans bloquer) une livraison dont les scripts diffèrent de ceux installés.
for f in deploy-gate.sh deploy.sh backup.sh watchdog.sh lib/common.sh lib/deploy_policy.py; do
  if [[ -f "$incoming/x/infra/$f" ]] && ! cmp -s "$incoming/x/infra/$f" "$GATE_DIR/$f"; then
    echo "::warning title=Scripts de déploiement à mettre à jour::infra/$f diffère de la copie figée du VPS (/opt/raijin-deploy) : applique docs/DEPLOY.md C8."
  fi
done

say "chargement des images…"
docker load -i "$incoming/x/images.tar.gz" | sed 's/^/  /'
rm -- "$incoming/x/images.tar.gz"
mv -T "$incoming/x" "$rel"

log_file="$base/logs/$sha-$stamp.log"
status_file="$base/logs/$sha-$stamp.status"
say "déploiement (journal : $log_file)…"
unset RAIJIN_COMPOSE_DIR
: >"$log_file"
nohup "$GATE_DIR/deploy-gate.sh" --run "$env" "$sha" "$rel" "$status_file" >"$log_file" 2>&1 </dev/null &
run_pid=$!
tail -n +1 -f --pid="$run_pid" "$log_file" || true
wait "$run_pid" && code=0 || code=$?
[[ -f "$status_file" ]] && code="$(cat "$status_file")"
if [[ "$code" == 0 ]]; then say "terminé : $sha en service ($env)."; else say "terminé en échec (code $code)."; fi
exit "$code"
