#!/usr/bin/env bash
# Triggers one scan of the scan-tokens Edge Function on the remote project.
# Prints only the HTTP status and the JSON body. The secret never appears in
# argv (ps), stdout or logs: it is passed to curl through a 0600 header file.
#
# Usage:  scripts/trigger-scan.sh            # authenticated call
#         scripts/trigger-scan.sh --no-auth  # must return 401
set -euo pipefail

cd "$(dirname "$0")/.."
REF="${SUPABASE_PROJECT_REF:-jntknbxdpetvcmoejncm}"
FN="${FN:-scan-tokens}"
[[ "$FN" =~ ^(scan-tokens|enrich-tokens|label-outcomes|paper-engine|backtest-run)$ ]] || { echo "FN must be scan-tokens, enrich-tokens, label-outcomes, paper-engine or backtest-run" >&2; exit 1; }
URL="https://${REF}.supabase.co/functions/v1/${FN}"
SECRET_FILE=".secrets/cron_secret"

hdr="$(mktemp)"
body="$(mktemp)"
trap 'rm -f "$hdr" "$body"' EXIT
chmod 600 "$hdr"

if [[ "${1:-}" != "--no-auth" ]]; then
  [[ -s "$SECRET_FILE" ]] || { echo "missing $SECRET_FILE" >&2; exit 1; }
  [[ "$(stat -c %a "$SECRET_FILE")" == 600 ]] || { echo "insecure permissions: run chmod 600 $SECRET_FILE" >&2; exit 1; }
  printf 'x-cron-secret: %s\n' "$(tr -d '\n' < "$SECRET_FILE")" > "$hdr"
fi

code="$(curl -sS -m 150 -X POST -H @"$hdr" -H 'content-type: application/json' \
  -o "$body" -w '%{http_code}' "$URL")"

echo "HTTP $code"
cat "$body"
echo
