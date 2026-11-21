#!/usr/bin/env bash
# Rotates CRON_SECRET end to end without ever printing it:
#   1. generates a new secret (.secrets/cron_secret.new, 0600)
#   2. sets it as the scan-tokens Edge Function secret
#   3. updates the Vault secret read by pg_cron (raijin_cron_secret)
#   4. replaces .secrets/cron_secret and regenerates supabase/sql/schedule_cron.local.sql
#   5. checks that the function accepts the new secret
# Between steps 2 and 3, at most one cron call may get a 401: harmless.
# Usage: bash scripts/rotate-cron-secret.sh
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

REF="${SUPABASE_PROJECT_REF:-jntknbxdpetvcmoejncm}"
SUPA=(npx --yes supabase@3.2.0)
NEW=".secrets/cron_secret.new"
SQL=".secrets/rotate_cron_secret.sql"
trap 'rm -f "$SQL"' EXIT

mkdir -p .secrets
openssl rand -hex 32 > "$NEW"
chmod 600 "$NEW"

"${SUPA[@]}" secrets set --remote="$REF" --yes CRON_SECRET="$(< "$NEW")" >/dev/null 2>&1 \
  || { echo "step 2 failed: supabase secrets set" >&2; exit 1; }
echo "1/3 Edge Function secret updated"

printf "select vault.update_secret((select id from vault.secrets where name = 'raijin_cron_secret'), '%s');\n" \
  "$(< "$NEW")" > "$SQL"
"${SUPA[@]}" db query --remote --yes --file "$SQL" >/dev/null 2>&1 \
  || { echo "step 3 failed: vault update (Edge Function already uses the NEW secret in $NEW)" >&2; exit 1; }
echo "2/3 Vault secret updated"

mv "$NEW" .secrets/cron_secret
chmod 600 .secrets/cron_secret

node -e '
  const fs = require("fs");
  const secret = fs.readFileSync(".secrets/cron_secret", "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(secret)) process.exit(1);
  const sql = "-- GENERATED LOCALLY — contains the cron secret. Never commit, never share.\n" +
    fs.readFileSync("supabase/sql/schedule_cron.sql", "utf8")
      .replace("https://<PROJECT_REF>.supabase.co", "https://" + process.argv[1] + ".supabase.co")
      .replace("<SAME_SECRET_AS_CRON_SECRET>", secret);
  fs.writeFileSync("supabase/sql/schedule_cron.local.sql", sql, { mode: 0o600 });
' "$REF"
echo "3/3 local files updated"

out="$(bash scripts/trigger-scan.sh || true)"
echo "check: scan with the new secret -> ${out%%$'\n'*}"
