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
export RAIJIN_MIN_FREE_GB=3 RAIJIN_GATE_TEST=1 RAIJIN_POLICY_DIAG=1
# Partie privilégiée (docker-priv.sh) : sur le VPS, root par sudo ; ici, appel direct (l'utilisateur du runner a Docker).
export RAIJIN_PRIV_CMD="$PWD/infra/docker-priv.sh" RAIJIN_PRIV_BASE="$RUNNER_TEMP/raijin-priv"
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

# Réseau d'entrée du dev, rejoint par Traefik (sur le VPS : docs/DEPLOY.md C2) ; la prod reste sur traefik-ci.
docker network inspect raijin-dev-edge >/dev/null 2>&1 || docker network create raijin-dev-edge >/dev/null
docker network connect raijin-dev-edge traefik-ci 2>/dev/null || true

sha1="$(git rev-parse HEAD)"
mkdir -p "$work/v1"
git archive --format=tar HEAD infra | tar -x -C "$work/v1"
bundle "$sha1" "$work/v1/infra" "$work/v1.tar"

echo "== Archive d'images réelle (docker save des images construites par la CI)"
mkdir -p "$work/real"
tar -xf "$work/v1.tar" -C "$work/real" images.tar.gz
# Diagnostic : type, étiquette, plateforme et User de chaque config contrôlée (rien d'autre).
code=0
RAIJIN_POLICY_DIAG=1 python3 infra/lib/deploy_policy.py images "$work/real/images.tar.gz" raijin-dev "$sha1" "$work/real/expected" >"$work/out" 2>&1 || code=$?
grep '^  diag config' "$work/out" || true
if [[ "$code" == 0 ]]; then
  ok "images réelles acceptées ($(tr '\n' ' ' <"$work/real/expected"))"
else
  ko "images réelles refusées : $(tr '\n' ' ' <"$work/out" | head -c 400)"
fi
# Contre-épreuve sur une vraie image : la même, reconstruite avec USER root, est refusée.
printf 'FROM raijin/web:latest\nUSER root\n' | docker build -q -t "raijin-dev/web:$sha1-root" - >/dev/null
docker image tag "raijin-dev/web:$sha1-root" "raijin-dev/web:$sha1"
docker save "raijin-dev/web:$sha1" | gzip -1 >"$work/real/root.tar.gz"
docker image tag "raijin/web:latest" "raijin-dev/web:$sha1"
docker image rm "raijin-dev/web:$sha1-root" >/dev/null
python3 infra/lib/deploy_policy.py images "$work/real/root.tar.gz" raijin-dev "$sha1" >"$work/out" 2>&1 \
  && ko "image réelle avec USER root acceptée" || ok "image réelle avec USER root refusée"

echo "== Refus de la porte"
expect_refused "clé dev, environnement prod" "deploy prod $sha1"
expect_refused "commande arbitraire" "sh -c id"
expect_refused "commit invalide" "deploy dev abc"
expect_refused "argument en trop" "deploy dev $sha1 --bench"
expect_refused "dépôt prod avec la clé dev" "depose prod $sha1"
# Clé « prod-depot » : jeton OIDC forgé → archive refusée, rien de déposé ni de démarré.
mkdir -p "$RAIJIN_DEPLOY_BASE/prod/env"
printf 'DEPLOY_GITHUB_REPOSITORY=ci/raijin\n' >"$RAIJIN_DEPLOY_BASE/prod/env/.env"
fake_jwt="$(printf '{"alg":"RS256","kid":"ci"}' | base64 -w0 | tr '+/' '-_' | tr -d '=').$(printf '{"sha":"%s"}' "$sha1" | base64 -w0 | tr '+/' '-_' | tr -d '=').c2lnbmF0dXJl"
code=0
{ printf '%s\n' "$fake_jwt"; cat "$work/v1.tar"; } | SSH_ORIGINAL_COMMAND="depose prod $sha1" infra/deploy-gate.sh prod-depot >"$work/out" 2>&1 || code=$?
if [[ "$code" != 0 ]]; then ok "refusé : dépôt prod avec jeton OIDC forgé ($(tail -n 1 "$work/out"))"; else ko "dépôt prod accepté avec un jeton forgé"; fi
[[ ! -e "$RAIJIN_DEPLOY_BASE/incoming/prod/$sha1.tar" ]] && ok "aucun dépôt conservé" || ko "dépôt conservé malgré le refus"
SSH_ORIGINAL_COMMAND="deploy prod $sha1" infra/deploy-gate.sh prod-depot </dev/null >"$work/out" 2>&1 && ko "clé prod-depot : deploy accepté" || ok "refusé : clé prod-depot ne déploie pas"
SSH_ORIGINAL_COMMAND="x" infra/deploy-gate.sh --approve "$sha1" >"$work/out" 2>&1 && ko "activation acceptée depuis SSH" || ok "refusé : activation depuis une session SSH"
infra/deploy-gate.sh --approve "$sha1" >"$work/out" 2>&1 && ko "activation sans dépôt acceptée" || ok "refusé : activation sans dépôt vérifié"
# Isolation dev/prod (sur le VPS : utilisateurs deploy-dev et deploy-prod distincts, C2) : tant que la prod est
# lisible par l'utilisateur qui déploie le dev, la porte refuse. Ici, un seul utilisateur : on retire l'accès.
expect_refused "dev déployé par un utilisateur qui lit la prod" "deploy dev $sha1" "$work/v1.tar"
chmod 000 "$RAIJIN_DEPLOY_BASE/prod"
[[ -d "$RAIJIN_DEPLOY_BASE/incoming/prod" ]] && chmod 000 "$RAIJIN_DEPLOY_BASE/incoming/prod"

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

echo "== Partie privilégiée (docker-priv.sh)"
"$RAIJIN_PRIV_CMD" dev load x >"$work/out" 2>&1 && ko "docker-priv : commande inconnue acceptée" || ok "docker-priv : commande inconnue refusée"
"$RAIJIN_PRIV_CMD" autre status >"$work/out" 2>&1 && ko "docker-priv : environnement inconnu accepté" || ok "docker-priv : environnement inconnu refusé"
"$RAIJIN_PRIV_CMD" dev import /etc >"$work/out" 2>&1 && ko "docker-priv : import hors zone accepté" || ok "docker-priv : import hors de /srv/raijin/dev/releases refusé"
fake_rel="$RAIJIN_DEPLOY_BASE/dev/releases/$sha1-20260101T000000Z"
mkdir -p "$fake_rel"
printf '%s\n' "$sha1" >"$fake_rel/SHA"
ln -s /etc/hostname "$fake_rel/compose.resolved.json"
"$RAIJIN_PRIV_CMD" dev import "$fake_rel" >"$work/out" 2>&1 && ko "docker-priv : lien symbolique copié" || ok "docker-priv : lien symbolique dans la version refusé"
rm -r -- "$fake_rel" "$RAIJIN_PRIV_BASE/dev/releases/$sha1-20260101T000000Z" 2>/dev/null || true

echo "== Déploiement dev n° 1 (porte → docker-priv.sh → release.sh)"
if gate "deploy dev $sha1" <"$work/v1.tar"; then ok "dev $sha1 déployé"; else ko "premier déploiement dev en échec"; fi
current="$(readlink -f "$RAIJIN_PRIV_BASE/dev/current" || true)"
[[ "$(basename "$current")" == "$sha1"-* ]] && ok "version en service : $(basename "$current")" || ko "current ne pointe pas vers $sha1 ($current)"
gate "status dev" | sed 's/^/    /'

echo "== Déploiement dev n° 2 cassé → retour automatique"
sha2="$(printf '%040d' 2 | tr 0 e)"
mkdir -p "$work/v2"
git archive --format=tar HEAD infra | tar -x -C "$work/v2"
# Routeur public de la santé retiré d'api-dev : le contrôle de routage (200 attendu, 401 obtenu) échoue.
python3 - "$work/v2/infra/docker-compose.env-dev.yml" <<'PY'
import sys
p = sys.argv[1]
lines = open(p).read().split('\n')
kept = [l for l in lines if '-api-public-health.' not in l]
assert len(kept) < len(lines)
open(p, 'w').write('\n'.join(kept))
PY
bundle "$sha2" "$work/v2/infra" "$work/v2.tar"
code=0
gate "deploy dev $sha2" <"$work/v2.tar" >"$work/out2" 2>&1 || code=$?
sed 's/^/    /' "$work/out2" | tail -n 25
[[ "$code" != 0 ]] && ok "livraison cassée refusée (code $code)" || ko "livraison cassée acceptée"
grep -q "dernière version réussie remise en service" "$work/out2" && ok "retour automatique effectué" || ko "pas de retour automatique"
current="$(readlink -f "$RAIJIN_PRIV_BASE/dev/current" || true)"
[[ "$(basename "$current")" == "$sha1"-* ]] && ok "version 1 toujours en service" || ko "current a changé ($current)"
# Traefik prend en compte le conteneur recréé en quelques secondes : jusqu'à 30 s d'attente.
for _ in $(seq 1 15); do
  code="$(curl -sk -o /dev/null -w '%{http_code}' --resolve "api-dev.raijinshield.com:${TRAEFIK_CI_PORT:-8443}:127.0.0.1" \
    "https://api-dev.raijinshield.com:${TRAEFIK_CI_PORT:-8443}/api/v1/health" || echo 000)"
  [[ "$code" == 200 ]] && break
  sleep 2
done
[[ "$code" == 200 ]] && ok "api-dev /api/v1/health → 200 après retour" || ko "api-dev /api/v1/health → $code après retour"
want="$(docker image inspect -f '{{.Id}}' "raijin-dev/api:$sha1")"
got="$(docker inspect -f '{{.Image}}' raijin-dev-api)"
[[ "$want" == "$got" ]] && ok "raijin-dev-api tourne sur l'image de la version 1" || ko "raijin-dev-api : image inattendue"

chmod 750 "$RAIJIN_DEPLOY_BASE/prod"
[[ -d "$RAIJIN_DEPLOY_BASE/incoming/prod" ]] && chmod 750 "$RAIJIN_DEPLOY_BASE/incoming/prod"
rm -r -- "$work"
if (( failures > 0 )); then echo "$failures contrôle(s) en échec."; exit 1; fi
echo "Environnement dev livré par la porte : tous les contrôles sont verts."
