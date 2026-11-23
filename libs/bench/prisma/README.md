# bench-prisma

Base du banc `raijin_bench` (docs/ARCHITECTURE.md §17, inventaire docs/BENCH.md §4–§5) : schéma Prisma,
migrations SQL et client (`BenchPrismaService`, adaptateur `pg`), séparés de `api-prisma`.
Tags : `scope:bench`, `type:data-access`. Alias : `@raijin/bench-prisma`.

## Contenu de la base

| Schéma | Contenu | Accès |
|---|---|---|
| `public` | 21 tables portées de Supabase + 11 tables du VPS (`bench_owner`, `bench_owner_totp`, `bench_recovery_codes`, `bench_sessions`, `job_runs`, `bench_state`, `verdict_records`, `follow_up_observations`, `daily_verdict_metrics`, `engine_variants`, `variant_replays`) | client Prisma + SQL brut |
| `shadow_ref` | instantané Supabase de la fenêtre comparée en mode ombre (7 tables, mêmes colonnes que `public`) + `snapshot_meta` | SQL brut ; rempli par `infra/bench-migrate.sh --shadow-snapshot` |
| `archive` | vide ; copie facultative des tables mortes et colonnes archivées (`--with-archive`) | lecture seule, lu par aucun code |

Listes de référence (tests, migration, comparaison) : `src/lib/bench-tables.ts`.

## Origine du schéma (tables portées)

La migration `20261124000000_ported_tables` n'a pas été réécrite à la main : les 29 migrations de
`legacy/supabase/migrations` ont été rejouées sur un Postgres 17 jetable (rôles `anon` / `authenticated` /
`service_role` et `auth.users` factices), puis transformées et exportées par `pg_dump --schema-only` :

1. suppression des 10 tables mortes, de la vue `ohlcv_candles_flat` et de `claim_test_push` (BENCH.md §8) ;
2. suppression des colonnes archivées le 21/11 qui ne sont **ni écrites ni lues** (P3, `DROPPED_ARCHIVED_COLUMNS`) ;
   gardées car encore lues : `tokens.liquidity_jup_usd` (front), `token_snapshots.score` / `zone_status`
   (`x3_backfill_candidates`), `entry_*` de `signal_outcomes` / `preset_signals` (backtest) ;
3. suppression des policies, de la RLS, des grants et de la publication Realtime (garde applicative) ;
4. `auth.users` → `public.bench_owner` (compte unique, clés étrangères gardées avec le même `ON DELETE`),
   `auth.uid()` → `public.bench_owner_id()` dans les défauts et les corps de fonctions (P2).

Les corps des 27 fonctions portées sont **identiques** à leur dernière définition Supabase (à la
substitution près) : vérifié par `src/lib/migrations.spec.ts` tant que `legacy/` existe. Les 8 déclencheurs
vivants sont conservés en SQL (P5), y compris `push_subscriptions_cap` et `alert_settings_touch`.
`schema.prisma` est le reflet des migrations (`prisma db pull`) : l'écart doit rester nul.

## À savoir pour le portage et l'import (T6, T7, T9)

- Noms snake_case identiques aux tables Supabase : le SQL des Edge Functions et des RPC se porte tel quel
  (`$queryRaw`, ou appel direct des fonctions SQL conservées, ex. `select * from public.paper_apply_v2(...)`).
- Les RPC « front » lisent le propriétaire par `public.bench_owner_id()` : sans ligne `bench_owner`, elles
  lèvent `not authenticated` (42501) comme avant ; la CLI `set-password` crée la ligne.
- Identités `GENERATED ALWAYS` (`IDENTITY_ALWAYS_TABLES`) : un import qui garde les `id` d'origine passe par
  `OVERRIDING SYSTEM VALUE`, puis `setval` sur la séquence.
- `alert_log_single_has_plan` est `NOT VALID` (lignes historiques) : elle s'applique quand même aux
  `INSERT` ; l'import la retire puis la remet en `NOT VALID` (`NOT_VALID_CONSTRAINTS`).
- Les `id` `bigint` (`alert_log`, `token_snapshots`…) arrivent en `bigint` JS : à convertir pour le JSON.
- Plafond Helius journalier de `wallet-study` (P1) : non stocké ici, compteur Redis `raijin-bench:` (T4/T7).

## Commandes

```bash
pnpm nx run-many -t lint typecheck test build -p bench-prisma
pnpm nx run bench-prisma:prisma-generate            # client dans src/generated (ignoré par Git)
pnpm nx run bench-prisma:migrate                    # = migrate deploy (BENCH_DATABASE_URL, utilisateur raijin_bench)
pnpm nx run bench-prisma:migrate-status
pnpm nx run bench-prisma:migrate-check              # Postgres 17.12 jetable : deploy, écart nul, cloisonnement, test-db
BENCH_TEST_DATABASE_URL=… pnpm nx run bench-prisma:test-db   # déclencheurs et fonctions SQL sur une base migrée
```

En dev, sans `BENCH_DATABASE_URL`, la CLI vise `raijin_bench_dev` sur le Postgres de `docker-compose.dev.yml`
(port 5433). Ne jamais lancer `prisma migrate reset`. Sur le VPS, les migrations sont lancées par
l'utilisateur (service du profil `tools`, T10), jamais par un agent.
