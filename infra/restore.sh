#!/usr/bin/env bash
# =====================================================================================================
# Restauration d'une sauvegarde Raijin (fichier .dump de infra/backup.sh) — lancée par l'utilisateur.
#
#   infra/restore.sh --check FICHIER.dump
#       Restaure dans une base de TEST jetable « raijin_restore_check » (recréée à chaque fois, puis
#       supprimée ; --keep pour la garder), contrôle le contenu (tables, migrations Prisma, comptes) et
#       affiche un résumé. Ne touche à aucune autre base. À faire chaque mois (docs/DEPLOY.md A10).
#
#   infra/restore.sh --into raijin|raijin_bench FICHIER.dump
#       Restauration RÉELLE, après confirmation tapée au clavier. Sans rien supprimer :
#         1. contrôle du fichier (sha256 s'il existe, pg_restore --list) ;
#         2. arrêt de l'API concernée (docker compose stop, jamais down) ;
#         3. la base actuelle est RENOMMÉE en <base>_avant_restauration_<date> (retour arrière possible) ;
#         4. base vide recréée (infra/postgres/init/10-raijin-databases.sh), restauration, contrôle ;
#         5. redémarrage de l'API et attente du healthcheck.
#       En cas d'échec à l'étape 4, la base d'origine est remise en place automatiquement.
#       L'ancienne base renommée est à supprimer à la main quand tout va bien (commande affichée).
#
# Options : --yes (sans question), --no-service (n'arrête ni ne redémarre l'API : déjà arrêtée, ou test).
# Variable : RAIJIN_PG_CONTAINER (raijin-postgres par défaut ; seuls les conteneurs raijin-… sont acceptés).
# =====================================================================================================
set -Eeuo pipefail
umask 077
RAIJIN_SCRIPT=restore
# shellcheck source=infra/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

CHECK_DB=raijin_restore_check
mode="" target="" file="" keep=0 assume_yes=0 manage_service=1

usage() { sed -n '2,25p' "$0"; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) mode=check; shift ;;
    --into) mode=into; target="${2:-}"; shift 2 || usage 1 ;;
    --keep) keep=1; shift ;;
    --yes) assume_yes=1; shift ;;
    --no-service) manage_service=0; shift ;;
    -h|--help) usage 0 ;;
    -*) die "option inconnue : $1" ;;
    *) file="$1"; shift ;;
  esac
done

[[ -n "$mode" && -n "$file" ]] || usage 1
[[ -r "$file" ]] || die "fichier illisible : $file"
require_cmd docker
require_pg_container

owner_of() { case "$1" in raijin) echo raijin ;; raijin_bench) echo raijin_bench ;; *) return 1 ;; esac; }

verify_file() {
  if [[ -r "$file.sha256" ]]; then
    log "contrôle sha256…"
    (cd "$(dirname "$file")" && sha256sum --quiet -c "$(basename "$file").sha256") || die "sha256 différent : fichier corrompu."
  fi
  pg_exec pg_restore --list <"$file" >/dev/null || die "fichier non reconnu par pg_restore."
}

terminate_connections() {
  pg_sql -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$1' AND pid <> pg_backend_pid();" >/dev/null
}

# Résumé d'une base restaurée : nombre de tables, dernière migration Prisma, quelques comptages.
summarize() {
  local db="$1" tables migrations last
  # Tests seulement : échec simulé d'une requête après le renommage (dans une substitution de commande).
  tables="$(if [[ "${RAIJIN_TEST_FAULT:-}" == "summarize" ]]; then false; fi; pg_sql -d "$db" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';")"
  [[ "$tables" -gt 0 ]] || { warn "aucune table restaurée dans $db."; return 1; }
  log "  tables : $tables"
  if [[ "$(pg_sql -d "$db" -c "SELECT to_regclass('public._prisma_migrations') IS NOT NULL;")" == "t" ]]; then
    migrations="$(pg_sql -d "$db" -c "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;")"
    last="$(pg_sql -d "$db" -c "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1;")"
    log "  migrations Prisma appliquées : $migrations (dernière : ${last:-aucune})"
  else
    warn "  pas de table _prisma_migrations dans $db."
  fi
  local t n
  for t in User TokenAnalysis Watch Alert Subscription AuditLog; do
    if [[ "$(pg_sql -d "$db" -c "SELECT to_regclass('public.\"$t\"') IS NOT NULL;")" == "t" ]]; then
      n="$(pg_sql -d "$db" -c "SELECT count(*) FROM \"$t\";")"
      log "  $t : $n ligne(s)"
    fi
  done
}

if [[ "$mode" == check ]]; then
  verify_file
  log "restauration de test dans $CHECK_DB…"
  terminate_connections "$CHECK_DB"
  pg_sql -d postgres -c "DROP DATABASE IF EXISTS $CHECK_DB;"
  pg_sql -d postgres -c "CREATE DATABASE $CHECK_DB TEMPLATE template0 ENCODING 'UTF8';"
  pg_sql -d postgres -c "REVOKE ALL ON DATABASE $CHECK_DB FROM PUBLIC;"
  if ! pg_exec pg_restore -U postgres -d "$CHECK_DB" --no-owner --no-acl --exit-on-error <"$file"; then
    pg_sql -d postgres -c "DROP DATABASE IF EXISTS $CHECK_DB;" || true
    die "la restauration de test a échoué."
  fi
  if ! summarize "$CHECK_DB"; then
    pg_sql -d postgres -c "DROP DATABASE IF EXISTS $CHECK_DB;" || true
    die "contrôle de la base restaurée en échec."
  fi
  if [[ "$keep" == 1 ]]; then
    log "base $CHECK_DB conservée (à supprimer : docker exec raijin-postgres dropdb -U postgres $CHECK_DB)."
  else
    pg_sql -d postgres -c "DROP DATABASE $CHECK_DB;"
  fi
  log "RESTAURATION DE TEST RÉUSSIE : $(basename "$file")"
  exit 0
fi

# ---------------------------------------------------------------------------------------------------
# Restauration réelle
# ---------------------------------------------------------------------------------------------------
owner="$(owner_of "$target")" || die "--into accepte seulement raijin ou raijin_bench."
service=raijin-api
[[ "$target" == raijin_bench ]] && service=raijin-bench-api
stamp="$(date -u '+%Y%m%d%H%M%S')"
# Tests seulement (infra/ci/test-restore.sh) : suffixe imposé pour provoquer un renommage refusé.
if [[ -n "${RAIJIN_RESTORE_STAMP:-}" ]]; then
  [[ "$RAIJIN_RESTORE_STAMP" =~ ^[a-z0-9_]{1,32}$ ]] || die "RAIJIN_RESTORE_STAMP invalide."
  stamp="$RAIJIN_RESTORE_STAMP"
fi
previous="${target}_avant_restauration_${stamp}"

verify_file
log "Base cible : $target (utilisateur $owner). Fichier : $file"
log "La base actuelle sera renommée « $previous » (rien n'est supprimé) ; $service sera arrêtée pendant l'opération."
if [[ "$assume_yes" != 1 ]]; then
  read -r -p "Pour continuer, tape exactement : RESTAURER $target > " answer
  [[ "$answer" == "RESTAURER $target" ]] || die "abandon (confirmation différente)."
fi

if [[ "$manage_service" == 1 ]]; then
  log "arrêt de $service…"
  # Bloquant : restaurer sous une API encore active mélangerait écritures et restauration.
  compose stop "$service" || die "impossible d'arrêter $service : restauration annulée, rien n'a été modifié."
fi

sessions_on() {
  pg_sql -d postgres -c "SELECT count(*) FROM pg_stat_activity WHERE datname = '$1' AND pid <> pg_backend_pid();"
}

# État : la base d'origine n'est jamais supprimée. Le rollback ne supprime « $target » que si c'est la base
# NEUVE créée par ce script (base d'origine déjà renommée, ou absente au départ).
renamed=0
renaming=0
original_absent=0
rollback() {
  # Avec set -E, le piège est hérité par les sous-shells ($(...)) : seul le shell principal a le droit d'agir,
  # un sous-shell se contente d'échouer (le principal reprend ensuite la main avec l'état exact).
  [[ "$BASHPID" == "$$" ]] || exit 1
  # Le retour arrière lui-même ne doit pas être interrompu (Ctrl+C répété, arrêt du terminal).
  trap - ERR
  trap '' INT TERM HUP
  # Tests seulement (cas m2) : 2e interruption pendant le retour arrière, ignorée par le piège ci-dessus.
  if [[ "${RAIJIN_TEST_FAULT:-}" == "after_rename:twice" ]]; then kill -INT "$$"; fi
  warn "échec ou interruption : remise en place de la base d'origine."
  if [[ "$renamed" == 1 ]]; then
    # Ne supprimer la base neuve que si l'originale est bien là, sous son nom de secours.
    if pg_db_exists "$previous"; then
      terminate_connections "$target" || true
      pg_sql -d postgres -c "DROP DATABASE IF EXISTS $target;" || true
      pg_sql -d postgres -c "ALTER DATABASE $previous RENAME TO $target;" \
        || warn "remets la base à la main : docker exec -i $RAIJIN_PG_CONTAINER psql -U postgres -c 'ALTER DATABASE $previous RENAME TO $target;'"
    else
      warn "base de secours $previous introuvable : rien n'est supprimé. Vérifie : docker exec -i $RAIJIN_PG_CONTAINER psql -U postgres -l"
    fi
  elif [[ "$renaming" == 1 ]]; then
    # Interruption entre le RENAME et « renamed=1 » : le renommage a peut-être eu lieu. On ne fait que le défaire,
    # et seulement si la situation est certaine (secours présent, cible absente) ; aucune suppression.
    if pg_db_exists "$previous" && ! pg_db_exists "$target"; then
      pg_sql -d postgres -c "ALTER DATABASE $previous RENAME TO $target;" \
        || warn "remets la base à la main : docker exec -i $RAIJIN_PG_CONTAINER psql -U postgres -c 'ALTER DATABASE $previous RENAME TO $target;'"
    fi
  elif [[ "$original_absent" == 1 ]]; then
    # Aucune base d'origine (constat certain, pg_db_exists) : seule la base neuve est supprimée.
    terminate_connections "$target" || true
    pg_sql -d postgres -c "DROP DATABASE IF EXISTS $target;" || true
  fi
  [[ "$manage_service" == 1 ]] && { compose up -d "$service" || true; }
  die "restauration annulée, base d'origine conservée sous le nom $target."
}
trap rollback ERR INT TERM HUP

if pg_db_exists "$target"; then
  if [[ "$manage_service" == 0 ]]; then
    # --no-service : on ne coupe personne ; des sessions ouvertes = l'API tourne encore.
    open_sessions="$(sessions_on "$target")"
    [[ "$open_sessions" == 0 ]] || { trap - ERR; die "$open_sessions session(s) ouverte(s) sur $target : arrête l'application (ou retire --no-service). Rien n'a été modifié."; }
  else
    terminate_connections "$target"
  fi
  renaming=1
  pg_sql -d postgres -c "ALTER DATABASE $target RENAME TO $previous;"
  # Tests seulement (cas m1) : interruption simulée entre le RENAME et « renamed=1 ».
  if [[ "${RAIJIN_TEST_FAULT:-}" == after_rename* ]]; then kill -INT "$$"; fi
  renamed=1
  log "base actuelle renommée en $previous."
else
  original_absent=1
fi

# Base vide, propriétaire et droits identiques à une installation neuve.
pg_exec sh /docker-entrypoint-initdb.d/10-raijin-databases.sh >/dev/null
pg_exec pg_restore -U postgres -d "$target" --role="$owner" --no-owner --no-acl --exit-on-error --single-transaction <"$file"
pg_sql -d "$target" -c "ALTER SCHEMA public OWNER TO $owner;"
summarize "$target"
trap - ERR INT TERM HUP

if [[ "$manage_service" == 1 ]]; then
  log "redémarrage de $service…"
  compose up -d --wait "$service"
fi
log "RESTAURATION RÉUSSIE dans $target."
if [[ "$renamed" == 1 ]]; then
  log "Quand tout est vérifié, supprime l'ancienne base :"
  log "  docker exec raijin-postgres dropdb -U postgres $previous"
fi
