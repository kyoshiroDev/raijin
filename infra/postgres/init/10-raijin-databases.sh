#!/bin/sh
# Bases et utilisateurs de raijin-postgres (PROMPT.md §4.8 et §7) :
#   raijin        (base de l'API Raijin)          ← utilisateur raijin        (propriétaire, non superutilisateur)
#   raijin_bench  (base du banc, phase 8 bis)     ← utilisateur raijin_bench  (propriétaire, non superutilisateur)
# Aucun droit croisé : CONNECT retiré à PUBLIC sur chaque base, accordé seulement à son propriétaire.
#
# Exécuté automatiquement par l'image postgres au PREMIER démarrage (volume vide), puis à chaque déploiement
# par infra/deploy.sh (idempotent : crée ce qui manque, remet les mots de passe de infra/.env).
# Les mots de passe sont lus par psql dans l'environnement (\getenv), jamais dans un journal ni sur une ligne de commande.
set -eu

: "${RAIJIN_DB_PASSWORD:?RAIJIN_DB_PASSWORD manquant}"
: "${BENCH_DB_PASSWORD:?BENCH_DB_PASSWORD manquant}"

psql -v ON_ERROR_STOP=1 --no-psqlrc --quiet \
  --username "${POSTGRES_USER:-postgres}" --dbname postgres <<'SQL'
SET client_min_messages = warning;
-- Mots de passe lus dans l'environnement par psql (\getenv, psql ≥ 15) : jamais dans argv ni dans `ps`.
\getenv raijin_pw RAIJIN_DB_PASSWORD
\getenv bench_pw BENCH_DB_PASSWORD

-- Rôles (créés s'ils manquent, mot de passe toujours réaligné sur infra/.env)
SELECT 'CREATE ROLE raijin LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'raijin') \gexec
SELECT 'CREATE ROLE raijin_bench LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'raijin_bench') \gexec
SELECT format('ALTER ROLE raijin WITH LOGIN PASSWORD %L', :'raijin_pw') \gexec
SELECT format('ALTER ROLE raijin_bench WITH LOGIN PASSWORD %L', :'bench_pw') \gexec

-- Bases
SELECT 'CREATE DATABASE raijin OWNER raijin ENCODING ''UTF8'' TEMPLATE template0'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'raijin') \gexec
SELECT 'CREATE DATABASE raijin_bench OWNER raijin_bench ENCODING ''UTF8'' TEMPLATE template0'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'raijin_bench') \gexec

-- Cloisonnement : personne d'autre que le propriétaire (et le superutilisateur) ne se connecte.
REVOKE ALL ON DATABASE raijin FROM PUBLIC;
REVOKE ALL ON DATABASE raijin_bench FROM PUBLIC;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE raijin TO raijin;
GRANT CONNECT, TEMPORARY ON DATABASE raijin_bench TO raijin_bench;
SQL

# Schéma public de chaque base : propriété de l'utilisateur de la base, fermé à PUBLIC.
for pair in raijin:raijin raijin_bench:raijin_bench; do
  db=${pair%%:*}
  owner=${pair##*:}
  psql -v ON_ERROR_STOP=1 --no-psqlrc --quiet --username "${POSTGRES_USER:-postgres}" --dbname "$db" \
    -v owner="$owner" <<'SQL'
SET client_min_messages = warning;
ALTER SCHEMA public OWNER TO :"owner";
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL
done

echo "raijin-postgres : bases raijin et raijin_bench prêtes (utilisateurs séparés)."
