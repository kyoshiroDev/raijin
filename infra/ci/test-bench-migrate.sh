#!/usr/bin/env bash
# shellcheck disable=SC2015
# (ok/ko ne peuvent pas échouer : « A && ok || ko » est sûr ici.)
# Test de infra/bench-migrate.sh sur DEUX conteneurs Postgres JETABLES créés puis supprimés par ce script (--rm) :
#   raijin-bench-migrate-ci-src : FAUX Supabase (rôles anon/authenticated/service_role, auth.users et auth.uid()
#                                 factices, les 29 migrations de legacy/supabase/migrations rejouées, données factices) ;
#   raijin-bench-migrate-ci-dst : faux raijin-postgres (infra/postgres/init, migrations de libs/bench/prisma
#                                 appliquées par l'utilisateur raijin_bench).
# Jamais Supabase réel, jamais un conteneur existant (abandon si un nom est déjà pris). Lancé par le job CI
# « images » ; en local : infra/ci/test-bench-migrate.sh (Docker requis).
# Variables : BENCH_MIGRATE_CI_NAME (préfixe des conteneurs, raijin-bench-migrate-ci par défaut),
#             BENCH_MIGRATE_CI_PORT (port local du faux Supabase, 55462 par défaut).
# Scénarios : listes cohérentes avec bench-tables.ts ; refus (pas d'URL, pas de bench_owner, session ouverte,
# plusieurs comptes, mauvais mot de passe, fenêtre trop longue) ; --dry-run sans écriture ; écart injecté → échec
# et base vide ; migration (+ --archive) ; réimport refusé sans doublon ; --check vert puis rouge sur écart ;
# --shadow-snapshot (deux fois, rechargement) ; source inchangée et lue sans aucune écriture ; URL jamais affichée.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
ROOT="$PWD"
PREFIX="${BENCH_MIGRATE_CI_NAME:-raijin-bench-migrate-ci}"
[[ "$PREFIX" =~ ^raijin-bench-migrate-ci[a-z0-9-]*$ ]] || { echo "BENCH_MIGRATE_CI_NAME invalide." >&2; exit 1; }
SRC="$PREFIX-src"
DST="$PREFIX-dst"
PORT="${BENCH_MIGRATE_CI_PORT:-55462}"
IMAGE='postgres:17.12-alpine@sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73'
OWNER_UUID=11111111-1111-4111-8111-111111111111
OTHER_UUID=22222222-2222-4222-8222-222222222222
WORK="$(mktemp -d)"
failures=0

ok() { printf '  ok   %s\n' "$*"; }
ko() { printf '  ÉCHEC %s\n' "$*"; failures=$((failures + 1)); }
src_q() { docker exec -i "$SRC" psql -X -q -t -A -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }
dst_q() { docker exec -i "$DST" psql -X -q -t -A -v ON_ERROR_STOP=1 -U postgres -d raijin_bench "$@"; }
count_dst() { dst_q -c "SELECT count(*) FROM $1;" 2>/dev/null || echo "?"; }
count_src() { src_q -c "SELECT count(*) FROM $1;" 2>/dev/null || echo "?"; }
cleanup() {
  local c
  for c in "$SRC" "$DST"; do
    # Conteneurs de CE test seulement (noms vérifiés absents au démarrage) ; --rm les supprime à l'arrêt.
    docker exec -u postgres "$c" pg_ctl stop -m fast -D /var/lib/postgresql/data >/dev/null 2>&1 || true
  done
  for c in "$SRC" "$DST"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  find "$WORK" -mindepth 1 -delete 2>/dev/null; rmdir "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

for c in "$SRC" "$DST"; do
  docker inspect "$c" >/dev/null 2>&1 && { echo "le conteneur $c existe déjà : abandon (il n'est pas à ce test)." >&2; trap - EXIT; exit 1; }
done
umask 077

# Mot de passe source avec caractères à encoder dans l'URL (@ : / %) : vérifie le décodage.
SRC_PW="p@ss:w/rd%$(openssl rand -hex 12)"
SRC_PW_ENC="${SRC_PW//%/%25}"; SRC_PW_ENC="${SRC_PW_ENC//@/%40}"; SRC_PW_ENC="${SRC_PW_ENC//:/%3A}"; SRC_PW_ENC="${SRC_PW_ENC//\//%2F}"
SRC_URL="postgresql://postgres:${SRC_PW_ENC}@127.0.0.1:${PORT}/postgres?sslmode=disable"
HEX_PART="${SRC_PW##*%}"
export RAIJIN_PG_CONTAINER="$DST" RAIJIN_ENV_FILE=/nonexistent RAIJIN_API_ENV_FILE=/nonexistent RAIJIN_NO_ALERT=1
export BENCH_MIGRATE_DUMP_NETWORK=host
unset BENCH_SOURCE_DATABASE_URL RAIJIN_TEST_FAULT

# Lance bench-migrate.sh avec l'URL dans l'environnement ; sortie dans $WORK/out ; vérifie que l'URL et le mot de passe
# n'apparaissent jamais dans la sortie.
leaks=0
run() {
  local rc=0
  BENCH_SOURCE_DATABASE_URL="$SRC_URL" infra/bench-migrate.sh "$@" >"$WORK/out" 2>&1 </dev/null || rc=$?
  if grep -qF -e "$HEX_PART" -e "$SRC_PW_ENC" "$WORK/out"; then leaks=$((leaks + 1)); fi
  return "$rc"
}
said() { grep -qF -- "$1" "$WORK/out"; }

echo "== Listes de tables cohérentes avec libs/bench/prisma/src/lib/bench-tables.ts"
TS=libs/bench/prisma/src/lib/bench-tables.ts
ts_list() { awk -v name="$1" '$0 ~ "export const " name " = " {f=1; next} f && /\]/ {f=0} f' "$TS" | grep -oE "'[a-z_0-9]+'" | tr -d "'" | sort | tr '\n' ' '; }
sh_list() { awk -v name="$1" '$0 ~ "^" name "=\\(" {f=1} f {print} f && /\)/ {f=0}' infra/bench-migrate.sh | sed -E "s/^$1=\\(//; s/\\)//" | tr ' ' '\n' | grep -E '^[a-z_0-9]+$' | sort | tr '\n' ' '; }
[[ "$(ts_list PORTED_TABLES)" == "$(sh_list PORTED_TABLES)" && -n "$(sh_list PORTED_TABLES)" ]] && ok "21 tables portées" || ko "PORTED_TABLES différentes"
[[ "$(ts_list DEAD_TABLES)" == "$(sh_list DEAD_TABLES)" && -n "$(sh_list DEAD_TABLES)" ]] && ok "tables mortes" || ko "DEAD_TABLES différentes"
shadow_ts="$(awk '/export const SHADOW_REF_DAY_COLUMNS = /{f=1; next} f && /\}/{f=0} f' "$TS" | grep -oE '^ *[a-z_]+:' | tr -d ' :' | sort | tr '\n' ' ')"
[[ "$shadow_ts" == "$(sh_list SHADOW_TABLES)" ]] && ok "tables du mode ombre" || ko "SHADOW_TABLES différentes"
bash -n infra/bench-migrate.sh && ok "bash -n" || ko "bash -n"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -x infra/bench-migrate.sh infra/ci/test-bench-migrate.sh && ok "shellcheck" || ko "shellcheck"
fi

echo "== Démarrage des conteneurs jetables"
docker run -d --rm --name "$SRC" -e POSTGRES_PASSWORD="$SRC_PW" -p "127.0.0.1:${PORT}:5432" "$IMAGE" \
  -c log_statement=all -c 'log_line_prefix=%a|' >/dev/null
docker run -d --rm --name "$DST" \
  -e POSTGRES_PASSWORD="$(openssl rand -hex 24)" -e RAIJIN_DB_PASSWORD="$(openssl rand -hex 24)" -e BENCH_DB_PASSWORD="$(openssl rand -hex 24)" \
  -v "$ROOT/infra/postgres/init:/docker-entrypoint-initdb.d:ro" "$IMAGE" >/dev/null
for c in "$SRC" "$DST"; do
  for _ in $(seq 1 60); do docker exec "$c" pg_isready -U postgres -h 127.0.0.1 -q 2>/dev/null && break; sleep 1; done
done
for _ in $(seq 1 30); do docker logs "$DST" 2>&1 | grep -q 'bases raijin et raijin_bench prêtes' && break; sleep 1; done
sleep 1

echo "== Faux Supabase : schéma rejoué depuis legacy/supabase/migrations + données factices"
src_q >/dev/null 2>&1 <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ select nullif(current_setting('request.jwt.claim.role', true), '')::text $$;
CREATE PUBLICATION supabase_realtime;
SQL
replayed=0
for f in legacy/supabase/migrations/*.sql; do
  src_q >/dev/null 2>"$WORK/err" <"$f" || { cat "$WORK/err" >&2; ko "migration Supabase $f"; break; }
  replayed=$((replayed + 1))
done
[[ "$replayed" -ge 29 ]] && ok "$replayed migrations Supabase rejouées" || ko "migrations rejouées : $replayed"
src_q >/dev/null <<'SQL'
BEGIN;
SET LOCAL session_replication_role = replica;
CREATE FUNCTION pg_temp.m(p text, i int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ select rpad(p || translate(i::text, '0', 'z'), 44, 'a') $$;
INSERT INTO auth.users (id, email) VALUES ('11111111-1111-4111-8111-111111111111', 'proprio@example.test'), ('22222222-2222-4222-8222-222222222222', 'autre@example.test');
INSERT INTO public.tokens (mint, symbol, pair_address, price_usd, market_cap, liquidity_usd, volume_24h, first_seen_at, score)
  SELECT pg_temp.m('Tk', i), 'TK' || i, pg_temp.m('Pa', i), 0.0001 * i, 1000 * i, 500 * i, 42.5 * i, now() - (i || ' hours')::interval, i % 100 FROM generate_series(1, 60) i;
-- Textes piégeux pour COPY : tabulation, retour à la ligne, antislash, guillemets, Unicode, faux en-tête COPY.
UPDATE public.tokens SET name = E'Nom\t"cité"\\ é 🙂' WHERE mint = pg_temp.m('Tk', 1);
UPDATE public.tokens SET name = E'x\nCOPY public.tokens (mint) FROM stdin;\n\\.' WHERE mint = pg_temp.m('Tk', 2);
INSERT INTO public.token_snapshots (mint, price_usd, market_cap, liquidity_usd, volume_24h, captured_at)
  SELECT pg_temp.m('Tk', 1 + i % 60), 0.0001 * i, 1000 + i, 500 + i, 10 + i, now() - (i * 7 || ' minutes')::interval FROM generate_series(1, 2500) i;
INSERT INTO public.scan_runs (started_at, sol_usd, eur_usd, source_counts) SELECT now() - (i * 2 || ' hours')::interval, 150 + i, 1.08, '{"dexscreener": 3}' FROM generate_series(1, 90) i;
INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth) VALUES
  ('11111111-1111-4111-8111-111111111111', 'https://fcm.googleapis.com/fcm/send/a', repeat('A', 87), repeat('a', 22)),
  ('11111111-1111-4111-8111-111111111111', 'https://fcm.googleapis.com/fcm/send/b', repeat('B', 87), repeat('b', 22)),
  ('22222222-2222-4222-8222-222222222222', 'https://fcm.googleapis.com/fcm/send/c', repeat('C', 87), repeat('c', 22));
INSERT INTO public.alert_settings (user_id, min_score) VALUES ('11111111-1111-4111-8111-111111111111', 70);
INSERT INTO public.alert_log (user_id, mint, kind, sent_at, entry_score)
  SELECT '11111111-1111-4111-8111-111111111111', pg_temp.m('Tk', i), 'grouped', now() - (i || ' hours')::interval, 50 FROM generate_series(1, 20) i;
-- Ligne historique antérieure à alert_log_single_has_plan (NOT VALID) : « single » sans plan.
ALTER TABLE public.alert_log DROP CONSTRAINT alert_log_single_has_plan;
INSERT INTO public.alert_log (user_id, mint, kind, sent_at) VALUES ('11111111-1111-4111-8111-111111111111', pg_temp.m('Tk', 21), 'single', now() - interval '30 hours');
ALTER TABLE public.alert_log ADD CONSTRAINT alert_log_single_has_plan CHECK (((kind <> 'single'::text) OR ((entry_price IS NOT NULL) AND (target_price IS NOT NULL) AND (stop_price IS NOT NULL) AND (rr IS NOT NULL) AND (stake_sol IS NOT NULL) AND (max_price IS NOT NULL) AND (min_price IS NOT NULL)))) NOT VALID;
INSERT INTO public.signal_outcomes (mint, pair_address, detected_at, entry_price, features)
  SELECT pg_temp.m('Tk', i), pg_temp.m('Pa', i), now() - (i * 3 || ' hours')::interval, 0.001 * i, jsonb_build_object('i', i) FROM generate_series(1, 30) i;
INSERT INTO public.paper_wallets (user_id, book) VALUES ('11111111-1111-4111-8111-111111111111', 'main'), ('11111111-1111-4111-8111-111111111111', 'all_x2');
INSERT INTO public.paper_positions (user_id, mint, symbol, strategy, stake_sol, entry_target_price, sl_price, created_at, expires_at, alert_id)
  SELECT '11111111-1111-4111-8111-111111111111', pg_temp.m('Tk', i), 'TK' || i, 'all_x2', 0.1, 1, 0.5, now() - (i || ' hours')::interval, now() - (i || ' hours')::interval + interval '2 hours', (SELECT min(id) FROM public.alert_log) + i
  FROM generate_series(1, 6) i;
INSERT INTO public.paper_legs (position_id, user_id, size_pct, tp_price, stop_price)
  SELECT id, user_id, 100, 2, 0.5 FROM public.paper_positions;
INSERT INTO public.preset_signals (preset, mint, pair_address, detected_at, entry_price)
  SELECT (ARRAY['momentum','strict','young_calm'])[1 + i % 3], pg_temp.m('Tk', i), pg_temp.m('Pa', i), now() - (i * 5 || ' hours')::interval, 0.002 * i FROM generate_series(1, 12) i;
INSERT INTO public.ohlcv_candles (mint, pool, tf, ts_start, step_s, ts, o, h, l, c, v, source, detected_at)
  SELECT pg_temp.m('Tk', i), pg_temp.m('Pa', i), '1m', now() - (i || ' days')::interval, 60, ARRAY[0, 60, 120], ARRAY[1.5, 2.25, 3.125]::real[], ARRAY[2, 3, 4]::real[], ARRAY[1, 1, 2]::real[], ARRAY[1.75, 2.5, 3]::real[], ARRAY[10, 20, 30]::real[], 'signal_outcomes', now() - (i || ' days')::interval
  FROM generate_series(1, 5) i;
INSERT INTO public.backtest_runs (trigger, requested_by, status, params, created_at) VALUES
  ('nightly', NULL, 'queued', '{}', now() - interval '2 days'),
  ('manual', '11111111-1111-4111-8111-111111111111', 'queued', '{"a": 1}', now() - interval '1 day'),
  ('manual', '22222222-2222-4222-8222-222222222222', 'queued', '{"b": 2}', now() - interval '3 hours');
INSERT INTO public.backtest_trades (run_id, source, mint, detected_at, split, preset_flags, narrative, returns)
  SELECT (SELECT min(id) FROM public.backtest_runs), 'signal_outcomes', pg_temp.m('Tk', i), now() - (i || ' days')::interval, 'train', 1, 'gta', array_fill(0.25::real, ARRAY[384]) FROM generate_series(1, 4) i;
INSERT INTO public.backtest_results (run_id, preset, exit, sl_pct, breakeven, time_exit_h, delay_min, narrative, split, trades)
  SELECT (SELECT min(id) FROM public.backtest_runs), 'all', 'all_x2', 30, i = 1, 24, 0, 'all', 'test', 10 * i FROM generate_series(1, 2) i;
INSERT INTO public.backtest_events (preset, mint, pool, event_at, entry_snapshot_id, price_at_event, roundtrip_known, conditions)
  SELECT 'momentum', pg_temp.m('Tk', i), pg_temp.m('Pa', i), now() - (i || ' hours')::interval, i, 0.01 * i, false, '{}' FROM generate_series(1, 3) i;
INSERT INTO public.backtest_event_state (key, state) VALUES ('cursor', '{"id": 3}'), (pg_temp.m('Tk', 1), '{}');
INSERT INTO public.label_runs (requests, rate_limited, rows_written, labels, candles, failed, queued, ms, at)
  SELECT 5, 1, 3, 2, 1, 0, 4, 1200 + i, now() - (i * 2 || ' hours')::interval FROM generate_series(1, 15) i;
INSERT INTO public.wallet_study_state (mint, pair_address, detected_at) SELECT pg_temp.m('Tk', i), pg_temp.m('Pa', i), now() - (i || ' days')::interval FROM generate_series(1, 3) i;
INSERT INTO public.early_buyers (mint, wallet, rank, slot, signature) SELECT pg_temp.m('Tk', 1), pg_temp.m('Wa', i), i, 1000 + i, rpad('Sg' || i, 88, 'b') FROM generate_series(1, 4) i;
UPDATE public.wallet_study_budget SET credits_used = 1234 WHERE id = 1;
-- Tables mortes (archive facultative)
INSERT INTO public.watchlist (user_id, mint) VALUES ('11111111-1111-4111-8111-111111111111', pg_temp.m('Tk', 1));
INSERT INTO public.fast_watch (mint, pair_address, until) SELECT pg_temp.m('Tk', i), pg_temp.m('Pa', i), now() + interval '1 hour' FROM generate_series(1, 2) i;
INSERT INTO public.fast_ticks (mint, pair_address, at, price_usd) SELECT pg_temp.m('Tk', 1), pg_temp.m('Pa', 1), now() - (i || ' minutes')::interval, i FROM generate_series(1, 40) i;
INSERT INTO public.model_weights (version, trained_at, payload) VALUES ('v1', now(), '{"w": [1, 2]}');
COMMIT;
SQL
[[ "$(count_src public.token_snapshots)" == 2500 ]] && ok "données factices chargées" || ko "données factices"

# Empreinte de toute la source (contenu de chaque table de public et auth).
src_fingerprint() {
  src_q <<'SQL' | md5sum
SELECT string_agg(format('SELECT %L, md5(coalesce(string_agg(x::text, %L ORDER BY x::text), %L)) FROM %I.%I x', n.nspname || '.' || c.relname, '|', '', n.nspname, c.relname), ' UNION ALL ' ORDER BY n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public', 'auth') AND c.relkind = 'r' \gexec
SQL
}
fp_before="$(src_fingerprint)"

echo "== Faux raijin_bench : migrations Prisma appliquées par l'utilisateur raijin_bench"
applied=0
for f in libs/bench/prisma/prisma/migrations/*/migration.sql; do
  docker exec -i "$DST" psql -X -q -v ON_ERROR_STOP=1 -U raijin_bench -d raijin_bench >/dev/null 2>"$WORK/err" <"$f" \
    || { cat "$WORK/err" >&2; ko "migration $f"; break; }
  applied=$((applied + 1))
done
[[ "$applied" -ge 3 ]] && ok "$applied migrations raijin_bench" || ko "migrations raijin_bench : $applied"
triggers_before="$(dst_q -c "SELECT string_agg(tgrelid::regclass || '.' || tgname || '=' || tgenabled::text, ',' ORDER BY tgrelid::regclass::text, tgname) FROM pg_trigger WHERE NOT tgisinternal;")"

echo "== Refus avant toute lecture de la source"
if infra/bench-migrate.sh --dry-run >"$WORK/out" 2>&1 </dev/null; then ko "accepté sans bench_owner"; else said "bench_owner" && ok "refus sans compte bench_owner" || ko "message bench_owner : $(tail -n 1 "$WORK/out")"; fi
dst_q -c "INSERT INTO public.bench_owner (email) VALUES ('owner@example.test');" >/dev/null
if infra/bench-migrate.sh --dry-run >"$WORK/out" 2>&1 </dev/null; then ko "accepté sans URL"; else said "BENCH_SOURCE_DATABASE_URL absente" && ok "refus sans URL (pas de terminal)" || ko "message sans URL"; fi
docker exec -d "$DST" psql -U postgres -d raijin_bench -c 'SELECT pg_sleep(8);'
sleep 1
if run --dry-run --source-user "$OWNER_UUID"; then ko "accepté avec une session ouverte"; else said "session(s) ouverte(s)" && ok "refus avec une session ouverte (API du banc)" || ko "message session"; fi
sleep 8
if run --shadow-snapshot --since 2026-01-01 --until 2026-03-01; then ko "fenêtre de 59 jours acceptée"; else said "31 jours" && ok "fenêtre > 31 jours refusée" || ko "message fenêtre : $(tail -n 3 "$WORK/out")"; fi
BENCH_SOURCE_DATABASE_URL="postgresql://postgres:mauvais-${HEX_PART}@127.0.0.1:${PORT}/postgres?sslmode=disable" \
  infra/bench-migrate.sh --dry-run >"$WORK/out" 2>&1 </dev/null && ko "mauvais mot de passe accepté" || ok "mauvais mot de passe refusé"
grep -qF "$HEX_PART" "$WORK/out" && ko "mot de passe affiché en cas d'échec" || ok "mot de passe absent du message d'erreur"

echo "== --dry-run"
if run --dry-run; then ko "deux comptes acceptés sans --source-user"; else said "--source-user" && said "$OTHER_UUID" && ok "refus : 2 comptes dans la source, --source-user exigé" || ko "message comptes : $(tail -n 3 "$WORK/out")"; fi
said "lecture seule (default_transaction_read_only=on)" && ok "connexion source en lecture seule vérifiée" || ko "lecture seule non vérifiée"
run --dry-run --archive --source-user "$OWNER_UUID" && ok "simulation verte" || { tail -n 30 "$WORK/out"; ko "simulation"; }
said "SIMULATION RÉUSSIE" && ok "résumé de simulation" || ko "résumé de simulation"
[[ "$(count_dst public.tokens)" == 0 && "$(count_dst public.token_snapshots)" == 0 ]] && ok "rien d'écrit par --dry-run" || ko "--dry-run a écrit"
[[ "$(dst_q -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'archive';")" == 0 ]] && ok "archive vide après --dry-run" || ko "archive écrite par --dry-run"

echo "== Écart injecté → échec et base intacte"
for f in bench_migrate_drift bench_migrate_missing; do
  if RAIJIN_TEST_FAULT="$f" run --yes --source-user "$OWNER_UUID"; then ko "écart $f accepté"; else said "ÉCART" && ok "écart $f détecté" || ko "écart $f : $(tail -n 3 "$WORK/out")"; fi
  [[ "$(count_dst public.tokens)" == 0 && "$(count_dst public.alert_log)" == 0 ]] && ok "transaction annulée ($f)" || ko "écriture partielle après $f"
done

echo "== Migration (+ --archive)"
run --yes --archive --source-user "$OWNER_UUID" && ok "migration" || { tail -n 30 "$WORK/out"; ko "migration"; }
said "MIGRATION RÉUSSIE" && ok "résumé de migration" || ko "résumé de migration"
cp "$WORK/out" "$WORK/migration.out"
same=1
for t in tokens token_snapshots signal_outcomes scan_runs alert_settings alert_log paper_wallets paper_positions paper_legs \
  preset_signals ohlcv_candles backtest_runs backtest_trades backtest_results backtest_events backtest_event_state label_runs \
  wallet_study_state early_buyers wallet_study_budget; do
  [[ "$(count_dst "public.$t")" == "$(count_src "public.$t")" ]] || { same=0; ko "lignes $t : $(count_dst "public.$t") ≠ $(count_src "public.$t")"; }
done
[[ "$same" == 1 ]] && ok "20 tables : mêmes volumes que la source" || true
[[ "$(count_dst public.push_subscriptions)" == 2 ]] && ok "push_subscriptions : seulement celles du compte choisi (2/3)" || ko "push_subscriptions : $(count_dst public.push_subscriptions)"
[[ "$(dst_q -c "SELECT count(*) FILTER (WHERE requested_by = public.bench_owner_id()) || '/' || count(*) FILTER (WHERE requested_by IS NULL) FROM public.backtest_runs;")" == "1/2" ]] \
  && ok "backtest_runs.requested_by : propriétaire ou null" || ko "requested_by"
[[ "$(dst_q -c "SELECT count(DISTINCT user_id) || ':' || bool_and(user_id = public.bench_owner_id()) FROM public.alert_log;")" == "1:true" ]] \
  && ok "alert_log.user_id → bench_owner" || ko "user_id non transformé"
[[ "$(dst_q -c "SELECT name FROM public.tokens WHERE mint LIKE 'Tk1a%';")" == "$(src_q -c "SELECT name FROM public.tokens WHERE mint LIKE 'Tk1a%';")" ]] \
  && ok "texte piégeux identique (tabulation, guillemets, antislash, Unicode)" || ko "texte altéré"
[[ "$(dst_q -c "SELECT md5(name) FROM public.tokens WHERE mint LIKE 'Tk2a%';")" == "$(src_q -c "SELECT md5(name) FROM public.tokens WHERE mint LIKE 'Tk2a%';")" ]] \
  && ok "faux en-tête COPY dans une valeur : identique" || ko "faux en-tête COPY"
ohlcv_sql="SELECT md5(string_agg(id || ts::text || o::text || fetched_at::text, ',' ORDER BY id)) FROM public.ohlcv_candles;"
ohlcv_dst="$(dst_q -c "$ohlcv_sql" 2>&1 || true)"
[[ "$ohlcv_dst" =~ ^[0-9a-f]{32}$ && "$ohlcv_dst" == "$(src_q -c "$ohlcv_sql" 2>&1 || true)" ]] \
  && ok "identifiants, tableaux real[] et dates identiques (ohlcv_candles)" || ko "ohlcv_candles différent"
[[ "$(dst_q -c "SELECT convalidated FROM pg_constraint WHERE conname = 'alert_log_single_has_plan';")" == f ]] && ok "alert_log_single_has_plan remise NOT VALID" || ko "contrainte NOT VALID"
[[ "$(count_dst "public.alert_log WHERE kind = 'single'")" == 1 ]] && ok "ligne historique « single » sans plan importée" || ko "ligne historique"
if dst_q -c "INSERT INTO public.alert_log (user_id, mint, kind) VALUES (public.bench_owner_id(), 'Tk1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'single');" >/dev/null 2>&1; then
  ko "contrainte NOT VALID inactive pour les nouvelles lignes"; else ok "contrainte toujours appliquée aux nouvelles lignes"; fi
[[ "$(dst_q -c "SELECT nextval(pg_get_serial_sequence('public.token_snapshots', 'id')) > (SELECT max(id) FROM public.token_snapshots);")" == t ]] \
  && ok "séquences recalées (setval)" || ko "séquence non recalée"
[[ "$(dst_q -c "SELECT string_agg(tgrelid::regclass || '.' || tgname || '=' || tgenabled::text, ',' ORDER BY tgrelid::regclass::text, tgname) FROM pg_trigger WHERE NOT tgisinternal;")" == "$triggers_before" ]] \
  && ok "déclencheurs remis dans leur état d'origine" || ko "état des déclencheurs modifié"
[[ "$(count_dst archive.fast_ticks)" == 40 && "$(count_dst archive.watchlist)" == 1 ]] && ok "archive : tables mortes copiées" || ko "archive tables mortes"
[[ "$(dst_q -c "SELECT count(*) || ':' || sum(score::int) FROM archive.tokens_colonnes_archivees;")" == "60:$(src_q -c 'SELECT sum(score) FROM public.tokens;')" ]] \
  && ok "archive : colonnes retirées (tokens.score…) avec la clé" || ko "archive colonnes"
[[ "$(dst_q -c "SELECT tableowner FROM pg_tables WHERE schemaname = 'archive' LIMIT 1;")" == raijin_bench ]] && ok "objets créés par raijin_bench" || ko "propriétaire archive"
grep -q "colonnes ignorées" "$WORK/migration.out" && ok "colonnes retirées signalées dans le résumé" || ko "colonnes ignorées non signalées"

echo "== Réimport : refusé, aucun doublon"
n_before="$(count_dst public.token_snapshots)"
if run --yes --source-user "$OWNER_UUID"; then ko "réimport accepté"; else said "n'est pas vide" && ok "réimport refusé (base non vide)" || ko "message réimport"; fi
[[ "$(count_dst public.token_snapshots)" == "$n_before" ]] && ok "aucun doublon" || ko "doublons après réimport"

echo "== --check"
run --check --source-user "$OWNER_UUID" && said "CONTRÔLE RÉUSSI" && ok "--check vert après migration" || { tail -n 30 "$WORK/out"; ko "--check"; }
dst_q -c "UPDATE public.scan_runs SET sol_usd = sol_usd + 1 WHERE id = (SELECT min(id) FROM public.scan_runs);" >/dev/null
if run --check --source-user "$OWNER_UUID"; then ko "--check vert malgré un écart"; else said "absente(s) ou différente(s)" && ok "--check rouge sur une valeur modifiée" || ko "message --check"; fi
dst_q -c "UPDATE public.scan_runs SET sol_usd = sol_usd - 1 WHERE id = (SELECT min(id) FROM public.scan_runs);" >/dev/null

echo "== --shadow-snapshot"
since="$(date -u -d '2 days ago' '+%Y-%m-%dT%H:%MZ')"
until="$(date -u -d '1 hour' '+%Y-%m-%dT%H:%MZ')"
dst_q -c "INSERT INTO shadow_ref.tokens (mint) VALUES ('ancien');" >/dev/null 2>&1 || true
for pass in 1 2; do
  run --shadow-snapshot --since "$since" --until "$until" && said "INSTANTANÉ RÉUSSI" && ok "instantané $pass" || { tail -n 30 "$WORK/out"; ko "instantané $pass"; }
done
shadow_ok=1
for pair in tokens:first_seen_at token_snapshots:captured_at scan_runs:started_at alert_log:sent_at paper_positions:created_at \
  signal_outcomes:detected_at preset_signals:detected_at; do
  t="${pair%%:*}"; col="${pair#*:}"
  want="$(count_src "public.$t WHERE $col >= '$since' AND $col < '$until'")"
  got="$(count_dst "shadow_ref.$t")"
  [[ "$want" == "$got" && "$want" != 0 ]] || { shadow_ok=0; ko "shadow_ref.$t : $got ≠ $want"; }
done
[[ "$shadow_ok" == 1 ]] && ok "shadow_ref = fenêtre de la source (7 tables, rechargées sans doublon)" || true
[[ "$(dst_q -c "SELECT count(*) || ':' || (SELECT (row_counts->>'token_snapshots') FROM shadow_ref.snapshot_meta ORDER BY taken_at DESC LIMIT 1) FROM shadow_ref.snapshot_meta;")" == "2:$(count_dst shadow_ref.token_snapshots)" ]] \
  && ok "snapshot_meta : une ligne par instantané, volumes enregistrés" || ko "snapshot_meta"
said "VPS (public, même fenêtre)" && ok "volumes VPS de la même fenêtre affichés" || ko "volumes VPS absents"

echo "== Source : inchangée et lue sans écriture"
[[ "$(src_fingerprint)" == "$fp_before" ]] && ok "contenu de la source identique" || ko "source modifiée"
docker logs "$SRC" 2>&1 | grep '^raijin-bench-migrate|' >"$WORK/src.log" || true
[[ -s "$WORK/src.log" ]] && ok "connexions de bench-migrate journalisées par la source" || ko "aucune connexion journalisée"
if grep -iE 'statement: *(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|VACUUM|CALL|DO|SELECT +[a-z_.]*(setval|nextval|pg_terminate))' "$WORK/src.log" \
  || grep -iE 'statement: *COPY .* FROM' "$WORK/src.log"; then ko "instruction d'écriture envoyée à la source"; else ok "aucune instruction d'écriture vers la source"; fi
[[ "$leaks" == 0 ]] && ok "URL et mot de passe jamais affichés (sortie de chaque exécution contrôlée)" || ko "URL ou mot de passe affichés ($leaks fois)"
docker ps -a --format '{{.Names}}' | grep -q '^raijin-bench-migrate-src-' && ko "conteneur de lecture restant" || ok "conteneurs de lecture supprimés"

if (( failures > 0 )); then echo "$failures échec(s)."; exit 1; fi
echo "Tous les tests de bench-migrate sont verts."
