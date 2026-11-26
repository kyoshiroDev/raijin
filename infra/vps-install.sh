#!/usr/bin/env bash
# Lanceur côté PC de l'installation du VPS (docs/DEPLOY.md partie C, « Méthode la plus simple »). À lancer PAR TOI,
# depuis la racine du dépôt, sur ton PC :
#
#   bash infra/vps-install.sh            # aperçu sur le VPS, puis « Continuer ? (o/N) », puis installation
#   bash infra/vps-install.sh --check    # aperçu seulement (rien n'est modifié sur le VPS, aucune clé générée)
#
# Options : --host <adresse> (sinon DEPLOY_HOST de l'environnement, sinon demandée), --user <ssh> (défaut greg),
#           --port <port> (défaut DEPLOY_PORT ou 22).
#
# Ce qu'il fait :
#   1. génère au besoin sur le PC (~/.ssh, droits 600, sans phrase de passe) : raijin-deploy-dev (clé du dev pour
#      GitHub Actions), raijin-depot-prod (dépôt de la prod seulement), raijin-github-readonly (lecture du dépôt) ;
#   2. prépare une archive : les scripts figés de infra/ (copie de ton dépôt local) et les clés publiques, plus la
#      clé de lecture (seule clé privée qui va sur le VPS, pour « git ls-remote ») ;
#   3. la copie par scp dans un dossier temporaire du VPS (supprimé à la fin), puis lance
#      « sudo bash infra/vps-setup.sh --preview-apply » : aperçu, « Continuer ? (o/N) », puis application des blocs
#      sûrs ; « docker network connect » sur Traefik reste toujours demandé. Un seul mot de passe sudo à taper ;
#   4. enregistre l'empreinte SSH du VPS (~/.ssh/raijin-known-hosts) après l'avoir comparée à celle lue sur le VPS ;
#   5. affiche la liste numérotée des secrets et variables GitHub, avec les commandes gh prêtes à copier (aucune clé
#      affichée), et propose de les lancer.
# L'adresse du VPS n'est écrite dans aucun fichier du dépôt. Rien n'est fait sur MTC, XMR Trader ni Traefik
# (hors « docker network connect », après confirmation).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

die() { printf '\nERREUR : %s\n' "$*" >&2; exit 1; }
ask_yes() { local r; read -r -p "$1 (o/N) " r || return 1; [[ "$r" =~ ^[oOyY]$ ]]; }

CHECK=0 HOST="${DEPLOY_HOST:-}" SSH_USER=greg PORT="${DEPLOY_PORT:-22}"
while (($#)); do
  case "$1" in
    --check) CHECK=1 ;;
    --host) HOST="${2:-}"; shift ;;
    --user) SSH_USER="${2:-}"; shift ;;
    --port) PORT="${2:-}"; shift ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "option inconnue : $1 (--help)" ;;
  esac
  shift
done

for c in ssh scp ssh-keygen ssh-keyscan tar git; do command -v "$c" >/dev/null || die "commande absente sur le PC : $c"; done
[[ -t 0 ]] || die "lance ce script dans un terminal (il pose des questions)."

if [[ -z "$HOST" ]]; then read -r -p "Adresse IPv4 (ou nom) du VPS : " HOST || true; fi
[[ "$HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || die "adresse du VPS invalide."
read -r -p "Utilisateur SSH sur le VPS [$SSH_USER] : " r || true
SSH_USER="${r:-$SSH_USER}"
[[ "$SSH_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "utilisateur SSH invalide."
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || die "port SSH invalide."

remote_url="$(git remote get-url origin 2>/dev/null || true)"
REPO="$(printf '%s' "$remote_url" | sed -nE 's#^(git@github\.com:|ssh://git@github\.com/|https://github\.com/)##p')"
REPO="${REPO%/}"; REPO="${REPO%.git}"
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "dépôt GitHub introuvable (git remote origin)."

FROZEN=(infra/vps-setup.sh infra/deploy-gate.sh infra/docker-priv.sh infra/release.sh infra/backup.sh infra/watchdog.sh
  infra/lib/common.sh infra/lib/deploy_policy.py)
for f in "${FROZEN[@]}"; do [[ -f "$f" ]] || die "fichier manquant : $f"; done
branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ -n "$(git status --porcelain -- "${FROZEN[@]}")" ]]; then
  printf 'ATTENTION : des scripts copiés sur le VPS ont des modifications non commitées.\n'
fi
if [[ "$branch" != main ]]; then
  printf 'ATTENTION : branche « %s ». Les scripts figés du VPS doivent normalement venir de main, après relecture (C4).\n' "$branch"
fi

printf '\nVPS : %s@%s (port %s) · dépôt GitHub : %s · mode : %s\n' "$SSH_USER" "$HOST" "$PORT" "$REPO" \
  "$( ((CHECK)) && echo 'aperçu seulement' || echo 'aperçu puis installation')"

# --- 1. Clés sur le PC -------------------------------------------------------------------------------------------------
KD="$HOME/.ssh"
declare -A COMMENT=([raijin-deploy-dev]=github-raijin-deploy-dev [raijin-depot-prod]=github-raijin-depot-prod
  [raijin-github-readonly]=vps-raijin-lecture)
printf '\n== Clés SSH sur ton PC (%s) ==\n' "$KD"
for k in raijin-deploy-dev raijin-depot-prod raijin-github-readonly; do
  if [[ -f "$KD/$k" && -f "$KD/$k.pub" ]]; then
    printf '  [en place] %s\n' "$KD/$k"
  elif ((CHECK)); then
    printf '  [à faire]  générer %s (ed25519, sans phrase de passe)\n' "$KD/$k"
  else
    [[ ! -e "$KD/$k" ]] || die "$KD/$k existe sans $k.pub : rien n'est écrasé, vérifie à la main."
    install -d -m 700 "$KD"
    ssh-keygen -q -t ed25519 -N '' -C "${COMMENT[$k]}" -f "$KD/$k"
    chmod 600 "$KD/$k"
    printf '  [fait]     %s généré\n' "$KD/$k"
  fi
done

# --- 2. Archive --------------------------------------------------------------------------------------------------------
umask 077
DEST="$SSH_USER@$HOST"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/rj.XXXXXX")"
trap 'ssh -o ControlPath="$TMP/cm" -O exit "$DEST" >/dev/null 2>&1 || true; rm -rf -- "$TMP"' EXIT
mkdir -p "$TMP/stage/infra/lib" "$TMP/stage/keys"
for f in "${FROZEN[@]}"; do cp -- "$f" "$TMP/stage/$f"; done
for k in raijin-deploy-dev raijin-depot-prod raijin-github-readonly; do
  [[ -f "$KD/$k.pub" ]] && cp -- "$KD/$k.pub" "$TMP/stage/keys/"
done
if ((!CHECK)) && [[ -f "$KD/raijin-github-readonly" ]]; then cp -- "$KD/raijin-github-readonly" "$TMP/stage/keys/"; fi
tar -C "$TMP/stage" -cf "$TMP/raijin-setup.tar" .

# --- 3. Copie et lancement sur le VPS (une seule connexion SSH, multiplexée) -------------------------------------------
SSHO=(-p "$PORT" -o ControlMaster=auto -o ControlPath="$TMP/cm" -o ControlPersist=600)
printf '\n== Connexion au VPS ==\n'
remote_dir="$(ssh "${SSHO[@]}" "$DEST" 'mktemp -d "$HOME/.raijin-setup.XXXXXX"')"
[[ "$remote_dir" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "dossier temporaire distant inattendu."
scp -q -P "$PORT" -o ControlPath="$TMP/cm" "$TMP/raijin-setup.tar" "$DEST:$remote_dir/"
mode='--preview-apply'; ((CHECK)) && mode='--check'
printf 'Le mot de passe demandé est celui de sudo sur le VPS (compte %s).\n' "$SSH_USER"
set +e
ssh -t "${SSHO[@]}" "$DEST" "cd '$remote_dir' && tar -xf raijin-setup.tar && sudo bash infra/vps-setup.sh $mode --keys keys --repo '$REPO'; rc=\$?; rm -rf -- '$remote_dir'; exit \$rc"
rc=$?
set -e
((rc == 0)) || printf '\nATTENTION : vps-setup.sh s%sest terminé avec le code %s (voir ci-dessus).\n' "'" "$rc"

# --- 4. Empreinte du VPS -----------------------------------------------------------------------------------------------
printf '\n== Empreinte SSH du VPS (secret DEPLOY_KNOWN_HOSTS) ==\n'
ssh-keyscan -p "$PORT" -t ed25519 "$HOST" 2>/dev/null >"$TMP/kh" || true
fp_scan="$(ssh-keygen -lf "$TMP/kh" 2>/dev/null | awk '{print $2}' | head -1)"
fp_vps="$(ssh "${SSHO[@]}" "$DEST" 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub' 2>/dev/null | awk '{print $2}' | head -1)"
KH_OK=0
if [[ -n "$fp_scan" && "$fp_scan" == "$fp_vps" ]]; then
  KH_OK=1
  printf '  empreinte vérifiée : %s\n' "$fp_scan"
  if ((!CHECK)); then install -m 600 "$TMP/kh" "$KD/raijin-known-hosts"; printf '  [fait]     %s\n' "$KD/raijin-known-hosts"; fi
else
  printf '  [ATTENTION] empreintes différentes ou illisibles (scan : %s, VPS : %s) : DEPLOY_KNOWN_HOSTS non préparé.\n' "${fp_scan:-?}" "${fp_vps:-?}"
fi

# --- 5. GitHub ---------------------------------------------------------------------------------------------------------
cat <<EOF

== À créer dans GitHub : dépôt $REPO → Settings → Secrets and variables → Actions ==
Commandes prêtes à copier (gh lit les fichiers, aucune clé n'est affichée) :
  1. Secret DEPLOY_SSH_KEY_DEV (clé privée du dev) :
       gh secret set DEPLOY_SSH_KEY_DEV --repo $REPO < ~/.ssh/raijin-deploy-dev
  2. Secret DEPOT_SSH_KEY_PROD (clé privée de DÉPÔT de la prod) :
       gh secret set DEPOT_SSH_KEY_PROD --repo $REPO < ~/.ssh/raijin-depot-prod
  3. Secret DEPLOY_KNOWN_HOSTS (empreinte du VPS) :
       gh secret set DEPLOY_KNOWN_HOSTS --repo $REPO < ~/.ssh/raijin-known-hosts
  4. Variable DEPLOY_HOST (adresse du VPS) :
       gh variable set DEPLOY_HOST --repo $REPO --body '$HOST'
  5. Deploy key en LECTURE SEULE (Settings → Deploy keys) :
       gh repo deploy-key add ~/.ssh/raijin-github-readonly.pub --repo $REPO --title vps-raijin-lecture
  6. Workflows en lecture seule, sans approbation de PR (Settings → Actions → General) :
       gh api -X PUT repos/$REPO/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
  7. Ancien secret à supprimer s'il existe (plus aucune clé de déploiement de prod dans GitHub) :
       gh secret delete DEPLOY_SSH_KEY_PROD --repo $REPO
EOF
if [[ "$SSH_USER" != greg || "$PORT" != 22 ]]; then
  printf '  8. Seulement si différents des défauts : gh variable set DEPLOY_PORT --repo %s --body %s\n' "$REPO" "$PORT"
fi
printf '  Facultatif : gh variable set GA4_MEASUREMENT_ID / GOOGLE_SITE_VERIFICATION (valeurs publiques de la landing).\n'

if ((!CHECK)) && command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  printf '\n'
  if ask_yes "Lancer maintenant les commandes 1 à 7 avec gh ?"; then
    gh secret set DEPLOY_SSH_KEY_DEV --repo "$REPO" <"$KD/raijin-deploy-dev"
    gh secret set DEPOT_SSH_KEY_PROD --repo "$REPO" <"$KD/raijin-depot-prod"
    if ((KH_OK)); then gh secret set DEPLOY_KNOWN_HOSTS --repo "$REPO" <"$KD/raijin-known-hosts"
    else printf '  DEPLOY_KNOWN_HOSTS non créé (empreinte non vérifiée).\n'; fi
    gh variable set DEPLOY_HOST --repo "$REPO" --body "$HOST"
    if gh repo deploy-key list --repo "$REPO" 2>/dev/null | grep -q 'vps-raijin-lecture'; then
      printf '  Deploy key vps-raijin-lecture déjà présente.\n'
    else
      gh repo deploy-key add "$KD/raijin-github-readonly.pub" --repo "$REPO" --title vps-raijin-lecture
    fi
    gh api -X PUT "repos/$REPO/actions/permissions/workflow" -f default_workflow_permissions=read \
      -F can_approve_pull_request_reviews=false >/dev/null
    if gh secret list --repo "$REPO" 2>/dev/null | awk '{print $1}' | grep -qx DEPLOY_SSH_KEY_PROD; then
      ask_yes "Supprimer l'ancien secret DEPLOY_SSH_KEY_PROD ?" && gh secret delete DEPLOY_SSH_KEY_PROD --repo "$REPO"
    fi
    printf '  GitHub configuré.\n'
  fi
fi

cat <<EOF

Ensuite :
  - remplis sur le VPS les variables listées ci-dessus (« Variables à remplir par toi ») ;
  - relance « bash infra/vps-install.sh --check » : il vérifie notamment git ls-remote avec la clé de lecture ;
  - garde les clés ~/.ssh/raijin-* tant que tu en as besoin (relancer ce script réutilise les mêmes) ; une fois tout
    vérifié, tu peux les effacer (shred -u ~/.ssh/raijin-deploy-dev ~/.ssh/raijin-depot-prod ~/.ssh/raijin-github-readonly) :
    un nouveau lancement en générerait d'autres (les anciennes lignes restent dans authorized_keys, toujours restreintes).
EOF
exit "$rc"
