#!/usr/bin/env bash
# CI uniquement (job « images » de .github/workflows/ci.yml) : génère infra/.env, infra/.env.api,
# infra/.env.bench-api et l'environnement dev ($RUNNER_TEMP/raijin-deploy/dev/env/.env et .env.api) avec des
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

# Environnement dev (infra/ci/test-dev-env.sh) : disposition du déploiement continu, /srv/raijin/dev/env/ simulé
# sous $RUNNER_TEMP/raijin-deploy. Mots de passe propres au dev (jamais ceux de la prod). Ces variables ne vont PAS
# dans $GITHUB_ENV (elles écraseraient celles de la prod pour Compose) ; seuls l'identifiant basicAuth et le mot de
# passe Redis du dev y sont exportés (contrôles de check-stack-dev.sh).
dev_env_dir="$RUNNER_TEMP/raijin-deploy/dev/env"
mkdir -p "$dev_env_dir"
dev_pass="$(rand_hex)" dev_redis="$(rand_hex)" dev_pg="$(rand_hex)" dev_db="$(rand_hex)" dev_bench_db="$(rand_hex)"
for v in "$dev_pass" "$dev_redis" "$dev_pg" "$dev_db" "$dev_bench_db"; do echo "::add-mask::$v"; done
{
  echo "RAIJIN_NAME=raijin-dev"
  # Réseau d'entrée propre au dev (rejoint par le Traefik factice dans test-dev-env.sh), jamais celui de la prod.
  echo "TRAEFIK_NETWORK=raijin-dev-edge"
  echo "TRAEFIK_ENTRYPOINT=websecure"
  echo "TRAEFIK_CERTRESOLVER=ci"
  echo "LANDING_DOMAIN=landing-dev.raijinshield.com"
  echo "APP_DOMAIN=dev.raijinshield.com"
  echo "API_DOMAIN=api-dev.raijinshield.com"
  echo "POSTGRES_SUPERUSER_PASSWORD=$dev_pg"
  echo "RAIJIN_DB_PASSWORD=$dev_db"
  echo "BENCH_DB_PASSWORD=$dev_bench_db"
  echo "REDIS_PASSWORD=$dev_redis"
  printf "DEV_BASIC_AUTH_USERS='%s'\n" "ci:$(openssl passwd -apr1 "$dev_pass")"
} >"$dev_env_dir/.env"
printf 'DEV_CI_BASIC_AUTH=%s\n' "ci:$dev_pass" >>"$GITHUB_ENV"
printf 'REDIS_DEV_PASSWORD=%s\n' "$dev_redis" >>"$GITHUB_ENV"
djwt="$(rand_b64 48)" dcookie="$(rand_b64 32)" diphash="$(rand_b64 48)" dtotp="$(rand_b64 32)"
for v in "$djwt" "$dcookie" "$diphash" "$dtotp"; do echo "::add-mask::$v"; done
cat >"$dev_env_dir/.env.api" <<DEVAPI
JWT_ACCESS_SECRET=$djwt
COOKIE_SECRET=$dcookie
IP_HASH_SECRET=$diphash
TOTP_ENCRYPTION_KEY=$dtotp
BILLING_PROVIDER=stripe
STRIPE_SECRET_KEY=
PUSH_PROVIDER=webpush
JOBS_ENABLED=false
HELIUS_API_KEY=
DEVAPI
chmod 600 "$dev_env_dir/.env" "$dev_env_dir/.env.api"
echo "environnement dev factice généré ($dev_env_dir)."
