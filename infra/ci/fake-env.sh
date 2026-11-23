#!/usr/bin/env bash
# CI uniquement (job « images » de .github/workflows/ci.yml) : génère infra/.env et infra/.env.api avec des
# valeurs FACTICES tirées au hasard (jamais de vrai secret, aucun service externe). Les valeurs aléatoires sont
# masquées dans les journaux GitHub ; les variables d'interpolation de Compose sont exportées dans $GITHUB_ENV
# pour docker buildx bake. Ne jamais lancer sur le VPS.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == "true" ]] || { echo "fake-env.sh : réservé à la CI GitHub." >&2; exit 1; }

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
umask 077
# Jamais d'écrasement : si un vrai fichier de variables existe, on s'arrête.
for f in infra/.env infra/.env.api; do
  [[ ! -e "$f" ]] || { echo "fake-env.sh : $f existe déjà, refus de l'écraser." >&2; exit 1; }
done

rand_hex() { openssl rand -hex 32; }
rand_b64() { openssl rand -base64 "$1" | tr -d '\n'; }

declare -A compose_vars=(
  [TRAEFIK_NETWORK]=traefik-ci
  [TRAEFIK_ENTRYPOINT]=websecure
  [TRAEFIK_CERTRESOLVER]=ci
  [LANDING_DOMAIN]=raijinshield.com
  [APP_DOMAIN]=app.raijinshield.com
  [API_DOMAIN]=api.raijinshield.com
  [BENCH_DOMAIN]=banc.raijinshield.com
  [POSTGRES_SUPERUSER_PASSWORD]="$(rand_hex)"
  [RAIJIN_DB_PASSWORD]="$(rand_hex)"
  [BENCH_DB_PASSWORD]="$(rand_hex)"
  [REDIS_PASSWORD]="$(rand_hex)"
  [GA4_MEASUREMENT_ID]=""
  [GOOGLE_SITE_VERIFICATION]=""
  [BACKUP_DIR]="$RUNNER_TEMP/raijin-backups"
  [WATCHDOG_EXTERNAL]=0
)

: >infra/.env
for key in "${!compose_vars[@]}"; do
  value="${compose_vars[$key]}"
  [[ "$key" == *PASSWORD ]] && echo "::add-mask::$value"
  printf '%s=%s\n' "$key" "$value" >>infra/.env
  printf '%s=%s\n' "$key" "$value" >>"$GITHUB_ENV"
done

jwt="$(rand_b64 48)" cookie="$(rand_b64 32)" iphash="$(rand_b64 48)" totp="$(rand_b64 32)"
for v in "$jwt" "$cookie" "$iphash" "$totp"; do echo "::add-mask::$v"; done
cat >infra/.env.api <<EOF
JWT_ACCESS_SECRET=$jwt
COOKIE_SECRET=$cookie
IP_HASH_SECRET=$iphash
TOTP_ENCRYPTION_KEY=$totp
MAIL_PROVIDER=smtp
SMTP_HOST=localhost
BILLING_PROVIDER=stripe
STRIPE_SECRET_KEY=
PUSH_PROVIDER=webpush
JOBS_ENABLED=false
HELIUS_API_KEY=
EOF
chmod 600 infra/.env infra/.env.api
echo "infra/.env et infra/.env.api factices générés."
