#!/usr/bin/env bash
# Installation guidée du VPS pour le déploiement continu (docs/DEPLOY.md, partie C : C1 à C5, plus A1 et A2).
# Lancé PAR TOI sur le VPS, jamais par un agent. Méthode la plus simple, depuis la racine du dépôt sur ton PC :
#
#   bash infra/vps-install.sh          # prépare les clés, copie ce script sur le VPS, aperçu, puis « Continuer ? »
#
# Méthode manuelle (sans le lanceur) :
#   # sur ton PC, depuis la racine du dépôt (scripts relus, à jour sur main) :
#   tar -cf ~/raijin-setup.tar infra/vps-setup.sh infra/deploy-gate.sh infra/docker-priv.sh infra/release.sh \
#       infra/backup.sh infra/watchdog.sh infra/lib/common.sh infra/lib/deploy_policy.py
#   scp ~/raijin-setup.tar greg@<adresse du VPS>:
#   # sur le VPS :
#   mkdir -p ~/raijin-setup && tar -xf ~/raijin-setup.tar -C ~/raijin-setup && cd ~/raijin-setup
#   sudo bash infra/vps-setup.sh                 # = --check : n'écrit RIEN, affiche ce qui est en place et ce qui serait fait
#   sudo bash infra/vps-setup.sh --apply --repo <compte>/raijin \
#       --dev-key raijin-deploy-dev.pub --prod-key raijin-depot-prod.pub --readonly-key raijin-github-readonly
#
# Modes :
#   --check            (défaut) aucune écriture, aucune commande qui modifie le système.
#   --apply            exécute, avec une confirmation (o/N) avant chaque bloc.
#   --yes-safe         avec --apply : applique sans question les blocs non destructifs ; demande TOUJOURS pour
#                      le retrait d'un groupe, les unités systemd et (option A seulement) « docker network connect »
#                      sur Traefik.
#   --preview-apply    aperçu (--check), puis « Continuer ? (o/N) », puis --apply --yes-safe (une seule session sudo).
# Options :
#   --repo <compte>/<dépôt>     DEPLOY_GITHUB_REPOSITORY / DEPLOY_GIT_REMOTE de la prod (valeurs publiques).
#   --keys <dossier>            dossier contenant raijin-deploy-dev.pub, raijin-depot-prod.pub, raijin-github-readonly.
#   --dev-key / --prod-key <f>  clés publiques (.pub) de GitHub Actions (dev, dépôt de la prod).
#   --readonly-key <f>          clé PRIVÉE de lecture du dépôt (Deploy key sans écriture) pour « git ls-remote ».
#   --traefik <conteneur>       nom du conteneur Traefik si la détection automatique échoue.
#   --dev-edge <mode>           réseau d'entrée du dev (RAIJIN_DEV_EDGE, docs/DEPLOY.md C2) :
#                                 traefik-shared (défaut, option B) : le dev rejoint le réseau du Traefik existant,
#                                   comme la prod ; le conteneur Traefik (créé par MTC) n'est PAS modifié ;
#                                 dedicated (option A) : réseau raijin-dev-edge propre au dev, que Traefik rejoint par
#                                   « docker network connect » (modifie le conteneur de MTC : ta décision explicite).
#                               Sans l'option : valeur déjà présente dans /srv/raijin/dev/env/.env, sinon traefik-shared.
#
# Garanties : idempotent (relançable), ne supprime rien (une version remplacée est gardée dans
# /var/lib/raijin-deploy/sauvegardes/), ne touche qu'à ce qui s'appelle raijin* / deploy-dev / deploy-prod ; jamais de
# « docker compose down », « prune », « volume rm » ; la configuration de Traefik, de sshd et des autres projets n'est
# pas modifiée. Aucun secret affiché : les secrets générés (openssl rand) sont écrits directement dans les fichiers 600.
set -Eeuo pipefail
umask 022
CURRENT_BLOCK='préparation'
on_error() {
  local code=$? line="$1"
  ((BASH_SUBSHELL == 0)) || return 0
  printf '\nÉtape « %s » échouée (ligne %s, code %s).\n' "$CURRENT_BLOCK" "$line" "$code" >&2
  printf "Rien n'a été cassé : ce qui était déjà fait reste en place et rien n'a été supprimé.\n" >&2
  printf 'Corrige la cause affichée ci-dessus, puis relance le script : il reprend là où il en était.\n' >&2
}
trap 'on_error $LINENO' ERR
export LC_ALL=C.UTF-8 2>/dev/null || true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE=/srv/raijin
GATE=/opt/raijin-deploy
VARLIB=/var/lib/raijin-deploy
BACKUPS="$VARLIB/sauvegardes"
SUDOERS=/etc/sudoers.d/raijin-deploy
SUDOERS_APPROVE=/etc/sudoers.d/raijin-approve
DEV_EDGE=raijin-dev-edge
FROZEN_EXEC=(deploy-gate.sh docker-priv.sh release.sh backup.sh watchdog.sh)
FROZEN_LIB=(lib/common.sh lib/deploy_policy.py)
# Empreinte publiée par GitHub : https://docs.github.com/fr/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
GITHUB_ED25519_FP='SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU'
STAMP="$(date +%Y%m%d-%H%M%S)"

MODE=check YES_SAFE=0 PREVIEW_APPLY=0
REPO='' KEYS_DIR='' DEV_KEY='' PROD_KEY='' RO_KEY='' TRAEFIK='' DEV_EDGE_OPT=''

usage() { sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die() { printf '\nERREUR : %s\n' "$*" >&2; exit 1; }

while (($#)); do
  case "$1" in
    --check) MODE=check ;;
    --apply) MODE=apply ;;
    --yes-safe) YES_SAFE=1 ;;
    --preview-apply) PREVIEW_APPLY=1 ;;
    --repo) REPO="${2:-}"; shift ;;
    --keys) KEYS_DIR="${2:-}"; shift ;;
    --dev-key) DEV_KEY="${2:-}"; shift ;;
    --prod-key) PROD_KEY="${2:-}"; shift ;;
    --readonly-key) RO_KEY="${2:-}"; shift ;;
    --traefik) TRAEFIK="${2:-}"; shift ;;
    --dev-edge) DEV_EDGE_OPT="${2:-}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "option inconnue : $1 (--help)" ;;
  esac
  shift
done

[[ $EUID -eq 0 ]] || die "lance ce script avec sudo : sudo bash $0 ${MODE:+--$MODE}"
[[ -z "$REPO" || "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--repo attendu sous la forme compte/depot."
[[ -z "$TRAEFIK" || "$TRAEFIK" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "--traefik : nom de conteneur invalide."
[[ -z "$DEV_EDGE_OPT" || "$DEV_EDGE_OPT" == traefik-shared || "$DEV_EDGE_OPT" == dedicated ]] \
  || die "--dev-edge : traefik-shared (option B, défaut) ou dedicated (option A)."
if [[ -z "$KEYS_DIR" && -d "$SCRIPT_DIR/../keys" ]]; then KEYS_DIR="$SCRIPT_DIR/../keys"; fi
if [[ -n "$KEYS_DIR" ]]; then
  [[ -d "$KEYS_DIR" ]] || die "--keys : dossier introuvable."
  [[ -n "$DEV_KEY" || ! -f "$KEYS_DIR/raijin-deploy-dev.pub" ]] || DEV_KEY="$KEYS_DIR/raijin-deploy-dev.pub"
  [[ -n "$PROD_KEY" || ! -f "$KEYS_DIR/raijin-depot-prod.pub" ]] || PROD_KEY="$KEYS_DIR/raijin-depot-prod.pub"
  [[ -n "$RO_KEY" || ! -f "$KEYS_DIR/raijin-github-readonly" ]] || RO_KEY="$KEYS_DIR/raijin-github-readonly"
fi
for f in "${FROZEN_EXEC[@]}" "${FROZEN_LIB[@]}"; do
  [[ -f "$SCRIPT_DIR/$f" ]] || die "fichier manquant à côté du script : infra/$f (copie l'archive complète)."
done

# Sudo appelant (pour la règle --approve et l'alias) : seulement un nom d'utilisateur ordinaire.
CALLER="${SUDO_USER:-}"
[[ "$CALLER" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$CALLER" != root ]] || CALLER=''

# ---------------------------------------------------------------------------------------------------------------------
# Affichage et moteur des blocs. Chaque bloc est une fonction appelée deux fois : passe de lecture (DRY=1 : constats et
# liste des actions) puis, en --apply et après confirmation, passe d'exécution (DRY=0).
# ---------------------------------------------------------------------------------------------------------------------
DRY=1 PENDING=0 ACT_SKIPPED=0
DONE=() ALREADY=() TODO=() SKIPPED=()

title() { printf '\n== %s ==\n' "$*"; }
ok() { if ((DRY)); then ALREADY+=("$*"); printf '  [en place] %s\n' "$*"; fi; }
info() { if ((DRY)); then printf '  [info]     %s\n' "$*"; fi; }
todo() { if ((DRY)); then TODO+=("$*"); printf '  [toi]      %s\n' "$*"; fi; }
warn() { if ((DRY)); then TODO+=("ATTENTION : $*"); printf '  [ATTENTION] %s\n' "$*"; fi; }
act() {
  local desc="$1"; shift
  if ((DRY)); then
    PENDING=$((PENDING + 1))
    printf '  [à faire]  %s\n' "$desc"
  else
    ACT_SKIPPED=0
    "$@"
    if ((ACT_SKIPPED)); then printf '  [passé]    %s\n' "$desc"; else DONE+=("$desc"); printf '  [fait]     %s\n' "$desc"; fi
  fi
}
confirm() { # $1 = safe | ask, $2 = question
  if [[ "$1" == safe && $YES_SAFE == 1 ]]; then return 0; fi
  if [[ ! -t 0 ]]; then printf '  (pas de terminal : réponse « non »)\n'; return 1; fi
  local r; read -r -p "  $2 (o/N) " r || return 1
  [[ "$r" =~ ^[oOyY]$ ]]
}
run_block() { # titre, safe|ask, fonction
  title "$1"
  CURRENT_BLOCK="$1"
  DRY=1 PENDING=0
  "$3"
  ((PENDING)) || return 0
  [[ "$MODE" == apply ]] || return 0
  if confirm "$2" "Appliquer ce bloc ($PENDING action(s)) ?"; then
    DRY=0; "$3"; DRY=1
  else
    SKIPPED+=("$1"); printf '  -> bloc non appliqué.\n'
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }
user_exists() { id -u "$1" >/dev/null 2>&1; }
home_of() { local h; h="$(getent passwd "$1" | cut -d: -f6 || true)"; printf '%s' "${h:-/home/$1}"; }
perm_of() { stat -c '%U %G %a' "$1" 2>/dev/null || true; }
backup_file() { # garde la version remplacée (jamais supprimée)
  local f="$1" d="$BACKUPS/$STAMP"
  [[ -e "$f" ]] || return 0
  [[ -d "$BACKUPS" ]] || install -d -o root -g root -m 700 "$BACKUPS"
  install -d -o root -g root -m 700 "$d"
  cp -a -- "$f" "$d/$(printf '%s' "$f" | tr '/' '_')"
}

# Valeur d'une variable d'un fichier .env, sans l'exécuter ni l'afficher (dernière occurrence, guillemets retirés).
env_value() {
  [[ -f "$1" ]] || return 0
  RJ_KEY="$2" awk 'BEGIN{k=ENVIRON["RJ_KEY"]; v=""}
    index($0, k "=") == 1 { v = substr($0, length(k) + 2) }
    END {
      sub(/^[ \t]+/, "", v); sub(/[ \t]+$/, "", v)
      if (v ~ /^".*"$/ || v ~ /^\047.*\047$/) v = substr(v, 2, length(v) - 2)
      printf "%s", v
    }' "$1"
}
# Écrit KEY=<RJ_VALUE> (valeur passée par l'environnement, jamais en argument ni à l'écran) à la place des lignes
# KEY= vides, ou à la fin. Le fichier garde son propriétaire et ses droits 600.
set_var() {
  local file="$1" key="$2" tmp
  tmp="$(mktemp "$(dirname "$file")/.vps-setup.XXXXXX")"
  RJ_KEY="$key" awk -v q="'" 'BEGIN{k=ENVIRON["RJ_KEY"]; v=ENVIRON["RJ_VALUE"]; done=0; empty="^[ \t]*(\"\"|" q q ")?[ \t]*$"}
    index($0, k "=") == 1 && substr($0, length(k) + 2) ~ empty { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$file" >"$tmp"
  chown --reference="$file" "$tmp"
  chmod 600 "$tmp"
  mv -f -- "$tmp" "$file"
}

# ---------------------------------------------------------------------------------------------------------------------
# Détection du Traefik existant (lecture seule, A2)
# ---------------------------------------------------------------------------------------------------------------------
DOCKER_OK=0 TRAEFIK_NET='' TRAEFIK_EP='' TRAEFIK_CR=''
detect_docker() {
  if have docker && timeout 20 docker info >/dev/null 2>&1; then DOCKER_OK=1; fi
  ((DOCKER_OK)) || return 0
  if [[ -z "$TRAEFIK" ]]; then
    local found
    found="$(docker ps --format '{{.Names}} {{.Image}}' | awk 'tolower($2) ~ /traefik/ {print $1}')"
    if [[ $(printf '%s\n' "$found" | grep -c .) -eq 1 ]]; then TRAEFIK="$found"; fi
    TRAEFIK_CANDIDATES="$found"
  fi
  [[ -n "$TRAEFIK" ]] && docker inspect "$TRAEFIK" >/dev/null 2>&1 || { TRAEFIK=''; return 0; }
  local nets args
  TRAEFIK_NETS_ALL="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$TRAEFIK" | tr ' ' '\n')"
  nets="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$TRAEFIK" | tr ' ' '\n' \
    | grep -v -x -e "$DEV_EDGE" -e '' -e bridge -e host || true)"
  if [[ $(printf '%s\n' "$nets" | grep -c .) -eq 1 ]]; then
    TRAEFIK_NET="$nets"
  elif [[ -n "$nets" && -t 0 ]]; then
    printf '\nTraefik (%s) est sur plusieurs réseaux : %s\n' "$TRAEFIK" "$(printf '%s ' $nets)"
    local r; read -r -p "Réseau utilisé par les conteneurs de MTC pour être joints (vide = décider plus tard) : " r || true
    if printf '%s\n' "$nets" | grep -qx -- "$r"; then TRAEFIK_NET="$r"; fi
  fi
  TRAEFIK_NETS="$nets"
  args="$(docker inspect -f '{{json .Args}}' "$TRAEFIK" 2>/dev/null || true)"
  TRAEFIK_EP="$(printf '%s' "$args" | grep -oE -- '--entrypoints\.[A-Za-z0-9_-]+\.address=[^"]*:443' \
    | sed -E 's/--entrypoints\.([A-Za-z0-9_-]+)\..*/\1/' | sort -u || true)"
  [[ $(printf '%s\n' "$TRAEFIK_EP" | grep -c .) -eq 1 ]] || TRAEFIK_EP=''
  TRAEFIK_CR="$(printf '%s' "$args" | grep -oE -- '--certificatesresolvers\.[A-Za-z0-9_-]+\.' \
    | sed -E 's/--certificatesresolvers\.([A-Za-z0-9_-]+)\./\1/' | sort -u || true)"
  [[ $(printf '%s\n' "$TRAEFIK_CR" | grep -c .) -eq 1 ]] || TRAEFIK_CR=''
}
TRAEFIK_CANDIDATES='' TRAEFIK_NETS='' TRAEFIK_NETS_ALL=''
# Mode du réseau d'entrée du dev (C2) : --dev-edge, sinon le .env du dev, sinon traefik-shared (option B).
dev_edge_mode() {
  local v="$DEV_EDGE_OPT"
  [[ -n "$v" ]] || v="$(env_value "$BASE/dev/env/.env" RAIJIN_DEV_EDGE)"
  [[ "$v" == dedicated ]] && echo dedicated || echo traefik-shared
}

# ---------------------------------------------------------------------------------------------------------------------
# Blocs
# ---------------------------------------------------------------------------------------------------------------------
block_prereq() { # C1 / A1 : constats seulement
  if ((DOCKER_OK)); then
    ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?')"
    local cv; cv="$(docker compose version --short 2>/dev/null | sed 's/^v//' || true)"
    if [[ -n "$cv" && "$(printf '%s\n2.24.0\n' "$cv" | sort -V | head -1)" == 2.24.0 ]]; then ok "Docker Compose $cv"
    else todo "Docker Compose 2.24 ou plus requis (trouvé : ${cv:-absent}) : mets à jour docker-compose-plugin (A1)."; fi
  else
    todo "Docker absent ou arrêté : installe Docker 24+ et Compose 2.24+ (A1), puis relance ce script."
  fi
  if have python3 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' 2>/dev/null; then
    ok "Python $(python3 -c 'import platform; print(platform.python_version())')"
  fi
  local mem disk
  mem="$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
  disk="$(df -Pm / | awk 'NR==2 {print int($4/1024)}')"
  info "mémoire disponible : ${mem} Mo (le dev ajoute ≈ 900 Mo au maximum, ≈ 300 Mo habituels) ; disque libre : ${disk} Go"
  if ((mem < 1000)); then warn "moins de 1 Go de mémoire disponible : le dev pourrait ralentir MTC et XMR Trader (C9)."; fi
}

PKGS=(python3 python3-yaml git util-linux openssl apache2-utils sudo openssh-client)
missing_pkgs() {
  local p out=()
  for p in "${PKGS[@]}"; do
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || out+=("$p")
  done
  printf '%s ' "${out[@]}"
}
install_pkgs() {
  # NEEDRESTART_MODE=l : needrestart liste seulement, ne redémarre AUCUN service (ceux de MTC et XMR Trader compris).
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1 apt-get update -qq
  # shellcheck disable=SC2046
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1 \
    apt-get install -y -qq --no-install-recommends $(missing_pkgs)
}
block_packages() {
  if ! have dpkg-query || ! have apt-get; then
    todo "distribution sans apt : installe toi-même ${PKGS[*]}."; return 0
  fi
  local m; m="$(missing_pkgs)"
  if [[ -z "${m// /}" ]]; then ok "paquets : ${PKGS[*]}"; else act "installer les paquets : $m" install_pkgs; fi
}

block_users() { # C2
  local u
  for u in deploy-dev deploy-prod; do
    if user_exists "$u"; then ok "utilisateur $u"
    else act "créer l'utilisateur $u (sans mot de passe, hors des groupes docker et sudo)" \
      useradd --create-home --shell /bin/bash --comment "Raijin deploy ${u#deploy-}" --user-group "$u"; fi
    if user_exists "$u"; then
      case "$(passwd -S "$u" 2>/dev/null | awk '{print $2}')" in
        L|LK) ok "$u : mot de passe verrouillé (clé SSH seulement)" ;;
        *) act "verrouiller le mot de passe de $u (passwd -l)" passwd -l "$u" ;;
      esac
    fi
  done
}

block_groups() { # retrait des groupes interdits (toujours demandé)
  local u g
  for u in deploy-dev deploy-prod; do
    user_exists "$u" || continue
    for g in docker sudo admin wheel; do
      if id -nG "$u" | tr ' ' '\n' | grep -qx "$g"; then act "retirer $u du groupe $g (C2 : accès à Docker par sudo seulement)" gpasswd -d "$u" "$g"
      fi
    done
  done
  ((PENDING)) || ok "deploy-dev et deploy-prod hors des groupes docker / sudo"
}

ensure_dir() { # chemin propriétaire groupe mode
  local p="$1" o="$2" g="$3" m="$4" cur
  if [[ -L "$p" ]]; then warn "$p est un lien symbolique : à vérifier à la main (rien n'est modifié)."; return 0; fi
  if [[ ! -e "$p" ]]; then
    if ((!DRY)) && ! user_exists "$o"; then printf '  [passé]    %s (utilisateur %s absent)\n' "$p" "$o"; return 0; fi
    act "créer $p ($o:$g $m)" install -d -o "$o" -g "$g" -m "$m" "$p"; return 0
  fi
  [[ -d "$p" ]] || { warn "$p existe mais n'est pas un dossier (rien n'est modifié)."; return 0; }
  cur="$(perm_of "$p")"
  if [[ "$cur" == "$o $g $m" ]]; then ok "$p ($cur)"
  else act "corriger $p : $cur -> $o $g $m" fix_perm "$p" "$o" "$g" "$m"; fi
}
fix_perm() {
  [[ ! -L "$1" ]] || die "$1 est un lien symbolique : rien n'est modifié."
  chown -h "$2:$3" "$1"; chmod "$4" "$1"
}
block_dirs() { # C2
  local hd hp
  hd="$(home_of deploy-dev)" hp="$(home_of deploy-prod)"
  ensure_dir "$BASE" root root 755
  ensure_dir "$BASE/incoming" root root 755
  ensure_dir "$BASE/lock" root root 755
  if [[ -f "$BASE/lock/deploy.lock" && ! -L "$BASE/lock/deploy.lock" ]]; then
    local cur; cur="$(perm_of "$BASE/lock/deploy.lock")"
    if [[ "$cur" == "root root 644" ]]; then ok "$BASE/lock/deploy.lock ($cur)"
    else act "corriger $BASE/lock/deploy.lock : $cur -> root root 644" fix_perm "$BASE/lock/deploy.lock" root root 644; fi
  elif [[ ! -e "$BASE/lock/deploy.lock" ]]; then
    act "créer le verrou $BASE/lock/deploy.lock (root 0644)" install -o root -g root -m 0644 /dev/null "$BASE/lock/deploy.lock"
  else warn "$BASE/lock/deploy.lock n'est pas un fichier ordinaire."; fi
  ensure_dir "$VARLIB" root root 711
  ensure_dir "$BASE/dev" deploy-dev deploy-dev 750
  ensure_dir "$BASE/dev/env" deploy-dev deploy-dev 700
  ensure_dir "$hd/.ssh" deploy-dev deploy-dev 700
  ensure_dir "$BASE/prod" deploy-prod deploy-prod 750
  ensure_dir "$BASE/prod/env" deploy-prod deploy-prod 700
  ensure_dir "$BASE/incoming/prod" deploy-prod deploy-prod 700
  ensure_dir "$hp/.ssh" deploy-prod deploy-prod 700
}

install_frozen() { backup_file "$2"; install -o root -g root -m "$3" "$1" "$2"; }
block_frozen() { # C4 / C8
  ensure_dir "$GATE" root root 755
  ensure_dir "$GATE/infra" root root 755
  ensure_dir "$GATE/infra/lib" root root 755
  local f mode dst cur
  for f in "${FROZEN_EXEC[@]}" "${FROZEN_LIB[@]}"; do
    mode=755; [[ "$f" == lib/* ]] && mode=644
    dst="$GATE/infra/$f"
    if [[ ! -e "$dst" ]]; then act "installer $dst (root, $mode)" install_frozen "$SCRIPT_DIR/$f" "$dst" "$mode"
    elif ! cmp -s "$SCRIPT_DIR/$f" "$dst"; then
      act "mettre à jour $dst (C8 ; ancienne version gardée dans $BACKUPS)" install_frozen "$SCRIPT_DIR/$f" "$dst" "$mode"
    else
      cur="$(perm_of "$dst")"
      if [[ "$cur" == "root root $mode" ]]; then ok "$dst identique ($cur)"
      else act "corriger $dst : $cur -> root root $mode" fix_perm "$dst" root root "$mode"; fi
    fi
  done
}

sudoers_content() {
  cat <<'EOF'
# Raijin Shield : accès à Docker des utilisateurs de déploiement, par ce seul script (docs/DEPLOY.md C2).
# Installé par infra/vps-setup.sh.
Defaults!/opt/raijin-deploy/infra/docker-priv.sh env_reset, !requiretty
deploy-dev  ALL=(root) NOPASSWD: /opt/raijin-deploy/infra/docker-priv.sh dev *
deploy-prod ALL=(root) NOPASSWD: /opt/raijin-deploy/infra/docker-priv.sh prod *
EOF
}
approve_content() {
  printf '# Raijin Shield : activation de la prod sans mot de passe (docs/DEPLOY.md C6). Installé par infra/vps-setup.sh.\n'
  printf '%s ALL=(deploy-prod) NOPASSWD: /opt/raijin-deploy/infra/deploy-gate.sh --approve *\n' "$CALLER"
}
install_sudoers() { # fichier, générateur
  local tmp; tmp="$(mktemp)"
  "$2" >"$tmp"
  visudo -cf "$tmp" >/dev/null || { rm -f -- "$tmp"; die "règle sudoers refusée par visudo : rien n'est installé."; }
  backup_file "$1"
  install -o root -g root -m 0440 "$tmp" "$1"
  rm -f -- "$tmp"
  visudo -c >/dev/null || printf '  [ATTENTION] visudo -c signale une erreur dans la configuration sudo existante.\n'
}
ensure_sudoers() { # fichier, générateur, description
  local tmp; tmp="$(mktemp)"
  "$2" >"$tmp"
  if [[ -f "$1" ]] && cmp -s "$tmp" "$1" && [[ "$(perm_of "$1")" == "root root 440" ]]; then ok "$1 ($3)"
  elif ! have visudo; then todo "visudo absent (paquet sudo) : règle $1 non installée."
  elif [[ -f "$1" ]]; then act "remplacer $1 ($3, validé par visudo -cf ; ancienne version gardée)" install_sudoers "$1" "$2"
  else act "installer $1 ($3, validé par visudo -cf)" install_sudoers "$1" "$2"; fi
  rm -f -- "$tmp"
}
add_alias() {
  local rc; rc="$(home_of "$CALLER")/.bashrc"
  [[ -f "$rc" ]] || install -o "$CALLER" -g "$(id -gn "$CALLER")" -m 644 /dev/null "$rc"
  printf "\n# Raijin Shield (infra/vps-setup.sh) : activation de la prod, docs/DEPLOY.md C6\nalias raijin-approve='sudo -u deploy-prod /opt/raijin-deploy/infra/deploy-gate.sh --approve'\n" >>"$rc"
}
block_sudoers() {
  ensure_sudoers "$SUDOERS" sudoers_content "docker-priv.sh pour deploy-dev / deploy-prod"
  if [[ -n "$CALLER" ]]; then
    ensure_sudoers "$SUDOERS_APPROVE" approve_content "$CALLER peut lancer --approve en tant que deploy-prod"
    if grep -qs 'alias raijin-approve=' "$(home_of "$CALLER")/.bashrc"; then ok "alias raijin-approve dans ~$CALLER/.bashrc"
    else act "ajouter l'alias raijin-approve à ~$CALLER/.bashrc" add_alias; fi
  else
    info "utilisateur appelant inconnu (lancé sans sudo ?) : règle --approve et alias non proposés (C6)."
  fi
}

# --- Fichiers de variables (C3) -------------------------------------------------------------------------------------
tpl_env_prod() {
  cat <<'EOF'
# Raijin Shield — production : variables lues par Compose et les scripts (docs/ENV.md « Production (VPS) »).
# Créé par infra/vps-setup.sh. Remplis les valeurs vides (les mots de passe sont générés par le script).
TRAEFIK_NETWORK=
TRAEFIK_ENTRYPOINT=
TRAEFIK_CERTRESOLVER=
LANDING_DOMAIN=raijinshield.com
APP_DOMAIN=app.raijinshield.com
API_DOMAIN=api.raijinshield.com
BENCH_DOMAIN=banc.raijinshield.com
DEPLOY_GITHUB_REPOSITORY=
DEPLOY_GIT_REMOTE=
POSTGRES_SUPERUSER_PASSWORD=
RAIJIN_DB_PASSWORD=
BENCH_DB_PASSWORD=
REDIS_PASSWORD=
REDIS_BENCH_PASSWORD=
# Valeurs publiques de la landing (facultatives, partie B)
GA4_MEASUREMENT_ID=
GOOGLE_SITE_VERIFICATION=
# Banc (A14) : htpasswd -nBC 12 <utilisateur>, ENTRE APOSTROPHES
BENCH_BASIC_AUTH_USERS=
BACKUP_DIR=/var/backups/raijin
BACKUP_RETENTION_DAYS=7
# Remote rclone chiffré (A9) ; vide = pas de copie hors site
BACKUP_RCLONE_REMOTE=
WATCHDOG_ALERT_EMAIL=
WATCHDOG_FAILS_BEFORE_ALERT=2
WATCHDOG_REMIND_HOURS=6
WATCHDOG_DISK_PCT=85
WATCHDOG_MIN_MEM_MB=200
WATCHDOG_EXTERNAL=1
EOF
}
tpl_env_dev() {
  cat <<'EOF'
# Raijin Shield — dev (dev.raijinshield.com) : docs/ENV.md « Dev (VPS) ». Créé par infra/vps-setup.sh.
# Aucune valeur commune avec la prod (les mots de passe sont générés par le script).
RAIJIN_NAME=raijin-dev
# Réseau d'entrée (docs/DEPLOY.md C2) : traefik-shared (option B, réseau du Traefik existant, le même que la prod)
# ou dedicated (option A, TRAEFIK_NETWORK=raijin-dev-edge rejoint par Traefik).
RAIJIN_DEV_EDGE=
TRAEFIK_NETWORK=
TRAEFIK_ENTRYPOINT=
TRAEFIK_CERTRESOLVER=
LANDING_DOMAIN=landing-dev.raijinshield.com
APP_DOMAIN=dev.raijinshield.com
API_DOMAIN=api-dev.raijinshield.com
POSTGRES_SUPERUSER_PASSWORD=
RAIJIN_DB_PASSWORD=
BENCH_DB_PASSWORD=
REDIS_PASSWORD=
# basicAuth devant tout le dev : htpasswd -nBC 12 <utilisateur>, ENTRE APOSTROPHES (proposé par le script)
DEV_BASIC_AUTH_USERS=
EOF
}
tpl_api_common() {
  cat <<'EOF'
JWT_ACCESS_SECRET=
COOKIE_SECRET=
IP_HASH_SECRET=
TOTP_ENCRYPTION_KEY=
PUSH_PROVIDER=webpush
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:support@raijinshield.com
# Helius : https://dashboard.helius.dev/api-keys
HELIUS_API_KEY=
BILLING_PROVIDER=stripe
# Stripe : https://dashboard.stripe.com/test/apikeys et /test/products ; webhook : docs/DEPLOY.md A7 (prod) ou C3 (dev)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_PRO_MONTHLY=
STRIPE_PRICE_PRO_YEARLY=
# Sentry (facultatif) : https://sentry.io/settings/projects/ → Client Keys
SENTRY_DSN_API=
EOF
}
tpl_api_prod() {
  printf '# Raijin Shield — production : variables du conteneur raijin-api (docs/ENV.md). Créé par infra/vps-setup.sh.\n'
  printf '# Les secrets JWT, cookies, TOTP, empreinte IP et la paire VAPID sont générés par le script.\n'
  tpl_api_common
  cat <<'EOF'
SENTRY_ENVIRONMENT=production
# E-mails : https://resend.com/api-keys (domaine vérifié sur https://resend.com/domains)
MAIL_PROVIDER=resend
RESEND_API_KEY=
MAIL_FROM="Raijin <noreply@raijinshield.com>"
JOBS_ENABLED=true
# Google, lecture seule (partie B, sections 2 à 4)
GA4_PROPERTY_ID=
GOOGLE_SERVICE_ACCOUNT_JSON=
SEARCH_CONSOLE_SITE_URL=
EOF
}
tpl_api_dev() {
  printf '# Raijin Shield — dev : variables du conteneur raijin-dev-api (docs/ENV.md « Dev (VPS) »). Créé par infra/vps-setup.sh.\n'
  printf '# Stripe en MODE TEST seulement (sk_test_…) ; e-mails capturés par Mailpit ; Google laissé vide.\n'
  tpl_api_common
  cat <<'EOF'
SENTRY_ENVIRONMENT=dev
JOBS_ENABLED=false
HELIUS_DAILY_CREDIT_BUDGET=5000
WATCH_DAILY_CREDIT_BUDGET=2000
WALLET_DAILY_CREDIT_BUDGET=1000
EOF
}

gen_secret() { # hex | b48 | b32
  case "$1" in
    hex) openssl rand -hex 32 ;;
    b48) openssl rand -base64 48 | tr -d '\n' ;;
    b32) openssl rand -base64 32 | tr -d '\n' ;;
  esac
}
write_secret() { local v; v="$(gen_secret "$3")"; RJ_VALUE="$v" set_var "$1" "$2"; v=''; }
write_value() { RJ_VALUE="$3" set_var "$1" "$2"; }
# Paire VAPID (P-256) : clé publique non compressée (65 octets) et clé privée (32 octets), base64url sans « = »,
# extraites de la structure DER SEC1 produite par openssl. Jamais affichées.
write_vapid() {
  local out pub priv
  out="$(openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null | openssl ec -outform DER 2>/dev/null | python3 -I -c '
import base64, sys
d = sys.stdin.buffer.read()
if len(d) != 121 or d[5:7] != b"\x04\x20" or d[53:56] != b"\x03\x42\x00":
    sys.exit(1)
e = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
print(e(d[56:121]))
print(e(d[7:39]))')" || die "génération de la paire VAPID impossible (openssl / python3)."
  pub="${out%%$'\n'*}" priv="${out##*$'\n'}"
  RJ_VALUE="$pub" set_var "$1" VAPID_PUBLIC_KEY
  RJ_VALUE="$priv" set_var "$1" VAPID_PRIVATE_KEY
  out='' priv=''
}
ask_basic_auth() {
  local file="$1" user p1 p2 line
  if [[ ! -t 0 ]] || ! have htpasswd; then ACT_SKIPPED=1; return 0; fi
  printf '\n  Mot de passe du dev (basicAuth de dev.raijinshield.com), DIFFÉRENT de celui du banc. Entrée vide = plus tard.\n'
  read -r -p "  Utilisateur [kyoshiro] : " user || true
  user="${user:-kyoshiro}"
  [[ "$user" =~ ^[A-Za-z0-9._-]{1,32}$ ]] || { printf '  utilisateur invalide.\n'; ACT_SKIPPED=1; return 0; }
  read -r -s -p "  Mot de passe (12 caractères ou plus) : " p1 || true; printf '\n'
  [[ -n "$p1" ]] || { ACT_SKIPPED=1; return 0; }
  read -r -s -p "  Encore une fois : " p2 || true; printf '\n'
  if [[ "$p1" != "$p2" || ${#p1} -lt 12 ]]; then printf '  mots de passe différents ou trop court : à refaire plus tard.\n'; p1='' p2=''; ACT_SKIPPED=1; return 0; fi
  line="$(printf '%s' "$p1" | htpasswd -niBC 12 "$user" | head -1)"
  p1='' p2=''
  RJ_VALUE="'$line'" set_var "$file" DEV_BASIC_AUTH_USERS
  line=''
}

create_env_file() { # fichier, propriétaire, générateur
  install -o "$2" -g "$2" -m 600 /dev/null "$1"
  "$3" >>"$1"
}
copy_env_file() { install -o "$3" -g "$3" -m 600 "$1" "$2"; }

ensure_env_file() { # env, nom (.env | .env.api), générateur
  local env="$1" name="$2" gen="$3" u="deploy-$1" f="$BASE/$1/env/$2" cur legacy=''
  [[ "$env" == prod ]] && legacy="/opt/raijin/infra/$name"
  if [[ -L "$f" ]]; then warn "$f est un lien symbolique (refusé par la porte) : à remplacer à la main."; return 0; fi
  if [[ ! -e "$f" ]]; then
    if ((!DRY)) && ! [[ -d "$BASE/$env/env" ]] ; then printf '  [passé]    %s (dossier absent)\n' "$f"; return 0; fi
    if [[ -n "$legacy" && -f "$legacy" ]]; then act "reprendre $legacy (partie A) dans $f (600, $u)" copy_env_file "$legacy" "$f" "$u"
    else act "créer le modèle $f (600, $u, valeurs vides)" create_env_file "$f" "$u" "$gen"; fi
    return 0
  fi
  cur="$(perm_of "$f")"
  if [[ "$cur" == "$u $u 600" ]]; then ok "$f ($cur)"
  else act "corriger $f : $cur -> $u $u 600" fix_perm "$f" "$u" "$u" 600; fi
}
fill_env() { # fichier, liste « CLÉ:type » ; ne remplit QUE les variables vides ou absentes
  local f="$1" spec k t; shift
  for spec in "$@"; do
    k="${spec%%:*}" t="${spec#*:}"
    if [[ -n "$(env_value "$f" "$k")" ]]; then ok "$(basename "$(dirname "$(dirname "$f")")") $(basename "$f") : $k renseignée"; continue; fi
    if ((!DRY)) && [[ ! -f "$f" ]]; then continue; fi
    act "générer $k dans $f (openssl rand, jamais affiché)" write_secret "$f" "$k" "$t"
  done
}
# Mots de passe Postgres : si le volume de données existe déjà, ses mots de passe ont été fixés à sa création. En
# générer de nouveaux rendrait le .env incohérent avec la base : avertissement, et génération seulement sur
# confirmation explicite (toujours demandée), sinon « reste à faire » (reprendre les anciennes valeurs).
PG_KEYS=(POSTGRES_SUPERUSER_PASSWORD RAIJIN_DB_PASSWORD BENCH_DB_PASSWORD)
write_pg_secret_confirm() {
  printf "  Le volume Docker %s existe déjà : %s a été fixé à sa création. Un nouveau mot de passe ne correspondra pas à la base.\n" "$3" "$2"
  if confirm ask "Générer quand même $2 (déconseillé : reprends plutôt l'ancienne valeur) ?"; then
    write_secret "$1" "$2" hex
  else
    ACT_SKIPPED=1
    TODO+=("$1 : $2 vide alors que le volume $3 existe : reprends l'ancienne valeur (ancien infra/.env de la partie A).")
  fi
}
fill_pg() { # fichier, volume
  local f="$1" vol="$2" k exists=0
  if ((DOCKER_OK)) && docker volume inspect "$vol" >/dev/null 2>&1; then exists=1; fi
  if ((!exists)); then fill_env "$f" "${PG_KEYS[@]/%/:hex}"; return 0; fi
  for k in "${PG_KEYS[@]}"; do
    if [[ -n "$(env_value "$f" "$k")" ]]; then ok "$(basename "$(dirname "$(dirname "$f")")") $(basename "$f") : $k renseignée"; continue; fi
    warn "volume Postgres $vol déjà présent mais $k vide dans $f : mot de passe incohérent si un nouveau est généré."
    if ((!DRY)) && [[ ! -f "$f" ]]; then continue; fi
    act "$k : génération seulement sur confirmation (volume $vol existant)" write_pg_secret_confirm "$f" "$k" "$vol"
  done
}
fill_public() { # fichier, clé, valeur, source
  local f="$1" k="$2" v="$3"
  [[ -n "$(env_value "$f" "$k")" ]] && return 0
  [[ -n "$v" ]] || return 0
  if ((!DRY)) && [[ ! -f "$f" ]]; then return 0; fi
  act "renseigner $k=$v dans $f ($4)" write_value "$f" "$k" "$v"
}
block_env() {
  local e f
  ensure_env_file prod .env tpl_env_prod
  ensure_env_file prod .env.api tpl_api_prod
  ensure_env_file dev .env tpl_env_dev
  ensure_env_file dev .env.api tpl_api_dev
  if [[ -f /opt/raijin/infra/.env.bench-api && ! -e "$BASE/prod/env/.env.bench-api" ]]; then
    act "reprendre /opt/raijin/infra/.env.bench-api dans $BASE/prod/env/ (le banc tourne)" \
      copy_env_file /opt/raijin/infra/.env.bench-api "$BASE/prod/env/.env.bench-api" deploy-prod
  elif [[ -e "$BASE/prod/env/.env.bench-api" ]]; then ok "$BASE/prod/env/.env.bench-api présent (le banc sera déployé)"; fi

  f="$BASE/prod/env/.env"
  fill_pg "$f" raijin-pgdata
  fill_env "$f" REDIS_PASSWORD:hex REDIS_BENCH_PASSWORD:hex
  fill_public "$f" TRAEFIK_NETWORK "$TRAEFIK_NET" "réseau du Traefik détecté (A2)"
  fill_public "$f" TRAEFIK_ENTRYPOINT "$TRAEFIK_EP" "entrypoint :443 détecté"
  fill_public "$f" TRAEFIK_CERTRESOLVER "$TRAEFIK_CR" "certresolver détecté"
  if [[ -n "$REPO" ]]; then
    fill_public "$f" DEPLOY_GITHUB_REPOSITORY "$REPO" "--repo"
    fill_public "$f" DEPLOY_GIT_REMOTE "git@github.com:$REPO.git" "--repo"
  fi
  f="$BASE/dev/env/.env"
  fill_pg "$f" raijin-dev-pgdata
  fill_env "$f" REDIS_PASSWORD:hex
  local mode; mode="$(dev_edge_mode)"
  fill_public "$f" RAIJIN_DEV_EDGE "$mode" "réseau d'entrée du dev, C2"
  if [[ "$mode" == dedicated ]]; then
    fill_public "$f" TRAEFIK_NETWORK "$DEV_EDGE" "option A : réseau propre au dev"
  else
    fill_public "$f" TRAEFIK_NETWORK "$TRAEFIK_NET" "option B : même réseau Traefik que la prod"
  fi
  if [[ -n "$DEV_EDGE_OPT" && -n "$(env_value "$f" RAIJIN_DEV_EDGE)" && "$(env_value "$f" RAIJIN_DEV_EDGE)" != "$DEV_EDGE_OPT" ]]; then
    warn "--dev-edge $DEV_EDGE_OPT mais RAIJIN_DEV_EDGE=$(env_value "$f" RAIJIN_DEV_EDGE) dans $f : rien n'est changé, modifie le fichier toi-même (et TRAEFIK_NETWORK, C2)."
  fi
  local dnet; dnet="$(env_value "$f" TRAEFIK_NETWORK)"
  if [[ "$mode" == traefik-shared && "$dnet" == raijin* ]]; then
    warn "$f : TRAEFIK_NETWORK=$dnet incompatible avec l'option B : mets le réseau du Traefik de la prod${TRAEFIK_NET:+ ($TRAEFIK_NET)} (C2)."
  elif [[ "$mode" == dedicated && -n "$dnet" && "$dnet" != raijin-dev-* ]]; then
    warn "$f : TRAEFIK_NETWORK=$dnet incompatible avec l'option A : mets $DEV_EDGE (C2)."
  fi
  fill_public "$f" TRAEFIK_ENTRYPOINT "$TRAEFIK_EP" "même entrypoint que la prod"
  fill_public "$f" TRAEFIK_CERTRESOLVER "$TRAEFIK_CR" "même certresolver que la prod"
  if [[ -z "$(env_value "$f" DEV_BASIC_AUTH_USERS)" ]]; then
    act "demander le mot de passe du dev (basicAuth, haché bcrypt, jamais affiché)" ask_basic_auth "$f"
  else ok "dev .env : DEV_BASIC_AUTH_USERS renseignée"; fi
  for e in prod dev; do
    f="$BASE/$e/env/.env.api"
    fill_env "$f" JWT_ACCESS_SECRET:b48 IP_HASH_SECRET:b48 COOKIE_SECRET:b32 TOTP_ENCRYPTION_KEY:b32
    local vp vk
    vp="$(env_value "$f" VAPID_PUBLIC_KEY)" vk="$(env_value "$f" VAPID_PRIVATE_KEY)"
    if [[ -z "$vp" && -z "$vk" ]]; then
      if ((DRY)) || [[ -f "$f" ]]; then act "générer la paire VAPID de $e dans $f (propre à $e, jamais affichée)" write_vapid "$f"; fi
    elif [[ -n "$vp" && -n "$vk" ]]; then ok "$e .env.api : paire VAPID renseignée"
    else warn "$f : une seule des deux clés VAPID est renseignée (l'API refuse de démarrer) : complète ou vide les deux."; fi
    vk=''
  done
}

# --- Clés SSH (C5) ----------------------------------------------------------------------------------------------------
pub_line() { # fichier .pub -> « type base64 » validé, ou vide
  local f="$1" n
  [[ -f "$f" ]] || return 0
  n="$(grep -c . "$f" || true)"
  [[ "$n" -eq 1 ]] || return 0
  ssh-keygen -lf "$f" >/dev/null 2>&1 || return 0
  awk '$1 ~ /^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa)$/ && $2 ~ /^[A-Za-z0-9+\/=]+$/ {print $1 " " $2}' "$f"
}
append_key() { # utilisateur, fichier, ligne
  [[ ! -L "$2" && ! -L "$(dirname "$2")" ]] || die "$2 ou son dossier est un lien symbolique : rien n'est modifié."
  if [[ ! -e "$2" ]]; then install -o "$1" -g "$1" -m 600 /dev/null "$2"; fi
  printf '%s\n' "$3" >>"$2"
}
ensure_authorized() { # env (dev | prod), fichier .pub, argument de la porte, commentaire
  local u="deploy-$1" src="$2" arg="$3" comment="$4" home ak key line cur
  home="$(home_of "$u")" ak="$(home_of "$u")/.ssh/authorized_keys"
  if [[ -L "$home/.ssh" || -L "$ak" ]]; then
    warn "$ak (ou ~$u/.ssh) est un lien symbolique : refusé, à remplacer par un vrai fichier à la main."; return 0
  fi
  if [[ -z "$src" ]]; then
    if [[ -s "$ak" ]] && grep -q "command=\"$GATE/infra/deploy-gate.sh $arg\"" "$ak"; then ok "$ak : clé à commande forcée présente"
    else todo "clé publique de $u non fournie (--keys ou --$1-key) : lance infra/vps-install.sh depuis ton PC (C5)."; fi
    return 0
  fi
  key="$(pub_line "$src")"
  [[ -n "$key" ]] || { warn "$src n'est pas une clé publique OpenSSH valide (une seule ligne) : ignorée."; return 0; }
  line="restrict,command=\"$GATE/infra/deploy-gate.sh $arg\" $key $comment"
  if [[ -f "$ak" ]] && grep -qxF "$line" "$ak"; then
    ok "$ak : clé $comment (restrict, command=… $arg)"
  elif [[ -f "$ak" ]] && grep -qF " ${key#* }" "$ak"; then
    warn "$ak contient déjà cette clé avec d'autres options : vérifie-la à la main (le script ne supprime rien)."
    return 0
  else
    if ((!DRY)) && [[ ! -d "$home/.ssh" ]]; then printf '  [passé]    %s (dossier .ssh absent)\n' "$ak"; return 0; fi
    act "ajouter à $ak : restrict,command=\"…/deploy-gate.sh $arg\" $comment" append_key "$u" "$ak" "$line"
  fi
  if [[ -f "$ak" ]]; then
    cur="$(perm_of "$ak")"
    [[ "$cur" == "$u $u 600" ]] || act "corriger $ak : $cur -> $u $u 600" fix_perm "$ak" "$u" "$u" 600
    if grep -vE '^[[:space:]]*(#|$)' "$ak" | grep -vq '^restrict,command="'; then
      warn "$ak contient une autre clé sans commande forcée : vérifie-la (le script ne supprime rien)."
    fi
  fi
}
install_ro_key() {
  [[ ! -L "$2" && ! -L "$(dirname "$2")" ]] || die "$2 ou son dossier est un lien symbolique : rien n'est modifié."
  backup_file "$2"; install -o deploy-prod -g deploy-prod -m 600 "$1" "$2"; }
install_github_known() {
  local tmp; tmp="$(mktemp)"
  ssh-keyscan -t ed25519 github.com 2>/dev/null >"$tmp" || true
  if ! ssh-keygen -lf "$tmp" 2>/dev/null | grep -qF "$GITHUB_ED25519_FP"; then
    rm -f -- "$tmp"; ACT_SKIPPED=1
    printf "  [ATTENTION] github.com injoignable ou empreinte différente de celle publiée par GitHub : rien n'est installé.\n"
    TODO+=("empreinte de github.com non enregistrée (réseau ?) : relance le script.")
    return 0
  fi
  [[ ! -L "$1" && ! -L "$(dirname "$1")" ]] || { rm -f -- "$tmp"; die "$1 ou son dossier est un lien symbolique : rien n'est modifié."; }
  install -o deploy-prod -g deploy-prod -m 644 "$tmp" "$1"
  rm -f -- "$tmp"
}
block_keys() {
  ensure_authorized dev "$DEV_KEY" dev github-raijin-deploy-dev
  ensure_authorized prod "$PROD_KEY" prod-depot github-raijin-depot-prod
  local ssh_dir dst kh
  ssh_dir="$(home_of deploy-prod)/.ssh" dst="$(home_of deploy-prod)/.ssh/github_readonly" kh="$(home_of deploy-prod)/.ssh/known_hosts_github"
  if [[ -L "$ssh_dir" || -L "$dst" || -L "$kh" ]]; then
    warn "$ssh_dir, $dst ou $kh est un lien symbolique : refusé (clé de lecture non installée)."; return 0
  fi
  if [[ -n "$RO_KEY" ]]; then
    if ! ssh-keygen -y -f "$RO_KEY" >/dev/null 2>&1; then warn "$RO_KEY n'est pas une clé privée OpenSSH lisible sans phrase de passe."
    elif [[ -f "$dst" ]] && cmp -s "$RO_KEY" "$dst"; then ok "$dst (clé de lecture du dépôt)"
    elif ((!DRY)) && [[ ! -d "$ssh_dir" ]]; then printf '  [passé]    %s (dossier .ssh absent)\n' "$dst"
    elif [[ -f "$dst" ]]; then act "remplacer $dst par la clé fournie (ancienne gardée dans $BACKUPS)" install_ro_key "$RO_KEY" "$dst"
    else act "installer la clé de lecture du dépôt dans $dst (600, deploy-prod)" install_ro_key "$RO_KEY" "$dst"; fi
  elif [[ -f "$dst" ]]; then ok "$dst présente"
  else todo "clé de lecture du dépôt absente (--readonly-key) : nécessaire pour --approve (C5 étape 3)."; fi
  if [[ -f "$kh" ]]; then
    if ssh-keygen -lf "$kh" 2>/dev/null | grep -qF "$GITHUB_ED25519_FP"; then ok "$kh (empreinte GitHub vérifiée)"
    else warn "$kh ne contient pas l'empreinte ed25519 publiée par GitHub : vérifie-le (C5 étape 3)."; fi
  elif ((!DRY)) && [[ ! -d "$ssh_dir" ]]; then printf '  [passé]    %s (dossier .ssh absent)\n' "$kh"
  else act "enregistrer l'empreinte de github.com dans $kh (comparée à $GITHUB_ED25519_FP)" install_github_known "$kh"; fi
}

# --- Docker : réseau d'entrée du dev (C2) -----------------------------------------------------------------------------
block_network() {
  if [[ "$(dev_edge_mode)" != dedicated ]]; then
    info "option B (RAIJIN_DEV_EDGE=traefik-shared) : aucun réseau à créer, le dev rejoint le réseau du Traefik existant."
    return 0
  fi
  ((DOCKER_OK)) || { todo "Docker indisponible : réseau $DEV_EDGE à créer plus tard (relance le script)."; return 0; }
  if docker network inspect "$DEV_EDGE" >/dev/null 2>&1; then ok "réseau Docker $DEV_EDGE"
  else act "créer le réseau Docker $DEV_EDGE (propre au dev)" docker network create "$DEV_EDGE"; fi
}
block_traefik() { # constats ; option A seulement : « docker network connect » sur le Traefik de MTC (toujours demandé)
  ((DOCKER_OK)) || return 0
  if [[ -z "$TRAEFIK" ]]; then
    if [[ -n "$TRAEFIK_CANDIDATES" ]]; then todo "plusieurs conteneurs Traefik ($(printf '%s ' $TRAEFIK_CANDIDATES)) : relance avec --traefik <nom>."
    else todo "conteneur Traefik introuvable : relance avec --traefik <nom> (A2)."; fi
    return 0
  fi
  info "Traefik : $TRAEFIK ; réseaux : $(printf '%s ' $TRAEFIK_NETS); entrypoint :443 : ${TRAEFIK_EP:-non détecté} ; certresolver : ${TRAEFIK_CR:-non détecté}"
  [[ -n "$TRAEFIK_EP" ]] || todo "entrypoint HTTPS non détecté (configuration en fichier ?) : renseigne TRAEFIK_ENTRYPOINT (A2) dans les deux .env."
  [[ -n "$TRAEFIK_CR" ]] || todo "certresolver non détecté : renseigne TRAEFIK_CERTRESOLVER (A2) dans les deux .env."
  [[ -n "$TRAEFIK_NET" ]] || todo "réseau de Traefik à choisir : renseigne TRAEFIK_NETWORK (A2) dans $BASE/prod/env/.env."
  if [[ "$(dev_edge_mode)" != dedicated ]]; then
    ok "option B : le conteneur Traefik ($TRAEFIK) n'est pas modifié ; le dev utilise ${TRAEFIK_NET:-son réseau (à choisir)}"
    if printf '%s\n' "$TRAEFIK_NETS_ALL" | grep -qx "$DEV_EDGE"; then
      info "Traefik est encore relié à $DEV_EDGE (option A d'une installation précédente) : rien n'est retiré automatiquement (C2)."
    fi
    return 0
  fi
  if docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$TRAEFIK" | tr ' ' '\n' | grep -qx "$DEV_EDGE"; then
    ok "Traefik ($TRAEFIK) relié à $DEV_EDGE"
  elif ! docker network inspect "$DEV_EDGE" >/dev/null 2>&1 && ((!DRY)); then
    printf '  [passé]    réseau %s absent\n' "$DEV_EDGE"
  else
    act "option A : docker network connect $DEV_EDGE $TRAEFIK (modifie le conteneur Traefik de MTC, ta décision ; à refaire si Traefik est recréé)" \
      docker network connect "$DEV_EDGE" "$TRAEFIK"
  fi
}

# --- Unités systemd des sauvegardes et de la veille (C3, facultatif) ---------------------------------------------------
dropin_content() {
  printf '# Raijin Shield (infra/vps-setup.sh) : copies figées et fichiers de /srv/raijin/prod/env (docs/DEPLOY.md C3)\n'
  printf '[Service]\nUser=root\nWorkingDirectory=/opt/raijin-deploy\n'
  printf 'Environment=RAIJIN_ENV_FILE=/srv/raijin/prod/env/.env RAIJIN_API_ENV_FILE=/srv/raijin/prod/env/.env.api\n'
  printf 'ExecStart=\nExecStart=/opt/raijin-deploy/infra/%s\n' "$1"
}
install_dropin() {
  install -d -o root -g root -m 755 "/etc/systemd/system/$1.service.d"
  local f="/etc/systemd/system/$1.service.d/raijin-deploy.conf"
  backup_file "$f"
  dropin_content "$2" >"$f"; chmod 644 "$f"
  systemctl daemon-reload
}
block_systemd() {
  have systemctl || return 0
  local unit script f tmp
  for unit in raijin-backup:backup.sh raijin-watchdog:watchdog.sh; do
    script="${unit#*:}" unit="${unit%%:*}"
    if ! systemctl cat "$unit.service" >/dev/null 2>&1; then info "$unit.service non installée (A9 / A11) : rien à adapter."; continue; fi
    f="/etc/systemd/system/$unit.service.d/raijin-deploy.conf"
    tmp="$(mktemp)"; dropin_content "$script" >"$tmp"
    if [[ -f "$f" ]] && cmp -s "$tmp" "$f"; then ok "$unit.service pointe vers les copies figées"
    else act "faire pointer $unit.service vers $GATE/infra/$script et $BASE/prod/env (surcharge systemd)" install_dropin "$unit" "$script"; fi
    rm -f -- "$tmp"
  done
  if [[ -d /var/backups/raijin && "$(stat -c '%U' /var/backups/raijin)" != root ]]; then
    act "donner /var/backups/raijin à root (sauvegardes lancées en root, C3)" chown root: /var/backups/raijin
  fi
}

# --- Vérifications (C2, C5) : lecture seule ---------------------------------------------------------------------------
block_verify() {
  local u st
  for u in deploy-dev deploy-prod; do
    user_exists "$u" || continue
    st="$(passwd -S "$u" 2>/dev/null | awk '{print $2}')"
    [[ "$st" == L || "$st" == LK ]] && ok "passwd -S $u : $st (aucun mot de passe)" || warn "passwd -S $u : « $st » au lieu de « L »."
    if ((DOCKER_OK)); then
      if runuser -u "$u" -- docker ps >/dev/null 2>&1; then warn "$u peut lancer docker directement (groupe docker ?) : C2 non respecté."
      else ok "$u ne peut pas lancer docker directement"; fi
    fi
  done
  if user_exists deploy-dev && [[ -d "$BASE/prod" ]]; then
    if runuser -u deploy-dev -- ls "$BASE/prod" >/dev/null 2>&1; then warn "deploy-dev peut lire $BASE/prod : la porte refusera le dev."
    else ok "deploy-dev ne peut pas lire $BASE/prod"; fi
  fi
  if have sshd; then
    local t ae pue au ag
    t="$(sshd -T 2>/dev/null || true)"
    if [[ -z "$t" ]]; then todo "sshd -T n'a rien renvoyé : vérifie AcceptEnv à la main (C2)."
    else
      ae="$(printf '%s\n' "$t" | awk 'tolower($1)=="acceptenv" {$1=""; print}' | xargs || true)"
      pue="$(printf '%s\n' "$t" | awk 'tolower($1)=="permituserenvironment" {print $2}')"
      au="$(printf '%s\n' "$t" | awk 'tolower($1)=="allowusers" {$1=""; print}' | xargs || true)"
      ag="$(printf '%s\n' "$t" | awk 'tolower($1)=="allowgroups" {$1=""; print}' | xargs || true)"
      if printf '%s\n' "$ae" | tr ' ' '\n' | grep -v -x 'LC_\*' | grep -qE '(\*|^RAIJIN)'; then warn "sshd AcceptEnv accepte des variables RAIJIN_* ou * (« $ae ») : limite-le à LANG LC_* (C2)."
      else ok "sshd AcceptEnv : ${ae:-aucune}"; fi
      [[ "$pue" == no ]] && ok "sshd PermitUserEnvironment no" || warn "sshd PermitUserEnvironment « $pue » : mets « no » (C2)."
      if [[ -n "$au" ]] && ! { printf '%s\n' "$au" | tr ' ' '\n' | grep -qx deploy-dev && printf '%s\n' "$au" | tr ' ' '\n' | grep -qx deploy-prod; }; then
        todo "sshd AllowUsers (« $au ») : ajoute deploy-dev et deploy-prod, puis sudo sshd -t && sudo systemctl reload ssh (C2)."
      fi
      [[ -z "$ag" ]] || todo "sshd AllowGroups (« $ag ») : vérifie que deploy-dev et deploy-prod y sont autorisés (C2)."
    fi
  else
    todo "sshd introuvable sur cette machine : vérifications SSH non faites."
  fi
  if [[ -f /etc/ssh/ssh_host_ed25519_key.pub ]]; then
    info "empreinte SSH du VPS (à comparer à DEPLOY_KNOWN_HOSTS) : $(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}')"
  fi
  # git ls-remote avec la clé de lecture (C5 étape 3), seulement si tout est en place.
  local hp remote
  hp="$(home_of deploy-prod)" remote="$(env_value "$BASE/prod/env/.env" DEPLOY_GIT_REMOTE)"
  if user_exists deploy-prod && [[ -f "$hp/.ssh/github_readonly" && -f "$hp/.ssh/known_hosts_github" && -n "$remote" ]] && have git; then
    if runuser -u deploy-prod -- env GIT_SSH_COMMAND="ssh -F none -i $hp/.ssh/github_readonly -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$hp/.ssh/known_hosts_github -o ConnectTimeout=15" \
      timeout 30 git ls-remote "$remote" refs/heads/main >/dev/null 2>&1; then ok "git ls-remote de main avec la clé de lecture"
    else todo "git ls-remote refusé : ajoute la clé de lecture dans GitHub (Settings → Deploy keys, SANS écriture), puis relance --check."; fi
  fi
}

# --- Variables restant à remplir (noms seulement, jamais de valeur) ---------------------------------------------------
hint() {
  case "$1" in
    TRAEFIK_*) echo "A2 (docker inspect du Traefik)" ;;
    DEPLOY_GIT*) echo "--repo <compte>/raijin" ;;
    HELIUS_API_KEY) echo "https://dashboard.helius.dev/api-keys" ;;
    RESEND_API_KEY) echo "https://resend.com/api-keys" ;;
    STRIPE_SECRET_KEY|STRIPE_PRICE_*) echo "https://dashboard.stripe.com/test/apikeys et /test/products" ;;
    STRIPE_WEBHOOK_SECRET) echo "Stripe → Webhooks (A7 prod, C3 dev)" ;;
    GA4_PROPERTY_ID|GOOGLE_SERVICE_ACCOUNT_JSON|SEARCH_CONSOLE_SITE_URL) echo "partie B, sections 2 à 4" ;;
    WATCHDOG_ALERT_EMAIL) echo "ton adresse (A11)" ;;
    DEV_BASIC_AUTH_USERS) echo "relance --apply (mot de passe demandé) ou htpasswd -nBC 12, ENTRE APOSTROPHES" ;;
    *) echo "docs/ENV.md" ;;
  esac
}
report_env() {
  local f k opt line
  title "Variables à remplir par toi (noms seulement)"
  for line in \
    "prod/env/.env|TRAEFIK_NETWORK TRAEFIK_ENTRYPOINT TRAEFIK_CERTRESOLVER DEPLOY_GITHUB_REPOSITORY DEPLOY_GIT_REMOTE WATCHDOG_ALERT_EMAIL|BACKUP_RCLONE_REMOTE GA4_MEASUREMENT_ID GOOGLE_SITE_VERIFICATION BENCH_BASIC_AUTH_USERS" \
    "prod/env/.env.api|RESEND_API_KEY HELIUS_API_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PRICE_PRO_MONTHLY STRIPE_PRICE_PRO_YEARLY|GA4_PROPERTY_ID GOOGLE_SERVICE_ACCOUNT_JSON SEARCH_CONSOLE_SITE_URL SENTRY_DSN_API" \
    "dev/env/.env|TRAEFIK_NETWORK TRAEFIK_ENTRYPOINT TRAEFIK_CERTRESOLVER DEV_BASIC_AUTH_USERS|" \
    "dev/env/.env.api||HELIUS_API_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PRICE_PRO_MONTHLY STRIPE_PRICE_PRO_YEARLY SENTRY_DSN_API"; do
    f="$BASE/${line%%|*}"
    local req="${line#*|}"; opt="${req#*|}"; req="${req%%|*}"
    for k in $req $opt; do
      [[ -n "$(env_value "$f" "$k")" ]] && continue
      [[ "$k" == TRAEFIK_ENTRYPOINT && -n "$TRAEFIK_EP" && ! -f "$f" ]] && continue
      [[ "$k" == TRAEFIK_CERTRESOLVER && -n "$TRAEFIK_CR" && ! -f "$f" ]] && continue
      [[ "$k" == TRAEFIK_NETWORK && -n "$TRAEFIK_NET" && ! -f "$f" ]] && continue
      [[ "$k" == DEPLOY_GIT* && -n "$REPO" && ! -f "$f" ]] && continue
      if [[ " $opt " == *" $k "* ]]; then printf '  (facultatif) %-28s %-26s %s\n' "${line%%|*}" "$k" "$(hint "$k")"
      else printf '  %-41s %-26s %s\n' "${line%%|*}" "$k" "$(hint "$k")"; TODO+=("$f : $k"); fi
    done
  done
  printf '  Édition : sudo -u deploy-prod nano %s/prod/env/.env.api   (ou deploy-dev pour le dev ; garde les droits 600)\n' "$BASE"
}

summary() {
  title "Résumé"
  printf 'Fait (%d) :\n' "${#DONE[@]}"; local x
  for x in "${DONE[@]}"; do printf '  - %s\n' "$x"; done
  printf 'Déjà en place : %d élément(s).\n' "${#ALREADY[@]}"
  if ((${#SKIPPED[@]})); then printf 'Blocs non appliqués :\n'; for x in "${SKIPPED[@]}"; do printf '  - %s\n' "$x"; done; fi
  printf 'Reste à faire (%d) :\n' "${#TODO[@]}"
  for x in "${TODO[@]}"; do printf '  - %s\n' "$x"; done
  cat <<'EOF'
Sur GitHub (dépôt raijin → Settings → Secrets and variables → Actions ; bash infra/vps-install.sh les prépare) :
  - secret DEPLOY_SSH_KEY_DEV   : clé privée raijin-deploy-dev
  - secret DEPOT_SSH_KEY_PROD   : clé privée raijin-depot-prod (dépôt seulement)
  - secret DEPLOY_KNOWN_HOSTS   : ssh-keyscan -t ed25519 <adresse du VPS> (empreinte affichée plus haut)
  - variable DEPLOY_HOST        : adresse IPv4 du VPS
  - Deploy key vps-raijin-lecture (SANS écriture) : raijin-github-readonly.pub
  - Settings → Actions → General → Workflow permissions : lecture seule ; supprime l'ancien secret DEPLOY_SSH_KEY_PROD
EOF
}

run_all() {
  printf 'Raijin Shield — installation du VPS (docs/DEPLOY.md partie C) — mode %s%s\n' "$MODE" "$( ((YES_SAFE)) && printf ' (blocs sûrs sans question)')"
  [[ "$MODE" == check ]] && printf 'Aucune écriture dans ce mode.\n'
  DONE=() ALREADY=() TODO=() SKIPPED=()
  run_block "Prérequis (A1, C1)" safe block_prereq
  run_block "Paquets" safe block_packages
  run_block "Utilisateurs deploy-dev et deploy-prod (C2)" safe block_users
  run_block "Groupes interdits (C2)" ask block_groups
  run_block "Dossiers et verrou (C2)" safe block_dirs
  run_block "Scripts figés /opt/raijin-deploy (C4, C8)" safe block_frozen
  run_block "Règles sudo (C2, C6)" safe block_sudoers
  run_block "Fichiers de variables (C3)" safe block_env
  run_block "Clés SSH et GitHub (C5)" safe block_keys
  run_block "Réseau d'entrée du dev (C2, option $(dev_edge_mode))" safe block_network
  run_block "Traefik et réseau du dev (C2 ; option A : toujours demandé)" ask block_traefik
  run_block "Sauvegardes et veille systemd (C3, toujours demandé)" ask block_systemd
  run_block "Vérifications (C2, C5)" safe block_verify
  report_env
  summary
}

detect_docker
if ((PREVIEW_APPLY)); then
  MODE=check; run_all
  printf '\n'
  if [[ -t 0 ]] && { r=''; read -r -p "Continuer et appliquer (blocs sûrs sans question, les autres demandés) ? (o/N) " r || true; [[ "$r" =~ ^[oOyY]$ ]]; }; then
    MODE=apply YES_SAFE=1; printf '\n'; run_all
  else
    printf 'Rien n%sa été modifié.\n' "'"
  fi
else
  run_all
fi
