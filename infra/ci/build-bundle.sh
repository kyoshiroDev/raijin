#!/usr/bin/env bash
# GitHub Actions uniquement (workflow « Déploiement ») : construit les images de l'environnement <env> au commit SHA
# (variables PUBLIQUES seulement : domaines, GA4 / Search Console de la landing de prod) et produit l'archive livrée
# $RUNNER_TEMP/livraison/bundle.tar = infra/ du commit (git archive) + images.tar.gz (docker save, étiquettes
# <nom>/<image>:<SHA>). Aucun secret : les mots de passe exigés par l'interpolation de Compose sont du remplissage.
#   infra/ci/build-bundle.sh dev|prod      (SHA, GA4_ID, SITE_VERIFICATION dans l'environnement)
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == "true" ]] || { echo "build-bundle.sh : réservé à GitHub Actions." >&2; exit 1; }
env="${1:-}"
[[ "$env" == dev || "$env" == prod ]] || { echo "::error::environnement dev ou prod"; exit 1; }
[[ "${SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::commit invalide"; exit 1; }
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

if [[ "$env" == prod ]]; then
  name=raijin landing=raijinshield.com app=app.raijinshield.com api=api.raijinshield.com
  ga4="${GA4_ID:-}" verification="${SITE_VERIFICATION:-}"
else
  # Dev : jamais de mesure d'audience ni de vérification Search Console.
  name=raijin-dev landing=landing-dev.raijinshield.com app=dev.raijinshield.com api=api-dev.raijinshield.com
  ga4='' verification=''
fi
placeholder="remplissage-build-$(openssl rand -hex 16)"
build_env="$RUNNER_TEMP/build.env"
{
  echo "TRAEFIK_NETWORK=build"
  echo "TRAEFIK_CERTRESOLVER=build"
  echo "LANDING_DOMAIN=$landing"
  echo "APP_DOMAIN=$app"
  echo "API_DOMAIN=$api"
  for v in POSTGRES_SUPERUSER_PASSWORD RAIJIN_DB_PASSWORD BENCH_DB_PASSWORD REDIS_PASSWORD; do echo "$v=$placeholder"; done
  echo "GA4_MEASUREMENT_ID=$ga4"
  echo "GOOGLE_SITE_VERIFICATION=$verification"
} >"$build_env"

targets=(raijin-api raijin-web raijin-landing raijin-migrate)
images=(api web landing migrate)
# Banc : production seulement, dès que son API existe.
if [[ "$env" == prod && -d apps/raijin-banc-de-test-api ]]; then
  targets+=(raijin-bench-api raijin-bench-web raijin-bench-migrate)
  images+=(bench-api bench-web bench-migrate)
fi
echo "Environnement $env, commit $SHA, images : ${images[*]}"

DOCKER_BUILDKIT=1 RAIJIN_NAME="$name" RAIJIN_TAG="$SHA" \
  docker compose --project-name "$name" --env-file "$build_env" -f infra/docker-compose.yml \
  --profile tools --profile bench build "${targets[@]}"
docker images "$name/*"

dir="$RUNNER_TEMP/livraison"
mkdir -p "$dir"
refs=()
for img in "${images[@]}"; do refs+=("$name/$img:$SHA"); done
docker save "${refs[@]}" | gzip -1 >"$dir/images.tar.gz"
git archive --format=tar -o "$dir/bundle.tar" "$SHA" infra
tar --append -f "$dir/bundle.tar" -C "$dir" images.tar.gz
rm -- "$dir/images.tar.gz"
ls -lh "$dir/bundle.tar"
