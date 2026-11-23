#!/usr/bin/env bash
# shellcheck disable=SC2015,SC2012
# (ok/ko ne peuvent pas échouer : « A && ok || ko » est sûr ici ; noms de dumps maîtrisés, horodatés.)
# Test de infra/backup.sh et infra/restore.sh sur un conteneur Postgres JETABLE « raijin-restore-test », créé
# puis supprimé par ce script (--rm). Ne touche à aucun autre conteneur. Lancé par le job CI « images » ; en local :
#   infra/ci/test-restore.sh            (Docker requis ; dossier de travail sous tmp/ du dépôt, ignoré par Git)
# Scénarios : init (rôles non superutilisateurs, CONNECT croisé refusé, idempotence), sauvegarde, --check,
# --into réussi, --into refusé si une session est ouverte (--no-service), renommage refusé → base d'origine intacte,
# restauration en échec → retour automatique.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
ROOT="$PWD"
C=raijin-restore-test
IMAGE='postgres:17.12-alpine@sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73'
WORK="$ROOT/tmp/restore-test"
failures=0

ok() { printf '  ok   %s\n' "$*"; }
ko() { printf '  ÉCHEC %s\n' "$*"; failures=$((failures + 1)); }
psql_su() { docker exec -i "$C" psql -X -q -t -A -U postgres "$@"; }
users_in_raijin() { psql_su -d raijin -c 'SELECT count(*) FROM rt_users;' 2>/dev/null || echo "?"; }
cleanup() {
  docker exec -u postgres "$C" pg_ctl stop -m fast -D /var/lib/postgresql/data >/dev/null 2>&1 || true
  [[ -d "$WORK" ]] && find "$WORK" -mindepth 1 -delete && rmdir "$WORK"
}
trap cleanup EXIT

docker inspect "$C" >/dev/null 2>&1 && { echo "le conteneur $C existe déjà : abandon (il n'est pas à ce test)." >&2; exit 1; }
mkdir -p "$WORK/backups"
umask 077
export RAIJIN_PG_CONTAINER="$C" RAIJIN_ENV_FILE=/nonexistent RAIJIN_API_ENV_FILE=/nonexistent BACKUP_DIR="$WORK/backups"

echo "== Démarrage de $C (jetable)"
docker run -d --rm --name "$C" \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$(openssl rand -hex 24)" -e POSTGRES_DB=postgres \
  -e RAIJIN_DB_PASSWORD="$(openssl rand -hex 24)" -e BENCH_DB_PASSWORD="$(openssl rand -hex 24)" \
  -v "$ROOT/infra/postgres/init:/docker-entrypoint-initdb.d:ro" "$IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$C" pg_isready -U postgres -h 127.0.0.1 -q 2>/dev/null && break; sleep 1; done

echo "== Init"
[[ "$(psql_su -d postgres -c "SELECT string_agg(rolname||':'||rolsuper, ',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'raijin%';")" == "raijin:false,raijin_bench:false" ]] \
  && ok "rôles raijin et raijin_bench non superutilisateurs" || ko "rôles"
if docker exec -e PGPASSWORD=x "$C" psql -h 127.0.0.1 -U raijin -d raijin_bench -c 'select 1' >/dev/null 2>&1; then ko "raijin peut se connecter à raijin_bench"; else ok "connexion croisée refusée"; fi
[[ "$(psql_su -d postgres -c "SELECT has_database_privilege('raijin','raijin_bench','CONNECT');")" == "f" ]] && ok "CONNECT croisé absent" || ko "CONNECT croisé"
docker exec "$C" sh /docker-entrypoint-initdb.d/10-raijin-databases.sh >/dev/null && ok "init idempotent" || ko "init relancé"

echo "== Données de test"
psql_su -d raijin -c "SET ROLE raijin; CREATE TABLE _prisma_migrations (id text PRIMARY KEY, migration_name text, finished_at timestamptz);
  INSERT INTO _prisma_migrations VALUES ('1','20260101000000_init',now());
  CREATE TABLE rt_users (id int PRIMARY KEY); INSERT INTO rt_users SELECT generate_series(1,25);"

echo "== Sauvegarde"
infra/backup.sh --no-offsite >/dev/null && ok "backup.sh" || ko "backup.sh"
dump="$(ls -t "$BACKUP_DIR"/raijin_2*.dump | head -n 1)"
[[ -s "$dump" && -s "$dump.sha256" ]] && ok "fichier + sha256" || ko "fichier de sauvegarde"

echo "== --check"
infra/restore.sh --check "$dump" >/dev/null && ok "restauration de test" || ko "restore --check"
[[ "$(psql_su -d postgres -c "SELECT count(*) FROM pg_database WHERE datname = 'raijin_restore_check';")" == 0 ]] && ok "base de test supprimée" || ko "base de test restante"

echo "== --into refusé : session ouverte (--no-service)"
psql_su -d raijin -c 'DELETE FROM rt_users WHERE id > 10;'
docker exec -d "$C" psql -U postgres -d raijin -c 'SELECT pg_sleep(20);'
sleep 1
if infra/restore.sh --into raijin --yes --no-service "$dump" >/dev/null 2>&1; then ko "restauration acceptée malgré une session"; else ok "refus avec session ouverte"; fi
[[ "$(users_in_raijin)" == 10 ]] && ok "base d'origine intacte (10 lignes)" || ko "base d'origine modifiée : $(users_in_raijin)"
psql_su -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'raijin' AND pid <> pg_backend_pid();" >/dev/null

echo "== --into refusé : renommage impossible (nom de destination déjà pris)"
psql_su -d postgres -c 'CREATE DATABASE raijin_avant_restauration_refus;'
if RAIJIN_RESTORE_STAMP=refus infra/restore.sh --into raijin --yes --no-service "$dump" >/dev/null 2>&1; then ko "restauration acceptée"; else ok "renommage refusé → abandon"; fi
[[ "$(users_in_raijin)" == 10 ]] && ok "base d'origine intacte après renommage refusé" || ko "base d'origine perdue : $(users_in_raijin)"
psql_su -d postgres -c 'DROP DATABASE raijin_avant_restauration_refus;'

echo "== --into réussi"
RAIJIN_RESTORE_STAMP=ok infra/restore.sh --into raijin --yes --no-service "$dump" >/dev/null && ok "restore --into" || ko "restore --into"
[[ "$(users_in_raijin)" == 25 ]] && ok "25 lignes restaurées" || ko "lignes restaurées : $(users_in_raijin)"
[[ "$(psql_su -d raijin -c "SELECT tableowner FROM pg_tables WHERE tablename = 'rt_users';")" == raijin ]] && ok "tables à raijin" || ko "propriétaire des tables"
[[ "$(psql_su -d raijin_avant_restauration_ok -c 'SELECT count(*) FROM rt_users;')" == 10 ]] && ok "ancienne base conservée (renommée)" || ko "ancienne base"

echo "== --into en échec → retour automatique"
bench_dump="$(ls -t "$BACKUP_DIR"/raijin_bench_2*.dump | head -n 1)"
if RAIJIN_RESTORE_STAMP=ko infra/restore.sh --into raijin --yes --no-service "$bench_dump" >/dev/null 2>&1; then ko "restauration vide acceptée"; else ok "restauration vide refusée"; fi
[[ "$(users_in_raijin)" == 25 ]] && ok "base remise en place (25 lignes)" || ko "base après retour : $(users_in_raijin)"

if (( failures > 0 )); then echo "$failures échec(s)."; exit 1; fi
echo "Tous les tests de sauvegarde et de restauration sont verts."
