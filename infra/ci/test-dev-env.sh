#!/usr/bin/env bash
# CI uniquement (job « images ») : livre l'environnement dev À CÔTÉ de la prod déjà démarrée, exactement comme le
# déploiement continu (docs/DEPLOY.md partie C) : archive images.tar.gz + infra/ sur l'entrée standard de
# infra/deploy-gate.sh, disposition /srv/raijin simulée sous $RUNNER_TEMP/raijin-deploy (fichiers de infra/ci/fake-env.sh).
# Images : celles de la prod (déjà construites) réétiquetées raijin-dev/<image>:<commit>.
#   1. refus attendus de la porte (mauvais environnement, commande inconnue, commit invalide, étiquette étrangère) ;
#   2. premier déploiement dev → succès, version en service ;
#   3. deuxième livraison volontairement cassée (santé de l'API inaccessible par Traefik) → échec, retour
#      automatique à la version 1, toujours en service.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == "true" ]] || { echo "test-dev-env.sh : réservé à la CI GitHub." >&2; exit 1; }
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# Les variables de la prod exportées dans $GITHUB_ENV par fake-env.sh l'emporteraient sur le fichier du dev pour
# Compose : on les retire ici (sur le VPS, l'environnement de l'utilisateur deploy n'en contient aucune).
while IFS='=' read -r key _; do
  [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] && unset "$key"
done < <(grep -E '^[A-Z_][A-Z0-9_]*=' infra/.env)

export RAIJIN_DEPLOY_BASE="$RUNNER_TEMP/raijin-deploy"
export RAIJIN_TRAEFIK_ADDR="127.0.0.1:${TRAEFIK_CI_PORT:-8443}"
export RAIJIN_MIN_FREE_GB=3 RAIJIN_NO_EXTERNAL_CHECK=1
work="$(mktemp -d)"
failures=0
ok() { printf '  ok   %s\n' "$*"; }
ko() { printf '::error::%s\n' "$*"; failures=$((failures + 1)); }

gate() { SSH_ORIGINAL_COMMAND="$1" infra/deploy-gate.sh dev; }
expect_refused() {
  local label="$1" cmd="$2" input="${3:-/dev/null}" code=0
  gate "$cmd" <"$input" >"$work/out" 2>&1 || code=$?
  if [[ "$code" != 0 ]]; then ok "refusé : $label ($(tail -n 1 "$work/out"))"; else ko "accepté à tort : $label"; fi
}

# bundle <commit> <dossier infra> <fichier> : archive livrée comme dans deploy.yml.
bundle() {
  local sha="$1" infra_dir="$2" out="$3" d img
  d="$(mktemp -d)"
  for img in api web landing migrate; do docker image tag "raijin/$img:latest" "raijin-dev/$img:$sha"; done
  docker save "raijin-dev/api:$sha" "raijin-dev/web:$sha" "raijin-dev/landing:$sha" "raijin-dev/migrate:$sha" | gzip -1 >"$d/images.tar.gz"
  tar -cf "$out" -C "$(dirname "$infra_dir")" "$(basename "$infra_dir")"
  tar --append -f "$out" -C "$d" images.tar.gz
  rm -r -- "$d"
}

sha1="$(git rev-parse HEAD)"
mkdir -p "$work/v1"
git archive --format=tar HEAD infra | tar -x -C "$work/v1"
bundle "$sha1" "$work/v1/infra" "$work/v1.tar"

echo "== Refus de la porte"
expect_refused "clé dev, environnement prod" "deploy prod $sha1"
expect_refused "commande arbitraire" "sh -c id"
expect_refused "commit invalide" "deploy dev abc"
expect_refused "argument en trop" "deploy dev $sha1 --bench"
# Étiquette étrangère (ici une image « traefik ») : refusée avant tout docker load.
d="$(mktemp -d)"
docker image tag "raijin/web:latest" "traefik:ci-pirate"
docker save "traefik:ci-pirate" | gzip -1 >"$d/images.tar.gz"
docker image rm "traefik:ci-pirate" >/dev/null
tar -cf "$work/pirate.tar" -C "$work/v1" infra
tar --append -f "$work/pirate.tar" -C "$d" images.tar.gz
rm -r -- "$d"
expect_refused "image d'un autre projet (traefik:…)" "deploy dev $sha1" "$work/pirate.tar"
if docker image inspect traefik:ci-pirate >/dev/null 2>&1; then ko "image étrangère chargée malgré le refus"; else ok "image étrangère jamais chargée"; fi

echo "== Déploiement dev n° 1 (porte → deploy.sh --release)"
if gate "deploy dev $sha1" <"$work/v1.tar"; then ok "dev $sha1 déployé"; else ko "premier déploiement dev en échec"; fi
current="$(readlink -f "$RAIJIN_DEPLOY_BASE/dev/current" || true)"
[[ "$(basename "$current")" == "$sha1"-* ]] && ok "version en service : $(basename "$current")" || ko "current ne pointe pas vers $sha1 ($current)"
gate "status dev" | sed 's/^/    /'

echo "== Déploiement dev n° 2 cassé → retour automatique"
sha2="$(printf '%040d' 2 | tr 0 e)"
mkdir -p "$work/v2"
git archive --format=tar HEAD infra | tar -x -C "$work/v2"
# Santé de l'API retirée du routeur public d'api-dev : le contrôle de routage (200 attendu, 401 obtenu) échoue.
python3 - "$work/v2/infra/docker-compose.env-dev.yml" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = "Path(`/api/v1/health`) || PathPrefix(`/api/v1/health/`) || "
assert old in s
open(p, 'w').write(s.replace(old, ''))
PY
bundle "$sha2" "$work/v2/infra" "$work/v2.tar"
code=0
gate "deploy dev $sha2" <"$work/v2.tar" >"$work/out2" 2>&1 || code=$?
sed 's/^/    /' "$work/out2" | tail -n 25
[[ "$code" != 0 ]] && ok "livraison cassée refusée (code $code)" || ko "livraison cassée acceptée"
grep -q "dernière version réussie remise en service" "$work/out2" && ok "retour automatique effectué" || ko "pas de retour automatique"
current="$(readlink -f "$RAIJIN_DEPLOY_BASE/dev/current" || true)"
[[ "$(basename "$current")" == "$sha1"-* ]] && ok "version 1 toujours en service" || ko "current a changé ($current)"
code="$(curl -sk -o /dev/null -w '%{http_code}' --resolve "api-dev.raijinshield.com:${TRAEFIK_CI_PORT:-8443}:127.0.0.1" \
  "https://api-dev.raijinshield.com:${TRAEFIK_CI_PORT:-8443}/api/v1/health" || echo 000)"
[[ "$code" == 200 ]] && ok "api-dev /api/v1/health → 200 après retour" || ko "api-dev /api/v1/health → $code après retour"
want="$(docker image inspect -f '{{.Id}}' "raijin-dev/api:$sha1")"
got="$(docker inspect -f '{{.Image}}' raijin-dev-api)"
[[ "$want" == "$got" ]] && ok "raijin-dev-api tourne sur l'image de la version 1" || ko "raijin-dev-api : image inattendue"

rm -r -- "$work"
if (( failures > 0 )); then echo "$failures contrôle(s) en échec."; exit 1; fi
echo "Environnement dev livré par la porte : tous les contrôles sont verts."
