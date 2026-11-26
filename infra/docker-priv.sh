#!/usr/bin/env bash
# =====================================================================================================
# Partie privilégiée du déploiement continu (docs/DEPLOY.md C2, C4). Copie FIGÉE, propriété de root, dans
# /opt/raijin-deploy/infra/. deploy-dev et deploy-prod ne sont PAS dans le groupe docker : c'est le seul accès à Docker,
# par sudo, l'environnement étant fixé par sudoers :
#   deploy-dev  ALL=(root) NOPASSWD: /opt/raijin-deploy/infra/docker-priv.sh dev *
#   deploy-prod ALL=(root) NOPASSWD: /opt/raijin-deploy/infra/docker-priv.sh prod *
#
#   docker-priv.sh <env> sync-init <version utilisateur>   scripts d'init Postgres → dossier stable racine
#   docker-priv.sh <env> import    <version utilisateur>   copie racine (SHA, config résolue, images), contrôle des
#                                                          images, docker load, sortie comparée à la liste attendue
#   docker-priv.sh <env> deploy    <nom de version>        release.sh deploy ; échec → retour à la version en service
#   docker-priv.sh <env> recover   <nom de version>        release.sh recover (dépannage)
#   docker-priv.sh <env> status
# Ne touche qu'aux images <nom>/<image>:<commit>, au projet Compose de l'environnement (fichier résolu seulement) et
# au conteneur <nom>-postgres. Rien n'est lu dans la zone de l'utilisateur sans contrôle (fichier ordinaire, sans lien,
# à son propriétaire).
# =====================================================================================================
set -Eeuo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICY="$DIR/lib/deploy_policy.py"
say() { printf '%s [docker-priv] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
refuse() { say "REFUS : $*" >&2; exit 2; }

# Tests de la CI seulement (GitHub Actions, hors session SSH, RAIJIN_GATE_TEST=1) : dossiers et utilisateur simulés.
test_mode=0
if [[ "${GITHUB_ACTIONS:-}" == true && "${RAIJIN_GATE_TEST:-}" == 1 && -z "${SSH_CONNECTION:-}" && "$(id -u)" != 0 ]]; then
  test_mode=1
fi
if [[ "$test_mode" == 1 ]]; then
  USER_BASE="${RAIJIN_DEPLOY_BASE:-/srv/raijin}" PRIV_BASE="${RAIJIN_PRIV_BASE:-/var/lib/raijin-deploy}"
  caller_uid="$(id -u)"
else
  [[ "$(id -u)" == 0 ]] || refuse "à lancer par sudo (docs/DEPLOY.md C2)."
  USER_BASE=/srv/raijin PRIV_BASE=/var/lib/raijin-deploy
  while read -r v; do unset "$v"; done < <(compgen -v RAIJIN_)
fi

env="${1:-}" cmd="${2:-}" arg="${3:-}"
(( $# <= 3 )) || refuse "trop d'arguments."
[[ "$env" == dev || "$env" == prod ]] || refuse "environnement dev ou prod."
name=raijin; [[ "$env" == dev ]] && name=raijin-dev
if [[ "$test_mode" == 0 ]]; then
  # L'appelant doit être l'utilisateur de CET environnement (deploy-dev pour dev, deploy-prod pour prod).
  [[ -n "${SUDO_UID:-}" && "$(getent passwd "$SUDO_UID" | cut -d: -f1)" == "deploy-$env" ]] || refuse "appelant différent de deploy-$env."
  caller_uid="$SUDO_UID"
fi
ubase="$USER_BASE/$env" pbase="$PRIV_BASE/$env"
mkdir -p "$pbase/releases" "$pbase/state"
chmod 711 "$PRIV_BASE" "$pbase" 2>/dev/null || true
mkdir -p "$pbase/infra-stable/postgres/init"
chmod 755 "$pbase/infra-stable" "$pbase/infra-stable/postgres" "$pbase/infra-stable/postgres/init"

# Version de l'utilisateur : /srv/raijin/<env>/releases/<commit>-<horodatage>, sans lien dans le chemin.
user_rel() {
  local p="$1"
  [[ "$p" =~ ^${ubase//./\\.}/releases/([0-9a-f]{40})-([0-9]{8}T[0-9]{6}Z)$ ]] || refuse "dossier de version invalide."
  [[ "$(readlink -f -- "$p")" == "$p" && -d "$p" && ! -L "$p" ]] || refuse "dossier de version avec lien symbolique."
}
copyin() { python3 "$POLICY" copyin "$1" "$2" "$3" "$caller_uid" >/dev/null || refuse "fichier refusé : $(basename "$1")."; }

case "$cmd" in
  sync-init)
    user_rel "$arg"
    stable="$pbase/infra-stable/postgres/init"
    tmp="$(mktemp -d "$pbase/infra-stable/postgres/.init.XXXXXX")"
    while IFS= read -r -d '' f; do
      copyin "$f" "$tmp/$(basename "$f")" 1048576
    done < <(find "$arg/infra/postgres/init" -mindepth 1 -maxdepth 1 -type f \( -name '*.sh' -o -name '*.sql' \) -print0)
    chmod 755 "$tmp"; find "$tmp" -type f -exec chmod 644 {} +
    find "$stable" -mindepth 1 -maxdepth 1 -type f -delete
    find "$tmp" -mindepth 1 -maxdepth 1 -type f -exec mv -t "$stable" {} +
    rmdir "$tmp"
    say "scripts d'init Postgres en place ($pbase/infra-stable)."
    ;;
  import)
    user_rel "$arg"
    rel_name="$(basename "$arg")"
    sha="${rel_name%%-*}"
    R="$pbase/releases/$rel_name"
    [[ ! -e "$R" ]] || refuse "version déjà importée."
    mkdir -m 700 "$R"
    imported=0
    trap '[[ "$imported" == 1 ]] || rm -r -- "$R"' EXIT
    copyin "$arg/SHA" "$R/SHA" 100
    [[ "$(cat "$R/SHA")" == "$sha" ]] || refuse "SHA incohérent."
    copyin "$arg/compose.resolved.json" "$R/compose.resolved.json" 4194304
    copyin "$arg/images.tar.gz" "$R/images.tar.gz" 4294967296
    python3 "$POLICY" images "$R/images.tar.gz" "$name" "$sha" "$R/expected-images" || refuse "images refusées."
    say "chargement des images…"
    docker load -i "$R/images.tar.gz" | tee "$R/loaded.txt" | sed 's/^/  /'
    rm -- "$R/images.tar.gz"
    python3 "$POLICY" loaded "$R/expected-images" <"$R/loaded.txt" || refuse "docker load a chargé autre chose que les images attendues (C7)."
    imported=1
    say "version $rel_name importée."
    ;;
  deploy|recover)
    [[ "$arg" =~ ^[0-9a-f]{40}-[0-9]{8}T[0-9]{6}Z$ && -f "$pbase/releases/$arg/compose.resolved.json" ]] || refuse "version inconnue."
    R="$pbase/releases/$arg"
    export RAIJIN_DEPLOY_BASE="$USER_BASE" RAIJIN_PRIV_BASE="$PRIV_BASE"
    [[ "$test_mode" == 1 && -n "${RAIJIN_TRAEFIK_ADDR:-}" ]] && export RAIJIN_TRAEFIK_ADDR
    if [[ "$cmd" == recover ]]; then
      "$DIR/release.sh" recover "$env" "$R"
      ln -sfn "$R" "$pbase/current.tmp" && mv -Tf "$pbase/current.tmp" "$pbase/current"
      exit 0
    fi
    previous=''
    [[ -L "$pbase/current" ]] && previous="$(readlink -f "$pbase/current")"
    code=0
    "$DIR/release.sh" deploy "$env" "$R" || code=$?
    if [[ "$code" == 0 ]]; then
      ln -sfn "$R" "$pbase/current.tmp" && mv -Tf "$pbase/current.tmp" "$pbase/current"
      say "version ${arg:0:12} en service ($env)."
    else
      say "ÉCHEC du déploiement de ${arg:0:12} ($env, code $code)."
      if [[ -n "$previous" && -f "$previous/compose.resolved.json" ]]; then
        say "retour automatique à la dernière version réussie ($(basename "$previous"))…"
        if "$DIR/release.sh" recover "$env" "$previous"; then
          say "dernière version réussie remise en service."
        else
          say "le retour automatique a échoué : intervention manuelle (docs/DEPLOY.md C7)."
        fi
      else
        say "aucune version précédente à remettre en service (premier déploiement)."
      fi
    fi
    # Ménage : 5 dernières versions (et celle en service) ; étiquettes <nom>/<image>:<commit> des versions retirées.
    current="$(readlink -f "$pbase/current" 2>/dev/null || true)"
    mapfile -t old < <(find "$pbase/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | awk 'NR>5 {print $2}')
    for d in "${old[@]}"; do
      [[ "$d" == "$current" || "$d" == "$R" ]] && continue
      old_sha="$(basename "$d")"; old_sha="${old_sha%%-*}"
      if [[ "$old_sha" =~ ^[0-9a-f]{40}$ && "$current" != *"/$old_sha-"* && "$arg" != "$old_sha-"* ]]; then
        for img in api web landing migrate bench-api bench-web bench-migrate; do
          docker image rm "$name/$img:$old_sha" >/dev/null 2>&1 || true
        done
      fi
      rm -r -- "$d"
    done
    exit "$code"
    ;;
  status)
    say "en service : $(basename "$(readlink -f "$pbase/current" 2>/dev/null || echo aucune)")"
    tail -n 10 "$pbase/state/raijin/deploy-history" 2>/dev/null || say "aucun déploiement enregistré."
    ;;
  *) refuse "commande inconnue (sync-init, import, deploy, recover, status)." ;;
esac
