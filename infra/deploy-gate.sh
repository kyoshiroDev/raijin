#!/usr/bin/env bash
# =====================================================================================================
# Porte d'entrée du déploiement continu (docs/DEPLOY.md, partie C). Installée FIGÉE (root) dans
# /opt/raijin-deploy/infra/ avec release.sh, backup.sh, watchdog.sh, lib/common.sh et lib/deploy_policy.py.
#
# Commandes forcées des clés de GitHub Actions, un utilisateur Unix par environnement (docs/DEPLOY.md C2) :
#   ~deploy-dev/.ssh/authorized_keys  : restrict,command="/opt/raijin-deploy/infra/deploy-gate.sh dev"        … github-raijin-deploy-dev
#   ~deploy-prod/.ssh/authorized_keys : restrict,command="/opt/raijin-deploy/infra/deploy-gate.sh prod-depot" … github-raijin-depot-prod
# deploy-dev ne peut rien lire de /srv/raijin/prod (vérifié avant chaque déploiement du dev).
#
#   clé dev          deploy dev <commit>   (archive sur l'entrée standard) → contrôles → déploiement du dev
#                    status dev
#   clé prod-depot   depose prod <commit>  (1re ligne de l'entrée : jeton OIDC GitHub, puis l'archive) → l'archive est
#                    seulement DÉPOSÉE dans /srv/raijin/incoming/prod/ si le jeton prouve qu'elle vient de
#                    .github/workflows/deploy.yml sur main, à ce commit, avec cette empreinte. Rien n'est démarré.
#                    status prod
# Activation de la production, sur le VPS, par l'utilisateur (jamais par GitHub) :
#   sudo -u deploy-prod /opt/raijin-deploy/infra/deploy-gate.sh --approve <commit>
#     → le commit doit être la tête de main (git ls-remote, clé de lecture seule), puis mêmes contrôles et déploiement.
#
# Contrôles d'une livraison : archive (fichiers ordinaires), étiquettes et configuration des images, env_file, puis
# UNE configuration Compose résolue (env -i + liste blanche de variables, fichier de l'environnement), écrite dans la
# version (compose.resolved.json) et seule utilisée ensuite par release.sh, qui rejoue la politique avant chaque up/run.
# Échec → retour automatique à la dernière version réussie. Un déploiement à la fois sur le VPS (verrou global) ; il
# continue même si la connexion SSH tombe (journal dans /srv/raijin/<env>/logs/).
# =====================================================================================================
set -Eeuo pipefail
umask 027

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICY="$GATE_DIR/lib/deploy_policy.py"
# Session SSH (commande forcée) : aucune variable RAIJIN_* n'est prise en compte, valeurs figées. Seule exception, les
# tests de la CI (infra/ci/test-dev-env.sh : GitHub Actions, hors session SSH réelle, RAIJIN_GATE_TEST=1).
if [[ -n "${SSH_ORIGINAL_COMMAND+x}" && "${1:-}" != --run ]] \
   && ! [[ "${GITHUB_ACTIONS:-}" == true && "${RAIJIN_GATE_TEST:-}" == 1 && -z "${SSH_CONNECTION:-}" ]]; then
  while read -r v; do unset "$v"; done < <(compgen -v RAIJIN_)
fi
RAIJIN_SCRIPT=deploy-gate
DEPLOY_BASE="${RAIJIN_DEPLOY_BASE:-/srv/raijin}"
export RAIJIN_DEPLOY_BASE="$DEPLOY_BASE"
MAX_BUNDLE_BYTES="${RAIJIN_MAX_BUNDLE_BYTES:-4294967296}"
# Dépôt de la production : plafond plus bas (images de prod + banc ≈ 1 Go).
MAX_DEPOT_BYTES="${RAIJIN_MAX_DEPOT_BYTES:-2147483648}"
MAX_DEPOSITS=2
KEEP_RELEASES=5
JWKS_URL="${RAIJIN_JWKS_URL:-https://token.actions.githubusercontent.com/.well-known/jwks}"
CLEAN_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

say() { printf '%s [deploy-gate] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
refuse() { say "REFUS : $*" >&2; exit 2; }
name_of() { if [[ "$1" == dev ]]; then echo raijin-dev; else echo raijin; fi; }

# Accès à Docker : UNIQUEMENT par docker-priv.sh en root (sudo, environnement fixé par sudoers, C2) ; deploy-dev et
# deploy-prod ne sont pas dans le groupe docker. RAIJIN_PRIV_CMD : tests de la CI seulement (effacé sous SSH).
priv() { ${RAIJIN_PRIV_CMD:-sudo -n /opt/raijin-deploy/infra/docker-priv.sh} "$@"; }

# --- Mode interne : mise en service détachée de la session SSH (appelé par ce script seulement) -------------
if [[ "${1:-}" == --run ]]; then
  env="$2" rel_name="$3" status_file="$4"
  trap '' HUP PIPE
  code=0
  priv "$env" deploy "$rel_name" || code=$?
  # Ménage de la zone de l'utilisateur (sans Docker) : les KEEP_RELEASES dernières versions.
  base="$DEPLOY_BASE/$env"
  mapfile -t old < <(find "$base/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | awk -v k="$KEEP_RELEASES" 'NR>k {print $2}')
  for dir in "${old[@]}"; do rm -r -- "$dir"; done
  printf '%s\n' "$code" >"$status_file"
  exit "$code"
fi

# --- Livraison complète (dev, ou prod activée) ---------------------------------------------------------------
# deliver <env> <commit> <archive.tar>
deliver() {
  local env="$1" sha="$2" bundle="$3"
  local base="$DEPLOY_BASE/$env" name stamp incoming rel env_file profiles hosts bench_domain
  name="$(name_of "$env")"
  env_file="$base/env/.env"
  [[ -r "$env_file" && -r "$base/env/.env.api" ]] || refuse "$base/env/.env ou .env.api absent (docs/DEPLOY.md C3)."
  mkdir -p "$base/releases" "$base/incoming" "$base/logs" "$base/state"
  stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  incoming="$base/incoming/$sha-$stamp"
  rel="$base/releases/$sha-$stamp"
  mkdir -m 750 "$incoming" "$incoming/x"
  python3 "$POLICY" bundle "$bundle" "$incoming/x" || { rm -r -- "$incoming"; refuse "archive refusée."; }
  mv -T "$incoming/x" "$rel"
  rmdir "$incoming"
  printf '%s\n' "$sha" >"$rel/SHA"

  # Dossier de projet STABLE et RACINE par environnement (/var/lib/raijin-deploy/<env>/infra-stable) : docker-priv.sh
  # y copie les scripts d'init de Postgres (montés en lecture seule) ; l'utilisateur ne peut pas les remplacer, et
  # le chemin du montage ne change pas d'une version à l'autre (Postgres n'est pas recréé à chaque livraison).
  local stable="${RAIJIN_PRIV_BASE:-/var/lib/raijin-deploy}/$env/infra-stable"
  priv "$env" sync-init "$rel" || { rm -r -- "$rel"; refuse "scripts d'init refusés."; }

  # UNE configuration résolue, sous un environnement vidé et une liste blanche identique pour toute la suite.
  local files=(-f "$rel/infra/docker-compose.yml")
  [[ "$env" == dev ]] && files+=(-f "$rel/infra/docker-compose.env-dev.yml")
  profiles=(--profile tools)
  [[ "$env" == prod ]] && profiles+=(--profile bench)
  render() {
    env -i PATH="$CLEAN_PATH" HOME="$HOME" RAIJIN_NAME="$name" RAIJIN_TAG="$sha" \
      RAIJIN_API_ENV_FILE="$base/env/.env.api" RAIJIN_BENCH_API_ENV_FILE="$base/env/.env.bench-api" \
      docker compose --project-name "$name" --env-file "$env_file" --project-directory "$stable" "${files[@]}" \
      "${profiles[@]}" config --format json "$@"
  }
  # Avant TOUT rendu : Compose suivrait include / extends / env_file / label_file vers d'autres fichiers.
  python3 "$POLICY" yamlcheck "$rel/infra" || { rm -r -- "$rel"; refuse "fichiers Compose refusés (include, extends, env_file, label_file)."; }
  render --no-interpolate 2>/dev/null | python3 "$POLICY" envfiles "$stable" || { rm -r -- "$rel"; refuse "env_file refusé."; }
  ( umask 077; render 2>/dev/null >"$rel/compose.raw.json" ) || { rm -r -- "$rel"; refuse "configuration Compose invalide avec $env_file."; }
  python3 "$POLICY" resolve "$rel/compose.raw.json" "$rel/compose.resolved.json" >/dev/null
  rm -- "$rel/compose.raw.json"
  hosts="$(env_get "$env_file" APP_DOMAIN),$(env_get "$env_file" API_DOMAIN),$(env_get "$env_file" LANDING_DOMAIN)"
  if [[ "$env" == prod ]]; then
    bench_domain="$(env_get "$env_file" BENCH_DOMAIN)"
    hosts+=",www.$(env_get "$env_file" LANDING_DOMAIN),${bench_domain:-banc.raijinshield.com}"
  fi
  local entrypoint edge=()
  entrypoint="$(env_get "$env_file" TRAEFIK_ENTRYPOINT)"
  # Dev : réseau d'entrée selon RAIJIN_DEV_EDGE (traefik-shared par défaut = option B, dedicated = option A, C2).
  [[ "$env" == dev ]] && edge=(--edge "$(env_get "$env_file" RAIJIN_DEV_EDGE)")
  python3 "$POLICY" compose "$rel/compose.resolved.json" --name "$name" --root "$stable" \
    --network "$(env_get "$env_file" TRAEFIK_NETWORK)" --entrypoint "${entrypoint:-websecure}" \
    --certresolver "$(env_get "$env_file" TRAEFIK_CERTRESOLVER)" --tag "$sha" --hosts "$hosts" "${edge[@]}" \
    || { rm -r -- "$rel"; refuse "configuration Compose refusée."; }

  # Scripts figés : signale (sans bloquer) une livraison dont les scripts diffèrent de ceux installés.
  local f
  for f in deploy-gate.sh docker-priv.sh release.sh backup.sh watchdog.sh lib/common.sh lib/deploy_policy.py; do
    if [[ -f "$rel/infra/$f" ]] && ! cmp -s "$rel/infra/$f" "$GATE_DIR/$f"; then
      echo "::warning title=Scripts de déploiement à mettre à jour::infra/$f diffère de la copie figée du VPS (/opt/raijin-deploy) : applique docs/DEPLOY.md C8."
    fi
  done

  # Contrôle des images, docker load et comparaison de sa sortie : en root, sur une copie hors de portée de l'utilisateur.
  priv "$env" import "$rel" || { rm -r -- "$rel"; refuse "import refusé."; }
  rm -- "$rel/images.tar.gz"

  local log_file="$base/logs/$sha-$stamp.log" status_file="$base/logs/$sha-$stamp.status" run_pid code=0
  say "déploiement (journal : $log_file)…"
  : >"$log_file"
  nohup "$GATE_DIR/deploy-gate.sh" --run "$env" "$(basename "$rel")" "$status_file" >"$log_file" 2>&1 </dev/null &
  run_pid=$!
  tail -n +1 -f --pid="$run_pid" "$log_file" || true
  wait "$run_pid" || code=$?
  [[ -f "$status_file" ]] && code="$(cat "$status_file")"
  if [[ "$code" == 0 ]]; then say "terminé : $sha en service ($env)."; else say "terminé en échec (code $code)."; fi
  return "$code"
}

# Verrou global dev + prod : /srv/raijin/lock/deploy.lock, créé par root en 0644 (C2), ouvert en LECTURE par
# deploy-dev et deploy-prod (flock n'exige pas l'écriture ; personne ne peut le remplacer).
take_lock() {
  local lock="$DEPLOY_BASE/lock/deploy.lock"
  if [[ ! -e "$lock" ]]; then
    [[ "${RAIJIN_GATE_TEST:-}" == 1 ]] || refuse "$lock absent (docs/DEPLOY.md C2)."
    mkdir -p "$DEPLOY_BASE/lock"; : >>"$lock"
  fi
  [[ -f "$lock" && ! -L "$lock" ]] || refuse "$lock invalide."
  exec 9<"$lock"
  if ! flock -n 9; then
    say "un autre déploiement est en cours : attente (40 min au plus)…"
    flock -w 2400 9 || refuse "verrou toujours pris après 40 min."
  fi
}
check_disk() {
  local min="${RAIJIN_MIN_FREE_GB:-8}" free
  free="$(df -P --block-size=1G "$1" | awk 'NR==2 {print $4}')"
  (( free >= min )) || refuse "moins de $min Go libres sous $1."
}
# receive <fichier> : entrée standard bornée.
receive() {
  local max="${2:-$MAX_BUNDLE_BYTES}" size
  head -c "$max" >"$1"
  size="$(stat -c '%s' "$1")"
  (( size < max )) || { rm -f -- "$1"; refuse "livraison trop grosse."; }
  say "livraison reçue ($(( size / 1024 / 1024 )) Mo)."
}

command -v python3 >/dev/null 2>&1 || refuse "python3 introuvable sur le VPS (docs/DEPLOY.md C1)."
command -v flock >/dev/null 2>&1 || refuse "flock introuvable (paquet util-linux)."

# --- Activation de la production (locale, par l'utilisateur) ---------------------------------------------
if [[ "${1:-}" == --approve ]]; then
  [[ -z "${SSH_ORIGINAL_COMMAND:-}" ]] || refuse "activation interdite depuis une clé SSH."
  sha="${2:-}"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || refuse "usage : deploy-gate.sh --approve <commit complet>"
  RAIJIN_ENV=prod
  # shellcheck source=infra/lib/common.sh
  source "$GATE_DIR/lib/common.sh"
  depot="$DEPLOY_BASE/incoming/prod"
  # Même verrou que « depose » (et son ménage) : l'archive ne peut pas être remplacée ou retirée pendant l'activation.
  [[ -e "$depot/.lock" ]] || refuse "aucun dépôt dans $depot."
  exec 8<"$depot/.lock"
  flock -w 600 8 || refuse "dépôt en cours de réception, réessaie dans quelques minutes."
  [[ -f "$depot/$sha.tar" && -f "$depot/$sha.json" ]] || refuse "aucun dépôt vérifié pour $sha dans $depot (status prod)."
  want="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "$depot/$sha.json")"
  [[ "$(sha256sum "$depot/$sha.tar" | awk '{print $1}')" == "$want" ]] || refuse "le dépôt a changé depuis sa vérification."
  remote="$(env_get "$DEPLOY_BASE/prod/env/.env" DEPLOY_GIT_REMOTE)"
  [[ -n "$remote" ]] || refuse "DEPLOY_GIT_REMOTE vide dans $DEPLOY_BASE/prod/env/.env (docs/DEPLOY.md C5)."
  head_sha="$(GIT_SSH_COMMAND="ssh -F none -i $HOME/.ssh/github_readonly -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$HOME/.ssh/known_hosts_github" \
    git ls-remote "$remote" refs/heads/main | awk '{print $1}')"
  [[ "$head_sha" =~ ^[0-9a-f]{40}$ ]] || refuse "git ls-remote : tête de main illisible (clé de lecture seule, C5)."
  [[ "$head_sha" == "$sha" ]] || refuse "$sha n'est pas la tête de main ($head_sha) : rien n'est activé."
  say "commit $sha = tête de main ; dépôt vérifié (run GitHub $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("run_id"))' "$depot/$sha.json"))."
  take_lock
  check_disk "$DEPLOY_BASE/prod"
  code=0
  deliver prod "$sha" "$depot/$sha.tar" || code=$?
  rm -f -- "$depot/$sha.tar" "$depot/$sha.json"
  exit "$code"
fi

# --- Commandes forcées -------------------------------------------------------------------------------------
gate_key="${1:-}"
case "$gate_key" in
  dev) gate_env=dev ;;
  prod-depot) gate_env=prod ;;
  *) refuse "clé sans rôle valide (authorized_keys : dev ou prod-depot)." ;;
esac
read -r -a request <<<"${SSH_ORIGINAL_COMMAND:-}"
verb="${request[0]:-}" env="${request[1]:-}" sha="${request[2]:-}"
[[ "$env" == "$gate_env" ]] || refuse "cette clé ne concerne que « $gate_env »."
base="$DEPLOY_BASE/$env"
[[ -d "$base/env" ]] || refuse "$base/env absent (docs/DEPLOY.md C3)."
RAIJIN_ENV="$env"
# shellcheck source=infra/lib/common.sh
source "$GATE_DIR/lib/common.sh"

case "$gate_key:$verb" in
  *:status)
    (( ${#request[@]} == 2 )) || refuse "usage : status <env>"
    priv "$env" status || true
    if [[ "$env" == prod ]]; then
      say "dépôts en attente d'activation : $(find "$DEPLOY_BASE/incoming/prod" -maxdepth 1 -name '*.json' -printf '%f ' 2>/dev/null || true)"
    fi
    exit 0
    ;;
  dev:deploy)
    (( ${#request[@]} == 3 )) || refuse "usage : deploy dev <commit>"
    # Isolation : l'utilisateur du dev (deploy-dev) ne doit RIEN pouvoir lire de la production (docs/DEPLOY.md C2).
    for p in "$DEPLOY_BASE/prod" "$DEPLOY_BASE/prod/env/.env" "$DEPLOY_BASE/prod/env/.env.api" "$DEPLOY_BASE/incoming/prod"; do
      if [[ -e "$p" && ( -r "$p" || -x "$p" ) ]]; then refuse "isolation dev/prod absente : $p est accessible à $(id -un) (C2)."; fi
    done
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || refuse "commit invalide (40 caractères hexadécimaux attendus)."
    take_lock
    check_disk "$base"
    mkdir -p "$base/incoming"
    bundle="$base/incoming/$sha.tar"
    say "réception de la livraison $sha (dev)…"
    receive "$bundle"
    code=0
    deliver dev "$sha" "$bundle" || code=$?
    rm -f -- "$bundle"
    exit "$code"
    ;;
  prod-depot:depose)
    (( ${#request[@]} == 3 )) || refuse "usage : depose prod <commit>"
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || refuse "commit invalide (40 caractères hexadécimaux attendus)."
    repo="$(env_get "$base/env/.env" DEPLOY_GITHUB_REPOSITORY)"
    [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || refuse "DEPLOY_GITHUB_REPOSITORY absent de $base/env/.env (C5)."
    depot="$DEPLOY_BASE/incoming/prod"
    mkdir -p "$depot"
    [[ -e "$depot/.lock" ]] || : >>"$depot/.lock"
    exec 8<"$depot/.lock"
    flock -w 600 8 || refuse "dépôt déjà en cours."
    check_disk "$depot"
    IFS= read -r -n 8192 jwt || true
    [[ "$jwt" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] || refuse "jeton OIDC absent ou illisible (1re ligne)."
    jwks="$depot/.jwks-$$.json"
    curl -fsS --max-time 20 --proto '=https' -o "$jwks" "$JWKS_URL" || { rm -f -- "$jwks"; refuse "clés publiques de GitHub injoignables."; }
    # Pré-contrôle AVANT de recevoir quoi que ce soit : signature, émetteur, dépôt, branche main, workflow, commit,
    # expiration (l'audience, empreinte de l'archive, est vérifiée après réception).
    python3 "$POLICY" oidc "$jwt" --jwks "$jwks" --repo "$repo" --sha "$sha" >/dev/null \
      || { rm -f -- "$jwks"; refuse "jeton OIDC refusé (émetteur, branche, workflow, commit ou expiration)."; }
    tmp="$depot/.recu-$sha-$$.tar"
    say "réception de l'archive de production $sha (dépôt seulement)…"
    receive "$tmp" "$MAX_DEPOT_BYTES"
    hash="$(sha256sum "$tmp" | awk '{print $1}')"
    if ! claims="$(python3 "$POLICY" oidc "$jwt" --jwks "$jwks" --aud "raijin-depot-prod:$hash" --repo "$repo" --sha "$sha" | sed -n 1p)"; then
      rm -f -- "$tmp" "$jwks"
      refuse "jeton OIDC refusé : l'archive ne vient pas de deploy.yml sur main à ce commit."
    fi
    rm -f -- "$jwks"
    mv -f -- "$tmp" "$depot/$sha.tar"
    printf '{"sha256":"%s","claims":%s,"run_id":%s}\n' "$hash" "$claims" \
      "$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1]).get("run_id")))' "$claims")" >"$depot/$sha.json"
    # Au plus MAX_DEPOSITS dépôts en attente (les plus anciens sont retirés).
    mapfile -t extra < <(find "$depot" -maxdepth 1 -name '*.json' -printf '%T@ %f\n' | sort -rn | awk -v k="$MAX_DEPOSITS" 'NR>k {print $2}')
    for j in "${extra[@]}"; do rm -f -- "$depot/$j" "$depot/${j%.json}.tar"; done
    say "archive $sha DÉPOSÉE (empreinte vérifiée par OIDC). Rien n'est démarré."
    echo "::notice title=Production en attente d'activation::sur le VPS : sudo -u deploy-prod /opt/raijin-deploy/infra/deploy-gate.sh --approve $sha"
    exit 0
    ;;
  *) refuse "commande non autorisée pour cette clé." ;;
esac
