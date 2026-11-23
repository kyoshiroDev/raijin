#!/usr/bin/env bash
# Vérifie les migrations de raijin_bench sur un Postgres 17.12 JETABLE (conteneur --rm, aucun volume) :
#   1. initialisation par infra/postgres/init/10-raijin-databases.sh (bases et utilisateurs séparés) ;
#   2. `prisma migrate deploy` exécuté par l'utilisateur raijin_bench seul (non superutilisateur) ;
#   3. aucun écart entre les migrations et schema.prisma (`migrate diff`, base fantôme jetable) ;
#   4. cloisonnement : raijin_bench ne se connecte pas à raijin, et inversement ;
#   5. tests des déclencheurs et fonctions SQL (cible test-db) sur cette base.
# Ne touche à aucun autre conteneur ni à aucune base existante. Mots de passe aléatoires de l'exécution,
# passés par l'environnement (jamais en argument, jamais affichés).
# Usage : pnpm nx run bench-prisma:migrate-check   (depuis la racine du dépôt)
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(cd ../../.. && pwd)"
IMAGE='postgres:17.12-alpine@sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73'
NAME="raijin-bench-migrate-test-$$"
PORT="${BENCH_MIGRATE_TEST_PORT:-55441}"

POSTGRES_PASSWORD="$(openssl rand -hex 16)"
RAIJIN_DB_PASSWORD="$(openssl rand -hex 16)"
BENCH_DB_PASSWORD="$(openssl rand -hex 16)"
export POSTGRES_PASSWORD RAIJIN_DB_PASSWORD BENCH_DB_PASSWORD

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "1/5 Postgres 17.12 jetable ($NAME, 127.0.0.1:$PORT)"
docker run -d --rm --name "$NAME" \
  -e POSTGRES_PASSWORD -e RAIJIN_DB_PASSWORD -e BENCH_DB_PASSWORD \
  -v "$ROOT/infra/postgres/init/10-raijin-databases.sh:/docker-entrypoint-initdb.d/10-raijin-databases.sh:ro" \
  -p "127.0.0.1:$PORT:5432" "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  if docker logs "$NAME" 2>&1 | grep -q 'raijin-postgres : bases raijin et raijin_bench prêtes' \
    && docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres >/dev/null
docker exec "$NAME" psql -U postgres -qc 'CREATE DATABASE bench_shadow OWNER raijin_bench' >/dev/null

BENCH_DATABASE_URL="postgresql://raijin_bench:${BENCH_DB_PASSWORD}@127.0.0.1:${PORT}/raijin_bench?schema=public"
BENCH_SHADOW_DATABASE_URL="postgresql://raijin_bench:${BENCH_DB_PASSWORD}@127.0.0.1:${PORT}/bench_shadow?schema=public"
export BENCH_DATABASE_URL BENCH_SHADOW_DATABASE_URL

echo "2/5 prisma migrate deploy (utilisateur raijin_bench)"
pnpm exec prisma migrate deploy >/dev/null
pnpm exec prisma migrate status | tail -1

echo "3/5 écart migrations ↔ schema.prisma"
pnpm exec prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code >/dev/null
pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code >/dev/null
echo "   aucun écart"

echo "4/5 cloisonnement des bases"
cross() { # $1 utilisateur, $2 variable du mot de passe, $3 base : doit échouer FAUTE DE DROIT CONNECT
  local out
  if out=$(PGPASSWORD="${!2}" docker exec -e PGPASSWORD "$NAME" psql -h 127.0.0.1 -U "$1" -d "$3" -tAc 'SELECT 1' 2>&1); then
    echo "ÉCHEC : $1 peut se connecter à $3" >&2
    exit 1
  fi
  case "$out" in
    *'does not have CONNECT privilege'*) echo "   $1 → $3 : refusé (pas de droit CONNECT)" ;;
    *) echo "ÉCHEC : refus inattendu pour $1 → $3 (mot de passe ou serveur ?)" >&2; exit 1 ;;
  esac
}
cross raijin_bench BENCH_DB_PASSWORD raijin
cross raijin RAIJIN_DB_PASSWORD raijin_bench
super=$(PGPASSWORD="$BENCH_DB_PASSWORD" docker exec -e PGPASSWORD "$NAME" psql -h 127.0.0.1 -U raijin_bench -d raijin_bench -tAc \
  "SELECT rolsuper OR rolcreaterole OR rolcreatedb FROM pg_roles WHERE rolname = current_user")
[ "$super" = "f" ] || { echo "ÉCHEC : raijin_bench a des droits d'administration" >&2; exit 1; }
echo "   raijin_bench : ni superutilisateur, ni CREATEROLE, ni CREATEDB"

echo "5/5 déclencheurs et fonctions SQL"
if ! out=$(FORCE_COLOR=0 BENCH_TEST_DATABASE_URL="$BENCH_DATABASE_URL" pnpm exec jest -c jest.db.config.cts --runInBand 2>&1); then
  printf '%s\n' "$out" | tail -40 >&2
  echo "ÉCHEC : tests des déclencheurs" >&2
  exit 1
fi
printf '%s\n' "$out" | grep -E '(Tests|Test Suites):' || true
echo "migrations raijin_bench : OK"
