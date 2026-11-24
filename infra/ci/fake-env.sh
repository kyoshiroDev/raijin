#!/usr/bin/env bash
# CI uniquement (job « images » de .github/workflows/ci.yml) : génère infra/.env, infra/.env.api et
# infra/.env.bench-api avec des
# valeurs FACTICES tirées au hasard (jamais de vrai secret, aucun service externe). Les valeurs aléatoires sont
# masquées dans les journaux GitHub ; les variables d'interpolation de Compose sont exportées dans $GITHUB_ENV
# pour docker buildx bake. Ne jamais lancer sur le VPS.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == "true" ]] || { echo "fake-env.sh : réservé à la CI GitHub." >&2; exit 1; }

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
umask 077
# Jamais d'écrasement : si un vrai fichier de variables existe, on s'arrête.
for f in infra/.env infra/.env.api infra/.env.bench-api; do
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
  [REDIS_BENCH_PASSWORD]="$(rand_hex)"
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

# basicAuth du banc : hash APR1 (openssl, sans paquet apache2-utils ; en production : bcrypt, docs/DEPLOY.md A14).
# Entre apostrophes dans infra/.env (le hash contient des $) ; identifiants factices exportés pour check-stack.sh.
bench_pass="$(rand_hex)"
echo "::add-mask::$bench_pass"
bench_users="ci:$(openssl passwd -apr1 "$bench_pass")"
printf "BENCH_BASIC_AUTH_USERS='%s'\n" "$bench_users" >>infra/.env
printf 'BENCH_BASIC_AUTH_USERS=%s\n' "$bench_users" >>"$GITHUB_ENV"
printf 'BENCH_CI_BASIC_AUTH=%s\n' "ci:$bench_pass" >>"$GITHUB_ENV"

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

# API du banc : noms de docs/ENV.md, bloc « Banc » (jobs coupés, aucune clé Helius).
bsession="$(rand_b64 48)" btotp="$(rand_b64 32)"
for v in "$bsession" "$btotp"; do echo "::add-mask::$v"; done
cat >infra/.env.bench-api <<BENCH
BENCH_MODE=shadow
BENCH_OWNER_EMAIL=ci@example.invalid
BENCH_SESSION_SECRET=$bsession
BENCH_TOTP_ENCRYPTION_KEY=$btotp
BENCH_JOBS_ENABLED=0
BENCH_HELIUS_API_KEY=
BENCH_JUP_API_BASE=
BENCH_JUP_API_KEY=
BENCH_MIN_MARKET_CAP=50000
BENCH_MIN_LIQUIDITY=10000
BENCH_SCAN_KEYWORDS=
BENCH_VERDICTS_PER_RUN=6
BENCH_MAIL_TRANSPORT=none
BENCH_MAIL_FROM=Raijin banc <banc@example.invalid>
BENCH_ALERT_EMAIL=
BENCH_RESEND_API_KEY=
BENCH_SMTP_URL=
BENCH
chmod 600 infra/.env infra/.env.api infra/.env.bench-api
echo "infra/.env, infra/.env.api et infra/.env.bench-api factices générés."
