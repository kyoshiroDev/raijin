#!/usr/bin/env bash
# Test de infra/vps-setup.sh dans un conteneur Ubuntu jetable (CI, ou en local avec Docker) : --check n'écrit rien,
# --apply --yes-safe installe utilisateurs, dossiers, verrou, scripts figés, sudoers, modèles .env (secrets générés,
# jamais affichés) et authorized_keys ; une 2e passe ne change rien ; les blocs « toujours demandés » sont refusés
# sans terminal. Docker, sshd et GitHub sont absents du conteneur : leurs blocs doivent se replier en « reste à faire ».
#   infra/ci/test-vps-setup.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
IMAGE="${VPS_SETUP_TEST_IMAGE:-ubuntu:24.04}"

docker run --rm -i --network bridge -v "$PWD/infra:/src/infra:ro" "$IMAGE" bash -s <<'EOF'
set -euo pipefail
fail() { echo "ÉCHEC : $*" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends openssh-client >/dev/null

mkdir -p /work/infra/lib /work/keys
cp /src/infra/vps-setup.sh /src/infra/deploy-gate.sh /src/infra/docker-priv.sh /src/infra/release.sh \
   /src/infra/backup.sh /src/infra/watchdog.sh /work/infra/
cp /src/infra/lib/common.sh /src/infra/lib/deploy_policy.py /work/infra/lib/
ssh-keygen -q -t ed25519 -N '' -C t-dev -f /tmp/raijin-deploy-dev && cp /tmp/raijin-deploy-dev.pub /work/keys/
ssh-keygen -q -t ed25519 -N '' -C t-prod -f /tmp/raijin-depot-prod && cp /tmp/raijin-depot-prod.pub /work/keys/
cd /work

echo "--- 1. --check : aucune écriture"
bash infra/vps-setup.sh --check --keys keys --repo test-owner/raijin </dev/null >/tmp/check1.log 2>&1 || { cat /tmp/check1.log; fail "--check"; }
grep -q '\[à faire\]' /tmp/check1.log || fail "--check n'annonce aucune action"
for p in /srv/raijin /opt/raijin-deploy /var/lib/raijin-deploy /etc/sudoers.d/raijin-deploy; do [[ ! -e $p ]] || fail "--check a créé $p"; done
! id deploy-dev >/dev/null 2>&1 || fail "--check a créé deploy-dev"

echo "--- 2. --apply --yes-safe"
bash infra/vps-setup.sh --apply --yes-safe --keys keys --repo test-owner/raijin </dev/null >/tmp/apply1.log 2>&1 || { cat /tmp/apply1.log; fail "--apply"; }
for u in deploy-dev deploy-prod; do
  id "$u" >/dev/null || fail "$u absent"
  id -nG "$u" | tr ' ' '\n' | grep -qxE 'docker|sudo' && fail "$u dans docker/sudo"
  [[ "$(passwd -S "$u" | awk '{print $2}')" == L ]] || fail "$u : mot de passe non verrouillé"
done
check_perm() { [[ "$(stat -c '%U %G %a' "$1")" == "$2" ]] || fail "$1 : $(stat -c '%U %G %a' "$1") au lieu de $2"; }
check_perm /srv/raijin "root root 755"
check_perm /srv/raijin/incoming "root root 755"
check_perm /srv/raijin/lock "root root 755"
check_perm /srv/raijin/lock/deploy.lock "root root 644"
check_perm /var/lib/raijin-deploy "root root 711"
check_perm /srv/raijin/dev "deploy-dev deploy-dev 750"
check_perm /srv/raijin/dev/env "deploy-dev deploy-dev 700"
check_perm /srv/raijin/prod "deploy-prod deploy-prod 750"
check_perm /srv/raijin/prod/env "deploy-prod deploy-prod 700"
check_perm /srv/raijin/incoming/prod "deploy-prod deploy-prod 700"
check_perm /home/deploy-dev/.ssh "deploy-dev deploy-dev 700"
for f in deploy-gate.sh docker-priv.sh release.sh backup.sh watchdog.sh; do
  check_perm "/opt/raijin-deploy/infra/$f" "root root 755"; cmp -s "infra/$f" "/opt/raijin-deploy/infra/$f" || fail "$f différent"
done
check_perm /opt/raijin-deploy/infra/lib/deploy_policy.py "root root 644"
check_perm /etc/sudoers.d/raijin-deploy "root root 440"
visudo -c >/dev/null || fail "visudo -c"
grep -qx 'deploy-dev  ALL=(root) NOPASSWD: /opt/raijin-deploy/infra/docker-priv.sh dev \*' /etc/sudoers.d/raijin-deploy || fail "règle sudoers dev"
runuser -u deploy-dev -- ls /srv/raijin/prod >/dev/null 2>&1 && fail "deploy-dev lit /srv/raijin/prod"
for u in deploy-dev deploy-prod; do
  runuser -u "$u" -- flock -n /srv/raijin/lock/deploy.lock true || fail "$u ne peut pas prendre le verrou (deploy-gate.sh refuserait)"
  runuser -u "$u" -- sh -c ': >/srv/raijin/lock/x' 2>/dev/null && fail "$u peut écrire dans /srv/raijin/lock"
done
key_dev="$(awk '{print $1" "$2}' keys/raijin-deploy-dev.pub)"
grep -qxF "restrict,command=\"/opt/raijin-deploy/infra/deploy-gate.sh dev\" $key_dev github-raijin-deploy-dev" /home/deploy-dev/.ssh/authorized_keys || fail "authorized_keys dev"
key_prod="$(awk '{print $1" "$2}' keys/raijin-depot-prod.pub)"
grep -qxF "restrict,command=\"/opt/raijin-deploy/infra/deploy-gate.sh prod-depot\" $key_prod github-raijin-depot-prod" /home/deploy-prod/.ssh/authorized_keys || fail "authorized_keys prod"
check_perm /home/deploy-prod/.ssh/authorized_keys "deploy-prod deploy-prod 600"
val() { awk -v k="$2" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { printf "%s", v }' "$1"; }
check_perm /srv/raijin/dev/env/.env "root deploy-dev 640"
runuser -u deploy-dev -- cat /srv/raijin/dev/env/.env >/dev/null || fail "deploy-dev (la porte) ne lit pas le .env du dev"
runuser -u deploy-dev -- sh -c ': >>/srv/raijin/dev/env/.env' 2>/dev/null && fail "deploy-dev peut modifier le .env du dev"
check_perm /srv/raijin/dev/env/.env.api "deploy-dev deploy-dev 600"
check_perm /srv/raijin/prod/env/.env "deploy-prod deploy-prod 600"
check_perm /srv/raijin/prod/env/.env.api "deploy-prod deploy-prod 600"
[[ ! -e /var/lib/raijin-deploy/traefik-network ]] || fail "réseau de référence écrit sans Traefik connu"
grep -q 'Réseau du Traefik de référence' /tmp/apply1.log || fail "bloc du réseau de référence absent"
for e in dev prod; do
  for k in POSTGRES_SUPERUSER_PASSWORD RAIJIN_DB_PASSWORD BENCH_DB_PASSWORD REDIS_PASSWORD; do
    v="$(val "/srv/raijin/$e/env/.env" "$k")"
    [[ "$v" =~ ^[0-9a-f]{64}$ ]] || fail "$e $k non généré"
    grep -qF "$v" /tmp/apply1.log && fail "$e $k affiché"
  done
  for k in JWT_ACCESS_SECRET IP_HASH_SECRET COOKIE_SECRET TOTP_ENCRYPTION_KEY VAPID_PRIVATE_KEY; do
    v="$(val "/srv/raijin/$e/env/.env.api" "$k")"
    [[ ${#v} -ge 32 ]] || fail "$e $k non généré"
    grep -qF "$v" /tmp/apply1.log && fail "$e $k affiché"
  done
  [[ "$(val "/srv/raijin/$e/env/.env.api" TOTP_ENCRYPTION_KEY | base64 -d | wc -c)" -eq 32 ]] || fail "TOTP ≠ 32 octets"
  [[ "$(val "/srv/raijin/$e/env/.env.api" VAPID_PUBLIC_KEY)" =~ ^B[A-Za-z0-9_-]{86}$ ]] || fail "$e VAPID_PUBLIC_KEY"
done
[[ "$(val /srv/raijin/dev/env/.env REDIS_PASSWORD)" != "$(val /srv/raijin/prod/env/.env REDIS_PASSWORD)" ]] || fail "secret commun dev/prod"
v="$(val /srv/raijin/prod/env/.env EDGE_SHARED_SECRET)"
[[ "$v" =~ ^[0-9a-f]{64}$ ]] || fail "prod EDGE_SHARED_SECRET non généré"
grep -qF "$v" /tmp/apply1.log && fail "EDGE_SHARED_SECRET affiché"
[[ -z "$(val /srv/raijin/dev/env/.env EDGE_SHARED_SECRET)" ]] || fail "EDGE_SHARED_SECRET dans le dev"
[[ "$(val /srv/raijin/prod/env/.env DEPLOY_GIT_REMOTE)" == git@github.com:test-owner/raijin.git ]] || fail "DEPLOY_GIT_REMOTE"
[[ -z "$(val /srv/raijin/dev/env/.env DEV_BASIC_AUTH_USERS)" ]] || fail "basicAuth sans terminal"
grep -q 'Traefik et réseau du dev' /tmp/apply1.log || fail "bloc Traefik absent"
grep -q 'option traefik-shared' /tmp/apply1.log || fail "option B (traefik-shared) non choisie par défaut"
grep -q 'docker network connect' /tmp/apply1.log && fail "option B : docker network connect proposé"
[[ "$(val /srv/raijin/dev/env/.env RAIJIN_DEV_EDGE)" == traefik-shared ]] || fail "RAIJIN_DEV_EDGE par défaut ≠ traefik-shared"
[[ -z "$(val /srv/raijin/dev/env/.env TRAEFIK_NETWORK)" ]] || fail "dev TRAEFIK_NETWORK rempli sans Traefik détecté"
grep -q 'Docker absent ou arrêté' /tmp/apply1.log || fail "repli Docker"
grep -q 'DEV_BASIC_AUTH_USERS' /tmp/apply1.log || fail "basicAuth non signalée"

echo "--- 2 bis. réseau de référence du Traefik (option B) écrit depuis TRAEFIK_NETWORK de la prod"
sed -i 's/^TRAEFIK_NETWORK=$/TRAEFIK_NETWORK=traefik_test/' /srv/raijin/prod/env/.env
bash infra/vps-setup.sh --apply --yes-safe --keys keys --repo test-owner/raijin </dev/null >/tmp/apply1b.log 2>&1 || { cat /tmp/apply1b.log; fail "--apply (référence)"; }
check_perm /var/lib/raijin-deploy/traefik-network "root root 644"
[[ "$(cat /var/lib/raijin-deploy/traefik-network)" == traefik_test ]] || fail "réseau de référence : $(cat /var/lib/raijin-deploy/traefik-network)"
runuser -u deploy-dev -- cat /var/lib/raijin-deploy/traefik-network >/dev/null || fail "deploy-dev ne lit pas le réseau de référence"
check_perm /srv/raijin/dev/env/.env "root deploy-dev 640"
[[ "$(val /srv/raijin/dev/env/.env TRAEFIK_NETWORK)" == traefik_test ]] || fail "option B : TRAEFIK_NETWORK du dev ≠ celui de la prod"

echo "--- 3. 2e passe : idempotente"
sums() { find /srv/raijin /opt/raijin-deploy /etc/sudoers.d /home/deploy-dev /home/deploy-prod -type f -exec sha256sum {} + | sort; }
sums >/tmp/s1
bash infra/vps-setup.sh --apply --yes-safe --keys keys --repo test-owner/raijin </dev/null >/tmp/apply2.log 2>&1 || { cat /tmp/apply2.log; fail "2e --apply"; }
sums >/tmp/s2
diff /tmp/s1 /tmp/s2 || fail "la 2e passe a modifié des fichiers"
grep -q '\[fait\]' /tmp/apply2.log && { grep '\[fait\]' /tmp/apply2.log; fail "la 2e passe a agi"; }
bash infra/vps-setup.sh --check --keys keys --repo test-owner/raijin </dev/null >/tmp/check2.log 2>&1 || fail "--check final"
if grep '\[à faire\]' /tmp/check2.log | grep -v -e 'mot de passe du dev' -e 'empreinte de github.com'; then fail "--check final annonce encore des actions"; fi

echo "--- 4. option A : jamais sans drapeau ET confirmation tapée"
bash infra/vps-setup.sh --check --keys keys --repo test-owner/raijin --dev-edge dedicated </dev/null >/tmp/optA.log 2>&1 || { cat /tmp/optA.log; fail "--check option A"; }
grep -q 'Option A non confirmée' /tmp/optA.log || fail "option A sans confirmation non refusée"
grep -q 'option traefik-shared' /tmp/optA.log || fail "option A non confirmée : option B attendue"
grep -q 'docker network connect' /tmp/optA.log && fail "option A proposée sans confirmation"

echo "--- 5. valeurs envoyées depuis le PC (--envs) : vides complétées, différentes seulement sur confirmation, secrets du VPS gardés"
mkdir -p envs/dev envs/prod
jwt_before="$(val /srv/raijin/dev/env/.env.api JWT_ACCESS_SECRET)"
printf 'HELIUS_API_KEY=pc-helius-SENTINEL\nJWT_ACCESS_SECRET=pc-jwt-SENTINEL\nHELIUS_DAILY_CREDIT_BUDGET=4000\n' >envs/dev/.env.api
printf 'APP_DOMAIN=autre-dev.raijinshield.com\nRAIJIN_DEV_EDGE=dedicated\n' >envs/dev/.env
printf 'WATCHDOG_ALERT_EMAIL=pc-SENTINEL@exemple.invalid\nBACKUP_RETENTION_DAYS=14\n' >envs/prod/.env
printf 'BENCH_OWNER_EMAIL=banc-SENTINEL@exemple.invalid\nBENCH_MODE=shadow\n' >envs/prod/.env.bench-api
chmod 600 envs/*/.env*
bash infra/vps-setup.sh --apply --yes-safe --keys keys --envs envs --repo test-owner/raijin </dev/null >/tmp/apply3.log 2>&1 || { cat /tmp/apply3.log; fail "--apply --envs"; }
grep -q SENTINEL /tmp/apply3.log && fail "valeur du PC affichée"
[[ "$(val /srv/raijin/dev/env/.env.api HELIUS_API_KEY)" == pc-helius-SENTINEL ]] || fail "HELIUS_API_KEY non complétée"
[[ "$(val /srv/raijin/dev/env/.env.api JWT_ACCESS_SECRET)" == "$jwt_before" ]] || fail "secret du VPS remplacé"
grep -q 'JWT_ACCESS_SECRET garde la valeur du VPS' /tmp/apply3.log || fail "secret gardé non signalé"
[[ "$(val /srv/raijin/dev/env/.env.api HELIUS_DAILY_CREDIT_BUDGET)" == 5000 ]] || fail "valeur différente remplacée sans confirmation"
grep -q 'remplacer HELIUS_DAILY_CREDIT_BUDGET' /tmp/apply3.log || fail "remplacement non proposé"
[[ "$(val /srv/raijin/dev/env/.env APP_DOMAIN)" == dev.raijinshield.com ]] || fail "APP_DOMAIN du dev remplacé sans confirmation"
[[ "$(val /srv/raijin/dev/env/.env RAIJIN_DEV_EDGE)" == traefik-shared ]] || fail "RAIJIN_DEV_EDGE modifié par un fichier"
check_perm /srv/raijin/dev/env/.env "root deploy-dev 640"
check_perm /srv/raijin/dev/env/.env.api "deploy-dev deploy-dev 600"
[[ "$(val /srv/raijin/prod/env/.env WATCHDOG_ALERT_EMAIL)" == pc-SENTINEL@exemple.invalid ]] || fail "WATCHDOG_ALERT_EMAIL non complétée"
[[ "$(val /srv/raijin/prod/env/.env BACKUP_RETENTION_DAYS)" == 7 ]] || fail "BACKUP_RETENTION_DAYS remplacé sans confirmation"
check_perm /srv/raijin/prod/env/.env "deploy-prod deploy-prod 600"
check_perm /srv/raijin/prod/env/.env.bench-api "deploy-prod deploy-prod 600"
[[ "$(val /srv/raijin/prod/env/.env.bench-api BENCH_OWNER_EMAIL)" == banc-SENTINEL@exemple.invalid ]] || fail ".env.bench-api du PC"
sums >/tmp/s3
bash infra/vps-setup.sh --apply --yes-safe --keys keys --envs envs --repo test-owner/raijin </dev/null >/tmp/apply4.log 2>&1 || { cat /tmp/apply4.log; fail "2e --apply --envs"; }
sums >/tmp/s4
diff /tmp/s3 /tmp/s4 || fail "la 2e fusion a modifié des fichiers"
grep -q '\[fait\]' /tmp/apply4.log && { grep '\[fait\]' /tmp/apply4.log; fail "la 2e fusion a agi"; }
echo "vps-setup.sh : tous les contrôles passent."
EOF
