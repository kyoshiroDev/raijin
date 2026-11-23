#!/usr/bin/env bash
# =====================================================================================================
# Veille de Raijin (PROMPT.md §7) — lancée toutes les 2 minutes par raijin-watchdog.timer (ou cron), sur le
# VPS, par l'utilisateur. Ne modifie rien : elle lit l'état et alerte.
#
# Contrôles :
#   - conteneurs Raijin (raijin-postgres, raijin-redis, raijin-api, raijin-web, raijin-landing, et ceux du banc
#     s'ils existent) : en marche ET healthcheck « healthy » ;
#   - de l'extérieur (DNS + Traefik + TLS) : https://API_DOMAIN/api/v1/health, https://APP_DOMAIN/,
#     https://LANDING_DOMAIN/ (WATCHDOG_EXTERNAL=0 pour désactiver) ;
#   - disque (≥ WATCHDOG_DISK_PCT %, 85 par défaut) et RAM disponible (< WATCHDOG_MIN_MEM_MB, 200 par défaut) ;
#   - fraîcheur de la dernière sauvegarde (> 26 h).
# Alerte (e-mail Resend + push admin, infra/lib/common.sh) après WATCHDOG_FAILS_BEFORE_ALERT échecs consécutifs
# (2 par défaut, soit ~4 min), rappel toutes les WATCHDOG_REMIND_HOURS heures (6), message de retour à la normale.
#
# Usage : infra/watchdog.sh [--dry-run]   (--dry-run : affiche l'état sans alerter ni écrire l'état)
# =====================================================================================================
set -Euo pipefail
RAIJIN_SCRIPT=watchdog
# shellcheck source=infra/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

dry_run=0
[[ "${1:-}" == "--dry-run" ]] && dry_run=1

# Valeur : variable d'environnement du processus, sinon infra/.env, sinon défaut.
cfg() { local v="${!1:-}"; [[ -n "$v" ]] || v="$(env_get "$RAIJIN_ENV_FILE" "$1")"; printf '%s' "${v:-$2}"; }
STATE_DIR="$(cfg WATCHDOG_STATE_DIR /var/lib/raijin-watchdog)"
FAILS_BEFORE_ALERT="$(cfg WATCHDOG_FAILS_BEFORE_ALERT 2)"
REMIND_HOURS="$(cfg WATCHDOG_REMIND_HOURS 6)"
DISK_PCT="$(cfg WATCHDOG_DISK_PCT 85)"
MIN_MEM_MB="$(cfg WATCHDOG_MIN_MEM_MB 200)"
EXTERNAL="$(cfg WATCHDOG_EXTERNAL 1)"
BACKUP_DIR="$(cfg BACKUP_DIR /var/backups/raijin)"
API_DOMAIN="$(cfg API_DOMAIN api.raijinshield.com)"
APP_DOMAIN="$(cfg APP_DOMAIN app.raijinshield.com)"
LANDING_DOMAIN="$(cfg LANDING_DOMAIN raijinshield.com)"

require_cmd docker
for v in FAILS_BEFORE_ALERT REMIND_HOURS DISK_PCT MIN_MEM_MB; do
  [[ "${!v}" =~ ^[0-9]+$ ]] || die "WATCHDOG_$v doit être un entier positif."
done
[[ "$dry_run" == 1 ]] || mkdir -p "$STATE_DIR"

declare -a problems=() recovered=() reminders=()
now="$(date +%s)"

# Enregistre le résultat d'un contrôle et décide s'il faut alerter.
record() {
  local key="$1" ok="$2" message="$3" file count alerted last
  file="$STATE_DIR/$key.state"
  count=0 alerted=0 last=0
  [[ -r "$file" ]] && read -r count alerted last <"$file"
  # Fichier d'état corrompu ou modifié : on repart de zéro plutôt que d'évaluer du texte arbitraire.
  [[ "$count" =~ ^[0-9]+$ && "$alerted" =~ ^[01]$ && "$last" =~ ^[0-9]+$ ]] || { count=0 alerted=0 last=0; }
  if [[ "$ok" == 1 ]]; then
    [[ "$alerted" == 1 ]] && recovered+=("$message")
    count=0 alerted=0 last=0
  else
    count=$((count + 1))
    if [[ "$count" -ge "$FAILS_BEFORE_ALERT" ]]; then
      if [[ "$alerted" == 0 ]]; then
        problems+=("$message"); alerted=1; last="$now"
      elif (( now - last >= REMIND_HOURS * 3600 )); then
        reminders+=("$message"); last="$now"
      fi
    fi
  fi
  if [[ "$dry_run" == 1 ]]; then
    printf '%-28s %s\n' "$key" "$([[ "$ok" == 1 ]] && echo OK || echo "ÉCHEC : $message")"
  else
    printf '%s %s %s\n' "$count" "$alerted" "$last" >"$file"
  fi
}

# --- Conteneurs ---------------------------------------------------------------------------------------
services=(raijin-postgres raijin-redis raijin-api raijin-web raijin-landing)
for optional in raijin-bench-api raijin-bench-web; do
  docker inspect "$optional" >/dev/null 2>&1 && services+=("$optional")
done
for name in "${services[@]}"; do
  if ! state="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null)"; then
    state="absent"
  fi
  state="${state//$'\n'/}"
  if [[ "$state" == "running healthy" || "$state" == "running none" ]]; then
    record "container-$name" 1 "$name"
  else
    record "container-$name" 0 "conteneur $name : $state"
  fi
done

# --- Accès extérieur (DNS, Traefik, certificats) ------------------------------------------------------
if [[ "$EXTERNAL" == 1 ]] && command -v curl >/dev/null 2>&1; then
  check_url() {
    local key="$1" url="$2" code
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --proto '=https' "$url" 2>/dev/null || echo 000)"
    if [[ "$code" == 200 ]]; then record "$key" 1 "$url"; else record "$key" 0 "$url répond $code"; fi
  }
  check_url https-api "https://$API_DOMAIN/api/v1/health"
  check_url https-app "https://$APP_DOMAIN/"
  check_url https-landing "https://$LANDING_DOMAIN/"
fi

# --- Disque et mémoire --------------------------------------------------------------------------------
docker_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
for mount in / "$docker_root" "$BACKUP_DIR"; do
  [[ -e "$mount" ]] || continue
  pct="$(df -P "$mount" | awk 'NR==2 {gsub("%","",$5); print $5}')"
  key="disk-$(printf '%s' "$mount" | tr -c 'a-zA-Z0-9' '_')"
  if [[ "${pct:-0}" -lt "$DISK_PCT" ]]; then record "$key" 1 "disque $mount"; else record "$key" 0 "disque $mount plein à $pct %"; fi
done
if [[ -r /proc/meminfo ]]; then
  avail_mb="$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)"
  if [[ "${avail_mb:-0}" -ge "$MIN_MEM_MB" ]]; then record memory 1 "mémoire"; else record memory 0 "RAM disponible faible : ${avail_mb} Mo"; fi
fi

# --- Sauvegardes ----------------------------------------------------------------------------------------
if [[ -r "$BACKUP_DIR/.last-success" ]]; then
  last_backup="$(cat "$BACKUP_DIR/.last-success")"
  [[ "$last_backup" =~ ^[0-9]+$ ]] || last_backup=0
  age_h=$(( (now - last_backup) / 3600 ))
  if (( age_h <= 26 )); then record backup 1 "sauvegarde"; else record backup 0 "dernière sauvegarde réussie il y a ${age_h} h"; fi
elif [[ -d "$BACKUP_DIR" ]]; then
  record backup 0 "aucune sauvegarde réussie dans $BACKUP_DIR"
fi

# --- Alertes ------------------------------------------------------------------------------------------
[[ "$dry_run" == 1 ]] && exit 0
host="$(hostname)"
join() { local IFS=$'\n'; printf -- '- %s\n' "$@"; }
if (( ${#problems[@]} > 0 || ${#reminders[@]} > 0 )); then
  body="Raijin : problème détecté sur $host le $(date '+%Y-%m-%d à %H:%M')."$'\n\n'
  (( ${#problems[@]} > 0 )) && body+="Nouveau :"$'\n'"$(join "${problems[@]}")"$'\n'
  (( ${#reminders[@]} > 0 )) && body+="Toujours en cours :"$'\n'"$(join "${reminders[@]}")"$'\n'
  body+=$'\n'"Diagnostic : docker compose -p raijin ps ; docker logs --tail 100 <conteneur> ; docs/DEPLOY.md (A11)."
  log "$(printf '%s' "$body" | tr '\n' ' ')"
  send_alert "[Raijin] Alerte : service en panne" "$body" || warn "aucun canal d'alerte n'a fonctionné."
fi
if (( ${#recovered[@]} > 0 )); then
  body="Raijin : retour à la normale sur $host le $(date '+%Y-%m-%d à %H:%M')."$'\n\n'"$(join "${recovered[@]}")"
  log "$(printf '%s' "$body" | tr '\n' ' ')"
  send_alert "[Raijin] Retour à la normale" "$body" || true
fi
exit 0
