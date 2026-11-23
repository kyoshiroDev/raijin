#!/usr/bin/env bash
# =====================================================================================================
# Sauvegarde quotidienne des bases Raijin (PROMPT.md §7) — lancée par le timer systemd raijin-backup.timer
# (ou cron), sur le VPS, par l'utilisateur. Jamais par un agent.
#
#   1. pg_dump (format custom, compressé) de « raijin » et, si elle existe, de « raijin_bench » ;
#   2. vérification de chaque fichier (pg_restore --list) ;
#   3. rotation locale : fichiers de plus de BACKUP_RETENTION_DAYS jours (7 par défaut) supprimés,
#      uniquement dans BACKUP_DIR et uniquement les fichiers raijin*_AAAAMMJJ-HHMMSS.dump ;
#   4. copie hors site par rclone vers BACKUP_RCLONE_REMOTE (bucket B2 dédié, chiffré par un remote
#      « crypt », docs/DEPLOY.md A9). Aucune suppression distante : la rétention du bucket est réglée par
#      une règle de cycle de vie B2 ;
#   5. en cas d'échec : alerte (e-mail Resend + push admin) et code de sortie ≠ 0.
#
# Usage : infra/backup.sh [--no-offsite]
# Variables (infra/.env) : BACKUP_DIR (/var/backups/raijin), BACKUP_RETENTION_DAYS (7),
#   BACKUP_RCLONE_REMOTE (ex. raijin-b2-crypt:postgres ; vide = pas de copie hors site, avertissement).
# =====================================================================================================
set -Eeuo pipefail
umask 077
RAIJIN_SCRIPT=backup
# shellcheck source=infra/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

offsite=1
for arg in "$@"; do
  case "$arg" in
    --no-offsite) offsite=0 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "option inconnue : $arg" ;;
  esac
done

BACKUP_DIR="${BACKUP_DIR:-$(env_get "$RAIJIN_ENV_FILE" BACKUP_DIR)}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/raijin}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-$(env_get "$RAIJIN_ENV_FILE" BACKUP_RETENTION_DAYS)}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
REMOTE="${BACKUP_RCLONE_REMOTE:-$(env_get "$RAIJIN_ENV_FILE" BACKUP_RCLONE_REMOTE)}"

[[ "$RETENTION_DAYS" =~ ^[0-9]+$ && "$RETENTION_DAYS" -ge 1 ]] || die "BACKUP_RETENTION_DAYS invalide."
[[ "$BACKUP_DIR" == /* && "$BACKUP_DIR" != "/" ]] || die "BACKUP_DIR doit être un chemin absolu (pas /)."

on_error() {
  local line="$1"
  warn "échec de la sauvegarde (ligne $line)."
  send_alert "[Raijin] Sauvegarde en échec sur $(hostname)" \
    "La sauvegarde Postgres de Raijin a échoué le $(date '+%Y-%m-%d à %H:%M') (ligne $line de infra/backup.sh). Journal : journalctl -u raijin-backup.service" || true
}
trap 'on_error $LINENO' ERR

require_cmd docker
require_pg_container
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

stamp="$(date -u '+%Y%m%d-%H%M%S')"
dumped=()

for db in raijin raijin_bench; do
  if ! pg_db_exists "$db"; then
    [[ "$db" == raijin ]] && die "la base raijin n'existe pas."
    log "base $db absente (banc non déployé) : ignorée."
    continue
  fi
  file="$BACKUP_DIR/${db}_${stamp}.dump"
  tmp="$file.partial"
  log "sauvegarde de $db…"
  # --no-owner/--no-acl à la restauration ; ici, dump complet de la base (schéma + données).
  pg_exec pg_dump -U postgres -d "$db" --format=custom --compress=6 --no-sync >"$tmp"
  # Contrôle : le fichier doit être lisible par pg_restore et contenir la table des migrations Prisma.
  toc="$(pg_exec pg_restore --list <"$tmp")"
  [[ -n "$toc" ]] || die "fichier de sauvegarde illisible pour $db."
  if [[ "$db" == raijin ]] && ! grep -q '_prisma_migrations' <<<"$toc"; then
    die "la sauvegarde de raijin ne contient pas _prisma_migrations."
  fi
  mv "$tmp" "$file"
  sha256sum "$file" >"$file.sha256"
  log "  $(basename "$file") : $(du -h "$file" | cut -f1)"
  dumped+=("$file")
done

# Rotation locale (seulement nos fichiers, seulement dans BACKUP_DIR).
find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'raijin_[0-9]*-[0-9]*.dump' -o -name 'raijin_bench_[0-9]*-[0-9]*.dump' \
     -o -name 'raijin_[0-9]*-[0-9]*.dump.sha256' -o -name 'raijin_bench_[0-9]*-[0-9]*.dump.sha256' \
     -o -name '*.dump.partial' \) \
  -mtime +"$((RETENTION_DAYS - 1))" -print -delete | sed 's/^/  rotation : supprimé /' || true

# Copie hors site.
if [[ "$offsite" == 1 ]]; then
  if [[ -z "$REMOTE" ]]; then
    warn "BACKUP_RCLONE_REMOTE vide : aucune copie hors site (docs/DEPLOY.md A9)."
  else
    require_cmd rclone
    for f in "${dumped[@]}"; do
      log "copie hors site de $(basename "$f")…"
      rclone copy --no-traverse --retries 3 --low-level-retries 5 "$f" "$REMOTE/"
      rclone copy --no-traverse "$f.sha256" "$REMOTE/"
    done
  fi
fi

# Marqueur de fraîcheur, lu par le watchdog (alerte si la dernière sauvegarde a plus de 26 h).
date -u '+%s' >"$BACKUP_DIR/.last-success"
log "sauvegarde terminée (${#dumped[@]} base(s))."
