#!/usr/bin/env bash
# =====================================================================================================
# Import des données de l'ancien banc (Supabase) dans raijin_bench — lancé UNIQUEMENT par l'utilisateur.
# Procédure complète : docs/BENCH.md §11. Aucun agent ne lance ce script sur le VPS.
#
#   infra/bench-migrate.sh [--archive] [--source-user UUID] [--yes]
#       Migration de l'historique : les 21 tables portées (docs/BENCH.md §4) dans le schéma public de
#       raijin_bench. Refusée si une de ces tables contient déjà une ligne, si l'API du banc a une session
#       ouverte, ou si le compte bench_owner n'existe pas (CLI create-owner d'abord). Confirmation tapée.
#   infra/bench-migrate.sh --dry-run [--archive] [--source-user UUID]
#       Même import, mêmes contrôles, puis ANNULATION de la transaction : rien n'est écrit.
#   infra/bench-migrate.sh --check [--source-user UUID]
#       Contrôle après migration, sans écriture : chaque ligne de la source doit exister à l'identique
#       dans la cible (code de sortie ≠ 0 sinon).
#   infra/bench-migrate.sh --shadow-snapshot --since DATE [--until DATE]
#       Mode ombre : copie la fenêtre comparée [since, until[ (≤ 31 jours, until = maintenant par défaut)
#       des 7 tables comparées dans le schéma shadow_ref (rechargées entièrement) + une ligne snapshot_meta.
#       Ne touche pas à public ; l'API du banc peut tourner.
#
# Options : --archive (alias --with-archive) copie aussi dans le schéma archive les tables mortes et les
# colonnes retirées de public (valeurs au format texte de COPY ; facultatif, P3/P4) ; --source-user UUID
# choisit le compte Supabase importé si la source en contient plusieurs (les autres sont exclus) ;
# --yes : sans question.
#
# Source (Supabase) : URL Postgres lue dans la variable BENCH_SOURCE_DATABASE_URL, ou demandée au clavier
# (saisie masquée). Elle n'est jamais écrite sur disque persistant, jamais affichée, jamais passée en argument :
# découpée en variables PG* transmises par nom à un conteneur jetable (docker run -e NOM) ; le mot de passe passe
# par un PGPASSFILE en volume tmpfs (0600, monté en lecture seule, supprimé à la sortie : absent de docker inspect). Connexion en
# lecture seule (default_transaction_read_only=on, vérifié avant tout) ; pg_dump --data-only seulement.
# Cible : raijin_bench dans le conteneur raijin-postgres (RAIJIN_PG_CONTAINER, seuls les raijin-… acceptés),
# rôle raijin_bench, UNE transaction (identifiants d'origine gardés : OVERRIDING SYSTEM VALUE puis setval ;
# déclencheurs suspendus pendant la copie ; contraintes NOT VALID retirées puis remises NOT VALID).
# Variable facultative : BENCH_MIGRATE_DUMP_NETWORK (réseau Docker du conteneur de lecture, « host » par défaut).
# =====================================================================================================
set -Eeuo pipefail
umask 077
RAIJIN_SCRIPT=bench-migrate
# shellcheck source=infra/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

TARGET_DB=raijin_bench
# Listes de libs/bench/prisma/src/lib/bench-tables.ts (cohérence vérifiée par infra/ci/test-bench-migrate.sh).
# Tables portées, dans l'ordre des clés étrangères (parents d'abord).
PORTED_TABLES=(tokens token_snapshots signal_outcomes scan_runs push_subscriptions alert_settings alert_log
  paper_wallets paper_positions paper_legs preset_signals ohlcv_candles backtest_runs backtest_trades
  backtest_results backtest_events backtest_event_state label_runs wallet_study_state early_buyers
  wallet_study_budget)
DEAD_TABLES=(watchlist model_weights paper_orders_v1 early_candidates early_observations early_outcomes
  early_runs fast_watch fast_ticks test_push_throttle)
SHADOW_TABLES=(tokens token_snapshots scan_runs alert_log paper_positions signal_outcomes preset_signals)

mode=migrate archive=0 assume_yes=0 since="" until="" source_user=""

usage() { sed -n '2,34p' "$0"; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) mode=dry-run; shift ;;
    --check) mode=check; shift ;;
    --shadow-snapshot) mode=shadow; shift ;;
    --archive|--with-archive) archive=1; shift ;;
    --since) since="${2:-}"; shift 2 || usage 1 ;;
    --until) until="${2:-}"; shift 2 || usage 1 ;;
    --source-user) source_user="${2:-}"; shift 2 || usage 1 ;;
    --yes) assume_yes=1; shift ;;
    -h|--help) usage 0 ;;
    *) die "option inconnue : $1 (voir --help)" ;;
  esac
done

DATE_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$'
UUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
if [[ "$mode" == shadow ]]; then
  [[ -n "$since" ]] || die "--shadow-snapshot exige --since DATE (ex. 2026-12-01 ou 2026-12-01T00:00Z)."
  [[ "$since" =~ $DATE_RE ]] || die "--since : date invalide."
  [[ -z "$until" || "$until" =~ $DATE_RE ]] || die "--until : date invalide."
  [[ "$archive" == 0 && -z "$source_user" ]] || die "--archive et --source-user ne s'appliquent pas à --shadow-snapshot."
else
  [[ -z "$since" && -z "$until" ]] || die "--since / --until ne s'utilisent qu'avec --shadow-snapshot."
fi
[[ "$mode" != check || "$archive" == 0 ]] || die "--check ne s'utilise pas avec --archive."
[[ -z "$source_user" || "$source_user" =~ $UUID_RE ]] || die "--source-user : UUID invalide."

require_cmd docker awk
require_pg_container

# Tests seulement (infra/ci/test-bench-migrate.sh) : écart injecté après la copie.
fault="${RAIJIN_TEST_FAULT:-}"
case "$fault" in ""|bench_migrate_drift|bench_migrate_missing) ;; *) fault="" ;; esac

# ---------------------------------------------------------------------------------------------------
# 1. Contrôles de la cible (avant tout contact avec la source)
# ---------------------------------------------------------------------------------------------------
pg_db_exists "$TARGET_DB" || die "la base $TARGET_DB n'existe pas (infra/deploy.sh --profile bench d'abord)."
tq() { pg_sql -d "$TARGET_DB" -c "$1"; }

missing_tables="$(tq "SELECT coalesce(string_agg(t, ' '), '') FROM unnest(string_to_array('${PORTED_TABLES[*]} bench_owner', ' ')) t WHERE to_regclass('public.' || t) IS NULL;")"
[[ -z "$missing_tables" ]] || die "tables absentes de $TARGET_DB ($missing_tables) : migrations Prisma non appliquées (pnpm nx run bench-prisma:migrate, service du profil tools)."
[[ "$(tq "SELECT to_regclass('shadow_ref.snapshot_meta') IS NOT NULL AND to_regnamespace('archive') IS NOT NULL;")" == t ]] \
  || die "schémas shadow_ref / archive absents : migrations Prisma non appliquées."

if [[ "$mode" == migrate || "$mode" == dry-run ]]; then
  sessions="$(pg_sql -d postgres -c "SELECT count(*) FROM pg_stat_activity WHERE datname = '$TARGET_DB' AND pid <> pg_backend_pid() AND backend_type = 'client backend';")"
  [[ "$sessions" == 0 ]] || die "$sessions session(s) ouverte(s) sur $TARGET_DB : arrête l'API du banc (docker compose stop raijin-bench-api). Rien n'a été modifié."
  nonempty="$(tq "SELECT coalesce(string_agg(t, ' '), '') FROM unnest(string_to_array('${PORTED_TABLES[*]}', ' ')) t WHERE (xpath('/row/b/text()', query_to_xml(format('SELECT EXISTS (SELECT 1 FROM public.%I) AS b', t), false, true, '')))[1]::text = 'true';")"
  [[ -z "$nonempty" ]] || die "$TARGET_DB n'est pas vide (tables : $nonempty) : import refusé, rien n'a été modifié (docs/BENCH.md §11)."
  [[ "$(tq "SELECT count(*) FROM public.bench_owner;")" == 1 ]] \
    || die "aucun compte bench_owner : crée-le d'abord (CLI create-owner, docs/BENCH.md §12)."
  if [[ "$archive" == 1 ]]; then
    [[ "$(tq "SELECT count(*) FROM pg_tables WHERE schemaname = 'archive';")" == 0 ]] || die "le schéma archive n'est pas vide : --archive refusé."
  fi
fi

# ---------------------------------------------------------------------------------------------------
# 2. Source : URL (variable ou saisie masquée), découpée en paramètres libpq, jamais affichée
# ---------------------------------------------------------------------------------------------------
url_decode() {
  local s="$1" out="" c
  while [[ -n "$s" ]]; do
    c="${s:0:1}"
    if [[ "$c" == "%" && "${s:1:2}" =~ ^[0-9A-Fa-f]{2}$ ]]; then
      printf -v c '%b' "\\x${s:1:2}"
      s="${s:3}"
    else
      s="${s:1}"
    fi
    out+="$c"
  done
  printf '%s' "$out"
}

SRC_HOST="" SRC_PORT=5432 SRC_USER="" SRC_PASSWORD="" SRC_DB=postgres SRC_SSLMODE=require
parse_source_url() {
  local url="$1" rest userinfo hostpart query db kv k v
  [[ "$url" =~ ^postgres(ql)?:// ]] || die "URL source invalide : format attendu postgresql://utilisateur:motdepasse@hôte:port/base (non affichée)."
  rest="${url#*://}"
  [[ "$rest" == *@* ]] || die "URL source sans utilisateur ni mot de passe."
  userinfo="${rest%@*}"
  hostpart="${rest##*@}"
  SRC_USER="$(url_decode "${userinfo%%:*}")"
  [[ "$userinfo" == *:* ]] && SRC_PASSWORD="$(url_decode "${userinfo#*:}")"
  query=""
  [[ "$hostpart" == *\?* ]] && { query="${hostpart#*\?}"; hostpart="${hostpart%%\?*}"; }
  db=""
  [[ "$hostpart" == */* ]] && { db="${hostpart#*/}"; hostpart="${hostpart%%/*}"; }
  [[ -n "$db" ]] && SRC_DB="$(url_decode "$db")"
  if [[ "$hostpart" =~ ^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:([0-9]{1,5}))?$ ]]; then
    SRC_HOST="${BASH_REMATCH[1]}"; SRC_HOST="${SRC_HOST#[}"; SRC_HOST="${SRC_HOST%]}"
    [[ -n "${BASH_REMATCH[3]}" ]] && SRC_PORT="${BASH_REMATCH[3]}"
  else
    die "URL source : hôte ou port illisible."
  fi
  local IFS='&'
  for kv in $query; do
    k="${kv%%=*}"; v="${kv#*=}"
    case "$k" in
      sslmode) [[ "$v" =~ ^(disable|allow|prefer|require|verify-ca|verify-full)$ ]] || die "sslmode invalide."; SRC_SSLMODE="$v" ;;
      "") ;;
      *) warn "paramètre d'URL ignoré : $k" ;;
    esac
  done
  [[ -n "$SRC_USER" && -n "$SRC_HOST" ]] || die "URL source incomplète (utilisateur ou hôte manquant)."
}

DUMP_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$RAIJIN_PG_CONTAINER")"
DUMP_NETWORK="${BENCH_MIGRATE_DUMP_NETWORK:-host}"
[[ "$DUMP_NETWORK" =~ ^[A-Za-z0-9_.-]+$ ]] || die "BENCH_MIGRATE_DUMP_NETWORK invalide."

# Client Postgres (pg_dump / psql, même version que raijin-postgres) dans un conteneur jetable : raijin-postgres
# est sur un réseau interne sans sortie. Les paramètres de connexion passent par l'environnement, par NOM ; le mot de
# passe, lui, jamais (`docker inspect` montrerait la valeur d'une variable -e) : il est écrit, par l'entrée standard,
# dans un fichier pgpass (0600) d'un volume Docker tmpfs (RAM, jamais sur disque persistant) tenu monté par un
# conteneur gardien sans réseau, puis monté EN LECTURE SEULE dans chaque conteneur de lecture (PGPASSFILE). Les
# conteneurs tournent avec l'uid de l'appelant (propriétaire du fichier). À la sortie, gardien et volume sont
# supprimés (cleanup) ; si le script est tué, le gardien s'arrête seul au bout de 6 h et le tmpfs est démonté.
PASS_NAME="raijin-bench-migrate-src-$$-pass"
PASS_MOUNT=/run/raijin-pgpass
PASS_READY=0
make_pgpass() {
  local uid gid escaped
  uid="$(id -u)" gid="$(id -g)"
  docker volume create --driver local --opt type=tmpfs --opt device=tmpfs \
    --opt "o=size=64k,mode=0700,uid=$uid,gid=$gid" "$PASS_NAME" >/dev/null
  docker run -d --rm --name "$PASS_NAME" --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --user "$uid:$gid" -v "$PASS_NAME:$PASS_MOUNT" "$DUMP_IMAGE" sleep 21600 >/dev/null
  # Format pgpass : hôte:port:base:utilisateur:mot de passe ; « \ » et « : » échappés. Jokers pour la connexion seule.
  escaped="${SRC_PASSWORD//\\/\\\\}"
  escaped="${escaped//:/\\:}"
  printf '*:*:*:*:%s\n' "$escaped" | docker exec -i "$PASS_NAME" sh -c "umask 077 && cat > $PASS_MOUNT/pgpass"
  escaped="" SRC_PASSWORD=""
  PASS_READY=1
}

src_run() {
  local pass_args=()
  (( PASS_READY )) && pass_args=(-v "$PASS_NAME:$PASS_MOUNT:ro" -e "PGPASSFILE=$PASS_MOUNT/pgpass")
  PGHOST="$SRC_HOST" PGPORT="$SRC_PORT" PGUSER="$SRC_USER" PGDATABASE="$SRC_DB" \
  PGSSLMODE="$SRC_SSLMODE" PGOPTIONS='-c default_transaction_read_only=on' PGAPPNAME=raijin-bench-migrate \
  PGCONNECT_TIMEOUT=20 \
    docker run --rm -i --name "raijin-bench-migrate-src-$$-$RANDOM" --network "$DUMP_NETWORK" \
      --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --user "$(id -u):$(id -g)" \
      -e PGHOST -e PGPORT -e PGUSER -e PGDATABASE -e PGSSLMODE -e PGOPTIONS -e PGAPPNAME \
      -e PGCONNECT_TIMEOUT "${pass_args[@]}" "$DUMP_IMAGE" "$@"
}

cleanup() {
  local ids
  ids="$(docker ps -aq --filter "name=^raijin-bench-migrate-src-$$-" 2>/dev/null || true)"
  # shellcheck disable=SC2086
  [[ -n "$ids" ]] && docker rm -f $ids >/dev/null 2>&1 || true
  # Conteneurs de lecture et gardien supprimés d'abord (le volume tmpfs se démonte alors), puis le volume.
  docker volume rm -f "$PASS_NAME" >/dev/null 2>&1 || true
  PASS_READY=0
}
on_abort() {
  # Avec set -E, le piège est hérité par les sous-shells : seul le shell principal agit.
  [[ "$BASHPID" == "$$" ]] || exit 1
  trap - ERR
  trap '' INT TERM HUP
  cleanup
  die "interrompu : transaction annulée, rien n'a été écrit dans $TARGET_DB."
}
trap on_abort ERR INT TERM HUP
trap cleanup EXIT

source_url="${BENCH_SOURCE_DATABASE_URL:-}"
unset BENCH_SOURCE_DATABASE_URL
if [[ -z "$source_url" ]]; then
  [[ -t 0 ]] || die "BENCH_SOURCE_DATABASE_URL absente et pas de terminal pour la saisir."
  read -r -s -p "URL Postgres de Supabase (saisie masquée) : " source_url
  printf '\n' >&2
fi
parse_source_url "$source_url"
unset source_url
[[ -n "$SRC_PASSWORD" ]] && make_pgpass
log "source : hôte $SRC_HOST, port $SRC_PORT, base $SRC_DB (identifiants non affichés)."

src_info="$(src_run psql -X -q -t -A -v ON_ERROR_STOP=1 -c "SELECT current_setting('default_transaction_read_only') || ' ' || current_setting('server_version_num');" </dev/null)" \
  || die "connexion à la source impossible (URL, réseau, pare-feu ou paramètre PGOPTIONS refusé par le pooler : docs/BENCH.md §11)."
read -r src_ro src_version <<<"$src_info"
[[ "$src_ro" == on ]] || die "la connexion source n'est pas en lecture seule : arrêt."
client_major="$(docker run --rm --network none "$DUMP_IMAGE" pg_dump --version | grep -oE '[0-9]+' | head -n 1)"
(( src_version / 10000 <= client_major )) || die "serveur source Postgres $((src_version / 10000)) plus récent que pg_dump $client_major."
log "source en lecture seule (default_transaction_read_only=on), Postgres $((src_version / 10000))."

case "$mode" in
  shadow) dump_tables=("${SHADOW_TABLES[@]}") ;;
  *) dump_tables=("${PORTED_TABLES[@]}"); [[ "$archive" == 1 ]] && dump_tables+=("${DEAD_TABLES[@]}") ;;
esac

if [[ "$mode" == migrate && "$assume_yes" != 1 ]]; then
  log "Migration : ${#PORTED_TABLES[@]} tables de la source vers $TARGET_DB (une transaction ; refus et annulation en cas d'écart)."
  read -r -p "Pour continuer, tape exactement : MIGRER $TARGET_DB > " answer
  [[ "$answer" == "MIGRER $TARGET_DB" ]] || die "abandon (confirmation différente)."
fi

# ---------------------------------------------------------------------------------------------------
# 3. Flux SQL : prélude, données (COPY du dump réécrits vers des tables temporaires), fusion, contrôles
# ---------------------------------------------------------------------------------------------------
# Ne garde que les blocs COPY du dump (SET, setval, \restrict… ignorés) ; chaque « COPY public.t (cols) » devient
# une table temporaire pg_temp.src_t aux colonnes texte (les valeurs sont recastées vers les types de la cible).
# Refuse tout dump tronqué (marque de fin absente) ou toute table inattendue.
# shellcheck disable=SC2016 # programme awk : les $ sont ceux d'awk et du SQL, pas du shell
AWK_COPY='
function fail(msg) { if (inblk) print "\\."; print "\\echo ERREUR bench-migrate : " msg; print "DO $f$ BEGIN RAISE EXCEPTION '"'"'dump source invalide'"'"'; END $f$;"; failed = 1; exit 1 }
function ident(s) { if (s ~ /^".*"$/) { s = substr(s, 2, length(s) - 2); gsub(/""/, "\"", s) } if (s !~ /^[a-z_][a-z0-9_]*$/) fail("identifiant inattendu"); return s }
BEGIN { n = split(allowed, a, " "); for (i = 1; i <= n; i++) ok[a[i]] = 1; inblk = 0; done = 0; failed = 0 }
inblk { print; if ($0 == "\\.") inblk = 0; next }
/^COPY public\./ {
  tail = ") FROM stdin;"
  if (substr($0, length($0) - length(tail) + 1) != tail) fail("en-tête COPY illisible")
  head = substr($0, 13); p = index(head, " (")
  if (p == 0) fail("en-tête COPY illisible")
  t = ident(substr(head, 1, p - 1))
  if (!(t in ok)) fail("table inattendue dans le dump : " t)
  lst = substr(head, p + 2, length(head) - p - 1 - length(tail))
  m = split(lst, c, ", "); defs = ""; cols = ""
  for (i = 1; i <= m; i++) { x = ident(c[i]); defs = defs (i > 1 ? ", " : "") "\"" x "\" text"; cols = cols (i > 1 ? ", " : "") "\"" x "\"" }
  print "CREATE TEMP TABLE \"src_" t "\" (" defs ") ON COMMIT DROP;"
  print "COPY pg_temp.\"src_" t "\" (" cols ") FROM stdin;"
  inblk = 1; next
}
/^-- PostgreSQL database dump complete/ { done = 1 }
END { if (failed) exit 1; if (inblk) fail("dump tronqué (bloc COPY non terminé)"); if (!done) fail("dump incomplet (marque de fin absente)") }
'

prelude_sql() {
  cat <<'SQL'
\set ON_ERROR_STOP on
\set VERBOSITY terse
\pset footer off
SET client_min_messages = warning;
BEGIN;
SET LOCAL ROLE raijin_bench;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = 0;
SET LOCAL TimeZone = 'UTC';
SET LOCAL search_path = pg_catalog, public;
SELECT set_config('bm.mode', :'mode', true) AS _m, set_config('bm.tables', :'tables', true) AS _t,
       set_config('bm.dead', :'dead', true) AS _d, set_config('bm.archive', :'archive', true) AS _a,
       set_config('bm.since', :'since', true) AS _s, set_config('bm.until', :'until', true) AS _u,
       set_config('bm.source_user', :'source_user', true) AS _su, set_config('bm.fault', :'fault', true) AS _f \gset
SQL
  if [[ "$mode" == migrate || "$mode" == dry-run ]]; then
    # Verrou : aucune écriture concurrente pendant l'import ; vacuité vérifiée DANS la transaction.
    printf 'LOCK TABLE %s IN EXCLUSIVE MODE;\n' "$(printf 'public.%s, ' "${PORTED_TABLES[@]}" | sed 's/, $//')"
    cat <<'SQL'
DO $bm$
DECLARE t text; v_full text[] := '{}'; b boolean;
BEGIN
  FOREACH t IN ARRAY string_to_array(current_setting('bm.tables'), ' ') LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', t) INTO b;
    IF b THEN v_full := v_full || t; END IF;
  END LOOP;
  IF cardinality(v_full) > 0 THEN
    RAISE EXCEPTION 'raijin_bench n''est pas vide (%) : import refusé', array_to_string(v_full, ', ');
  END IF;
END $bm$;
SQL
  fi
}

# Fonctions communes (temporaires, détruites avec la session).
common_sql() {
  cat <<'SQL'
CREATE FUNCTION pg_temp.bm_cols(p regclass) RETURNS text[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(a.attname::text ORDER BY a.attnum), '{}') FROM pg_attribute a
  WHERE a.attrelid = p AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '' $$;
CREATE FUNCTION pg_temp.bm_type(p regclass, c text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = p AND a.attname = c $$;
-- Empreinte indépendante de l'ordre : nombre de lignes + somme de 60 bits de md5(ligne) sur les colonnes données.
CREATE FUNCTION pg_temp.bm_fp(p_rel text, p_cols text[], p_where text DEFAULT '') RETURNS TABLE (n bigint, fp numeric)
LANGUAGE plpgsql AS $$ BEGIN
  RETURN QUERY EXECUTE format(
    'SELECT count(*)::bigint, coalesce(sum((''x'' || substr(md5(ROW(%s)::text), 1, 15))::bit(60)::bigint), 0)::numeric FROM %s %s',
    (SELECT string_agg(quote_ident(c), ', ') FROM unnest(p_cols) c), p_rel, p_where);
END $$;
CREATE FUNCTION pg_temp.bm_daycol(p_table text, p_cols text[]) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(shadow_ref.day_column(p_table),
    (SELECT c FROM unnest(ARRAY['created_at', 'detected_at', 'started_at', 'at', 'event_at', 'updated_at']) c
      WHERE c = ANY (p_cols) LIMIT 1)) $$;
CREATE FUNCTION pg_temp.bm_minmax(p_rel text, p_col text, p_where text DEFAULT '') RETURNS TABLE (lo text, hi text)
LANGUAGE plpgsql AS $$ BEGIN
  IF p_col IS NULL THEN RETURN QUERY SELECT NULL::text, NULL::text; RETURN; END IF;
  RETURN QUERY EXECUTE format('SELECT to_char(min(%1$I), ''YYYY-MM-DD HH24:MI''), to_char(max(%1$I), ''YYYY-MM-DD HH24:MI'') FROM %2$s %3$s',
    p_col, p_rel, p_where);
END $$;
CREATE TEMP TABLE bm_report (
  ord int, tbl text, src_rows bigint, dst_rows bigint, src_min text, dst_min text, src_max text, dst_max text,
  src_fp numeric, dst_fp numeric, extra text, ok boolean) ON COMMIT DROP;
-- Source transformée (colonnes de la cible, types de la cible, comptes → bench_owner) : pg_temp.bm_x_<table>.
CREATE FUNCTION pg_temp.bm_transform(p_tables text[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  t text; c text; v_owner uuid; v_user uuid := nullif(current_setting('bm.source_user'), '')::uuid;
  v_users uuid[] := '{}'; v_found uuid[]; r record; v_src regclass; v_dst regclass;
  v_exprs text; v_where text; v_ucol record;
BEGIN
  FOREACH t IN ARRAY p_tables LOOP
    IF to_regclass('pg_temp.src_' || t) IS NULL THEN RAISE EXCEPTION 'table public.% absente du dump source', t; END IF;
  END LOOP;
  -- Colonnes « compte » : clés étrangères à une colonne vers bench_owner (ex-auth.users, P2).
  CREATE TEMP TABLE bm_usercols ON COMMIT DROP AS
    SELECT cl.relname::text AS tbl, a.attname::text AS col, a.attnotnull AS notnull
    FROM pg_constraint k JOIN pg_class cl ON cl.oid = k.conrelid
    JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
    WHERE k.contype = 'f' AND k.confrelid = 'public.bench_owner'::regclass AND cardinality(k.conkey) = 1
      AND cl.relnamespace = 'public'::regnamespace AND cl.relname = ANY (p_tables);
  FOR r IN SELECT * FROM bm_usercols LOOP
    IF r.col = ANY (pg_temp.bm_cols(('pg_temp.' || quote_ident('src_' || r.tbl))::regclass)) THEN
      EXECUTE format('SELECT coalesce(array_agg(DISTINCT %I::uuid), ''{}'') FROM pg_temp.%I WHERE %I IS NOT NULL',
        r.col, 'src_' || r.tbl, r.col) INTO v_found;
      v_users := ARRAY(SELECT DISTINCT u FROM unnest(v_users || v_found) u);
    END IF;
  END LOOP;
  IF v_user IS NULL AND cardinality(v_users) > 1 THEN
    RAISE EXCEPTION 'la source contient % comptes (%) : choisis celui à importer avec --source-user', cardinality(v_users), array_to_string(v_users, ', ');
  END IF;
  IF v_user IS NOT NULL AND NOT v_user = ANY (v_users) THEN
    RAISE EXCEPTION '--source-user % absent de la source', v_user;
  END IF;
  v_user := coalesce(v_user, v_users[1]);
  IF v_user IS NOT NULL THEN
    SELECT public.bench_owner_id() INTO v_owner;
    IF v_owner IS NULL THEN RAISE EXCEPTION 'aucun compte bench_owner (CLI create-owner d''abord)'; END IF;
  END IF;
  FOREACH t IN ARRAY p_tables LOOP
    v_src := ('pg_temp.' || quote_ident('src_' || t))::regclass;
    v_dst := ('public.' || quote_ident(t))::regclass;
    v_exprs := ''; v_where := '';
    FOREACH c IN ARRAY pg_temp.bm_cols(v_dst) LOOP
      CONTINUE WHEN NOT c = ANY (pg_temp.bm_cols(v_src));
      SELECT * INTO v_ucol FROM bm_usercols u WHERE u.tbl = t AND u.col = c;
      IF FOUND AND v_user IS NOT NULL THEN
        IF v_ucol.notnull THEN
          v_exprs := v_exprs || format(', %L::uuid AS %I', v_owner, c);
          v_where := v_where || format(' AND s.%I::uuid = %L::uuid', c, v_user);
        ELSE
          v_exprs := v_exprs || format(', CASE WHEN s.%1$I::uuid = %2$L::uuid THEN %3$L::uuid END AS %1$I', c, v_user, v_owner);
        END IF;
      ELSE
        v_exprs := v_exprs || format(', s.%1$I::%2$s AS %1$I', c, pg_temp.bm_type(v_dst, c));
      END IF;
    END LOOP;
    EXECUTE format('CREATE TEMP TABLE %I ON COMMIT DROP AS SELECT %s FROM pg_temp.%I s WHERE true%s',
      'bm_x_' || t, substr(v_exprs, 3), 'src_' || t, v_where);
  END LOOP;
END $$;
SQL
}

migrate_sql() {
  cat <<'SQL'
SELECT pg_temp.bm_transform(string_to_array(current_setting('bm.tables'), ' ')) \gset
DO $bm$
DECLARE
  t text; i int := 0; v_dst regclass; v_cols text[]; v_list text; v_ignored text[]; v_identity boolean;
  r record; v_trg record; v_con record; v_seq text; v_max bigint; v_extra text;
BEGIN
  FOREACH t IN ARRAY string_to_array(current_setting('bm.tables'), ' ') LOOP
    i := i + 1;
    v_dst := ('public.' || quote_ident(t))::regclass;
    v_cols := pg_temp.bm_cols(('pg_temp.' || quote_ident('bm_x_' || t))::regclass);
    v_list := (SELECT string_agg(quote_ident(c), ', ') FROM unnest(v_cols) c);
    v_ignored := ARRAY(SELECT c FROM unnest(pg_temp.bm_cols(('pg_temp.' || quote_ident('src_' || t))::regclass)) c
                       WHERE NOT c = ANY (pg_temp.bm_cols(v_dst)));
    v_identity := EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = v_dst AND attidentity = 'a' AND NOT attisdropped);
    v_extra := '';
    -- Déclencheurs suspendus (copie fidèle de l'historique), état exact restauré après.
    CREATE TEMP TABLE IF NOT EXISTS bm_triggers (tbl text, name text, state "char") ON COMMIT DROP;
    FOR v_trg IN SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = v_dst AND NOT tgisinternal AND tgenabled <> 'D' LOOP
      INSERT INTO bm_triggers VALUES (t, v_trg.tgname, v_trg.tgenabled);
      EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I', t, v_trg.tgname);
    END LOOP;
    -- Contraintes NOT VALID (lignes historiques) : retirées, puis remises NOT VALID.
    CREATE TEMP TABLE IF NOT EXISTS bm_notvalid (tbl text, name text, def text) ON COMMIT DROP;
    FOR v_con IN SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
                 WHERE conrelid = v_dst AND NOT convalidated AND contype = 'c' LOOP
      INSERT INTO bm_notvalid VALUES (t, v_con.conname, v_con.def);
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, v_con.conname);
    END LOOP;
    EXECUTE format('INSERT INTO public.%I (%s) %s SELECT %s FROM pg_temp.%I', t, v_list,
      CASE WHEN v_identity THEN 'OVERRIDING SYSTEM VALUE' ELSE '' END, v_list, 'bm_x_' || t);
    FOR v_con IN SELECT name, def FROM bm_notvalid WHERE tbl = t LOOP
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s', t, v_con.name, v_con.def);
      v_extra := v_extra || ' contrainte ' || v_con.name || ' remise NOT VALID;';
    END LOOP;
    FOR v_trg IN SELECT name, state FROM bm_triggers WHERE tbl = t LOOP
      EXECUTE format('ALTER TABLE public.%I ENABLE %s TRIGGER %I', t,
        CASE v_trg.state WHEN 'A' THEN 'ALWAYS' WHEN 'R' THEN 'REPLICA' ELSE '' END, v_trg.name);
    END LOOP;
    -- Séquences (identités et serial) recalées sur le plus grand identifiant importé.
    FOR r IN SELECT attname FROM pg_attribute WHERE attrelid = v_dst AND attnum > 0 AND NOT attisdropped
               AND pg_get_serial_sequence(v_dst::text, attname) IS NOT NULL LOOP
      v_seq := pg_get_serial_sequence(v_dst::text, r.attname);
      EXECUTE format('SELECT max(%I)::bigint FROM public.%I', r.attname, t) INTO v_max;
      IF v_max IS NOT NULL THEN PERFORM setval(v_seq, v_max); v_extra := v_extra || format(' séquence %s = %s;', r.attname, v_max); END IF;
    END LOOP;
    IF cardinality(v_ignored) > 0 THEN v_extra := v_extra || ' colonnes ignorées : ' || array_to_string(v_ignored, ', ') || ';'; END IF;
    INSERT INTO bm_report (ord, tbl, extra) VALUES (i, t, nullif(trim(v_extra), ''));
  END LOOP;

  -- Archive facultative (P3/P4) : tables mortes et colonnes retirées de public, valeurs texte de COPY.
  IF current_setting('bm.archive') = '1' THEN
    FOREACH t IN ARRAY string_to_array(current_setting('bm.dead'), ' ') LOOP
      CONTINUE WHEN to_regclass('pg_temp.src_' || t) IS NULL;
      i := i + 1;
      EXECUTE format('CREATE TABLE archive.%I AS SELECT * FROM pg_temp.%I', t, 'src_' || t);
      EXECUTE format('COMMENT ON TABLE archive.%I IS %L', t, 'Copie brute Supabase (table morte, valeurs au format texte de COPY), import du ' || to_char(now(), 'YYYY-MM-DD'));
      INSERT INTO bm_report (ord, tbl, extra) VALUES (i, 'archive.' || t, 'table morte');
    END LOOP;
    FOREACH t IN ARRAY string_to_array(current_setting('bm.tables'), ' ') LOOP
      v_dst := ('public.' || quote_ident(t))::regclass;
      v_ignored := ARRAY(SELECT c FROM unnest(pg_temp.bm_cols(('pg_temp.' || quote_ident('src_' || t))::regclass)) c
                         WHERE NOT c = ANY (pg_temp.bm_cols(v_dst)));
      CONTINUE WHEN cardinality(v_ignored) = 0;
      v_cols := ARRAY(SELECT a.attname::text FROM pg_index x JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = ANY (x.indkey)
                      WHERE x.indrelid = v_dst AND x.indisprimary ORDER BY array_position(x.indkey::int2[], a.attnum));
      i := i + 1;
      EXECUTE format('CREATE TABLE archive.%I AS SELECT %s FROM pg_temp.%I', t || '_colonnes_archivees',
        (SELECT string_agg(quote_ident(c), ', ') FROM unnest(v_cols || v_ignored) c), 'src_' || t);
      EXECUTE format('COMMENT ON TABLE archive.%I IS %L', t || '_colonnes_archivees',
        'Colonnes Supabase retirées de public.' || t || ' (clé : ' || array_to_string(v_cols, ', ') || '), valeurs texte, import du ' || to_char(now(), 'YYYY-MM-DD'));
      INSERT INTO bm_report (ord, tbl, extra) VALUES (i, 'archive.' || t || '_colonnes_archivees', 'clé + ' || array_to_string(v_ignored, ', '));
    END LOOP;
  END IF;

  -- Tests seulement : écart injecté après la copie (doit faire échouer les contrôles).
  IF current_setting('bm.fault') = 'bench_migrate_drift' THEN
    UPDATE public.tokens SET symbol = symbol || 'x' WHERE mint = (SELECT min(mint) FROM public.tokens);
  ELSIF current_setting('bm.fault') = 'bench_migrate_missing' THEN
    DELETE FROM public.token_snapshots WHERE id = (SELECT max(id) FROM public.token_snapshots);
  END IF;

  -- Contrôles : lignes, dates min/max, empreinte de toutes les colonnes copiées, source transformée vs cible.
  FOR r IN SELECT * FROM bm_report ORDER BY ord LOOP
    IF r.tbl LIKE 'archive.%' THEN
      t := substr(r.tbl, 9);
      IF to_regclass('pg_temp.src_' || t) IS NOT NULL THEN
        EXECUTE format('UPDATE bm_report SET src_rows = (SELECT count(*) FROM pg_temp.%I), dst_rows = (SELECT count(*) FROM archive.%I) WHERE ord = %s', 'src_' || t, t, r.ord);
      ELSE
        t := replace(t, '_colonnes_archivees', '');
        EXECUTE format('UPDATE bm_report SET src_rows = (SELECT count(*) FROM pg_temp.%I), dst_rows = (SELECT count(*) FROM archive.%I) WHERE ord = %s', 'src_' || t, t || '_colonnes_archivees', r.ord);
      END IF;
      UPDATE bm_report SET ok = (src_rows = dst_rows) WHERE ord = r.ord;
      CONTINUE;
    END IF;
    t := r.tbl;
    v_cols := pg_temp.bm_cols(('pg_temp.' || quote_ident('bm_x_' || t))::regclass);
    UPDATE bm_report b SET src_rows = s.n, src_fp = s.fp, dst_rows = d.n, dst_fp = d.fp
      FROM pg_temp.bm_fp('pg_temp.' || quote_ident('bm_x_' || t), v_cols) s, pg_temp.bm_fp('public.' || quote_ident(t), v_cols) d
      WHERE b.ord = r.ord;
    UPDATE bm_report b SET src_min = s.lo, src_max = s.hi, dst_min = d.lo, dst_max = d.hi
      FROM pg_temp.bm_minmax('pg_temp.' || quote_ident('bm_x_' || t), pg_temp.bm_daycol(t, v_cols)) s,
           pg_temp.bm_minmax('public.' || quote_ident(t), pg_temp.bm_daycol(t, v_cols)) d
      WHERE b.ord = r.ord;
    UPDATE bm_report SET ok = (src_rows = dst_rows AND src_fp = dst_fp
      AND src_min IS NOT DISTINCT FROM dst_min AND src_max IS NOT DISTINCT FROM dst_max) WHERE ord = r.ord;
  END LOOP;
END $bm$;
SQL
}

check_sql() {
  cat <<'SQL'
SELECT pg_temp.bm_transform(string_to_array(current_setting('bm.tables'), ' ')) \gset
DO $bm$
DECLARE t text; i int := 0; v_cols text[]; v_rows text; v_missing bigint; v_day text;
BEGIN
  FOREACH t IN ARRAY string_to_array(current_setting('bm.tables'), ' ') LOOP
    i := i + 1;
    v_cols := pg_temp.bm_cols(('pg_temp.' || quote_ident('bm_x_' || t))::regclass);
    v_rows := (SELECT string_agg(quote_ident(c), ', ') FROM unnest(v_cols) c);
    EXECUTE format('SELECT count(*) FROM (SELECT md5(ROW(%1$s)::text) FROM pg_temp.%2$I EXCEPT ALL SELECT md5(ROW(%1$s)::text) FROM public.%3$I) m',
      v_rows, 'bm_x_' || t, t) INTO v_missing;
    v_day := pg_temp.bm_daycol(t, v_cols);
    INSERT INTO bm_report (ord, tbl, src_rows, dst_rows, src_min, src_max, dst_min, dst_max, extra, ok)
      SELECT i, t, NULL, NULL, s.lo, s.hi, d.lo, d.hi,
             CASE WHEN v_missing > 0 THEN v_missing || ' ligne(s) de la source absente(s) ou différente(s) dans la cible' END,
             v_missing = 0
      FROM pg_temp.bm_minmax('pg_temp.' || quote_ident('bm_x_' || t), v_day) s, pg_temp.bm_minmax('public.' || quote_ident(t), v_day) d;
    EXECUTE format('UPDATE bm_report SET src_rows = (SELECT count(*) FROM pg_temp.%I), dst_rows = (SELECT count(*) FROM public.%I) WHERE ord = %s',
      'bm_x_' || t, t, i);
  END LOOP;
END $bm$;
SQL
}

shadow_sql() {
  cat <<'SQL'
DO $bm$
DECLARE
  t text; i int := 0; c text; v_dst regclass; v_src regclass; v_day text; v_exprs text; v_cols text[]; v_list text;
  v_from timestamptz := current_setting('bm.since')::timestamptz;
  v_to timestamptz := coalesce(nullif(current_setting('bm.until'), '')::timestamptz, now());
  v_where text; v_counts jsonb := '{}'; v_vps bigint;
BEGIN
  IF v_to < v_from OR v_to > v_from + interval '31 days' THEN
    RAISE EXCEPTION 'fenêtre invalide [% ; %[ : until ≥ since et 31 jours au plus', v_from, v_to;
  END IF;
  FOREACH t IN ARRAY string_to_array(current_setting('bm.tables'), ' ') LOOP
    i := i + 1;
    IF to_regclass('pg_temp.src_' || t) IS NULL THEN RAISE EXCEPTION 'table public.% absente du dump source', t; END IF;
    v_src := ('pg_temp.' || quote_ident('src_' || t))::regclass;
    v_dst := ('shadow_ref.' || quote_ident(t))::regclass;
    v_day := shadow_ref.day_column(t);
    v_exprs := '';
    FOREACH c IN ARRAY pg_temp.bm_cols(v_dst) LOOP
      CONTINUE WHEN NOT c = ANY (pg_temp.bm_cols(v_src));
      v_exprs := v_exprs || format(', s.%1$I::%2$s AS %1$I', c, pg_temp.bm_type(v_dst, c));
    END LOOP;
    -- Fenêtre [since, until[ sur la même colonne de date que l'écran de comparaison.
    EXECUTE format('CREATE TEMP TABLE %I ON COMMIT DROP AS SELECT %s FROM pg_temp.%I s WHERE s.%I::timestamptz >= %L AND s.%I::timestamptz < %L',
      'bm_x_' || t, substr(v_exprs, 3), 'src_' || t, v_day, v_from, v_day, v_to);
    v_cols := pg_temp.bm_cols(('pg_temp.' || quote_ident('bm_x_' || t))::regclass);
    v_list := (SELECT string_agg(quote_ident(x), ', ') FROM unnest(v_cols) x);
    EXECUTE format('TRUNCATE shadow_ref.%I', t);
    EXECUTE format('INSERT INTO shadow_ref.%I (%s) SELECT %s FROM pg_temp.%I', t, v_list, v_list, 'bm_x_' || t);
    v_where := format('WHERE %I >= %L AND %I < %L', v_day, v_from, v_day, v_to);
    EXECUTE format('SELECT count(*) FROM public.%I %s', t, v_where) INTO v_vps;
    INSERT INTO bm_report (ord, tbl, extra) VALUES (i, t, 'VPS (public, même fenêtre) : ' || v_vps || ' ligne(s)');
    UPDATE bm_report b SET src_rows = s.n, src_fp = s.fp, dst_rows = d.n, dst_fp = d.fp
      FROM pg_temp.bm_fp('pg_temp.' || quote_ident('bm_x_' || t), v_cols) s, pg_temp.bm_fp('shadow_ref.' || quote_ident(t), v_cols) d
      WHERE b.ord = i;
    UPDATE bm_report b SET src_min = s.lo, src_max = s.hi, dst_min = d.lo, dst_max = d.hi
      FROM pg_temp.bm_minmax('pg_temp.' || quote_ident('bm_x_' || t), v_day) s, pg_temp.bm_minmax('shadow_ref.' || quote_ident(t), v_day) d
      WHERE b.ord = i;
    UPDATE bm_report SET ok = (src_rows = dst_rows AND src_fp = dst_fp) WHERE ord = i;
    v_counts := v_counts || jsonb_build_object(t, (SELECT dst_rows FROM bm_report WHERE ord = i));
  END LOOP;
  INSERT INTO shadow_ref.snapshot_meta (window_from, window_to, row_counts) VALUES (v_from, v_to, v_counts);
END $bm$;
SQL
}

report_sql() {
  cat <<'SQL'
\echo
\echo Résumé (source = contenu du dump, cible = raijin_bench ; dates en UTC) :
SELECT tbl AS "table", src_rows AS "lignes source", dst_rows AS "lignes cible",
       coalesce(src_min, '-') || ' → ' || coalesce(src_max, '-') AS "dates source",
       coalesce(dst_min, '-') || ' → ' || coalesce(dst_max, '-') AS "dates cible",
       CASE WHEN ok THEN 'ok' ELSE 'ÉCART' END AS "contrôle", coalesce(extra, '') AS "remarques"
FROM bm_report ORDER BY ord;
DO $bm$
DECLARE v text;
BEGIN
  SELECT string_agg(tbl, ', ' ORDER BY ord) INTO v FROM bm_report WHERE ok IS NOT TRUE;
  IF v IS NOT NULL THEN RAISE EXCEPTION 'écart source / cible sur : % (transaction annulée)', v; END IF;
END $bm$;
SQL
}

produce_sql() {
  prelude_sql
  common_sql
  # shellcheck disable=SC2046 # une option --table par table (noms fixes, sans espace)
  if src_run pg_dump --data-only --format=plain --no-owner --no-privileges --encoding=UTF8 \
      --lock-wait-timeout=30000 $(printf -- '--table=public.%s ' "${dump_tables[@]}") </dev/null \
    | LC_ALL=C awk -v allowed="${dump_tables[*]}" "$AWK_COPY"; then
    case "$mode" in
      migrate|dry-run) migrate_sql ;;
      check) check_sql ;;
      shadow) shadow_sql ;;
    esac
    report_sql
    case "$mode" in
      migrate|shadow) printf 'COMMIT;\n' ;;
      *) printf 'ROLLBACK;\n' ;;
    esac
  else
    printf '\\echo ERREUR bench-migrate : lecture de la source interrompue\n'
    # shellcheck disable=SC2016 # $f$ : délimiteur SQL
    printf 'DO $f$ BEGIN RAISE EXCEPTION %s; END $f$;\n' "'lecture de la source en échec'"
  fi
}

[[ "$mode" == shadow ]] && target_tables="${SHADOW_TABLES[*]}" || target_tables="${PORTED_TABLES[*]}"
target_psql() {
  pg_exec psql -X --no-psqlrc -q -U postgres -d "$TARGET_DB" -P pager=off \
    -v mode="$mode" -v tables="$target_tables" -v dead="${DEAD_TABLES[*]}" -v archive="$archive" \
    -v since="$since" -v until="$until" -v source_user="$source_user" -v fault="$fault"
}

case "$mode" in
  migrate) log "migration en cours (lecture de la source, copie, contrôles, une transaction)…" ;;
  dry-run) log "SIMULATION : import complet puis annulation (rien n'est écrit)…" ;;
  check) log "contrôle source / cible (aucune écriture)…" ;;
  shadow) log "instantané du mode ombre : fenêtre [$since ; ${until:-maintenant}[ vers shadow_ref…" ;;
esac

status=0
produce_sql | target_psql || status=$?
trap - ERR INT TERM HUP
cleanup

if [[ "$status" != 0 ]]; then
  case "$mode" in
    check) die "CONTRÔLE EN ÉCHEC : voir le résumé ci-dessus (rien n'a été modifié)." ;;
    *) die "ÉCHEC : transaction annulée, rien n'a été écrit dans $TARGET_DB (voir le message ci-dessus)." ;;
  esac
fi
case "$mode" in
  migrate) log "MIGRATION RÉUSSIE dans $TARGET_DB. Contrôle a posteriori : infra/bench-migrate.sh --check" ;;
  dry-run) log "SIMULATION RÉUSSIE : contrôles verts, transaction annulée (rien n'a été écrit)." ;;
  check) log "CONTRÔLE RÉUSSI : chaque ligne de la source est présente à l'identique dans $TARGET_DB." ;;
  shadow) log "INSTANTANÉ RÉUSSI : shadow_ref rechargé, ligne ajoutée dans shadow_ref.snapshot_meta." ;;
esac
