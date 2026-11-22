# api-alerts

Suivis, alertes, préférences de notification et push de l'API Raijin (PROMPT.md §4.2, §4.4 ; docs/ARCHITECTURE.md §11).

- Routes `/api/v1` : `watches` (CRUD, pause/reprise, limites par plan relues en base), `alerts` (liste par curseur,
  non-lues, lu/non lu), `notifications` (réglages, préférences), `push` (clé VAPID, abonnement, désabonnement),
  `internal` (tests e2e seulement, `JOBS_TEST_TRIGGER=1`, 404 sinon).
- Jobs BullMQ (`jobs/`) : files `watch` (planificateur, passe rapide), `watch-holders`, `watch-full`, `notify`
  (push par alerte, e-mail groupé), `maintenance` (purge, résumé hebdomadaire). Les services sont testés sans
  Redis (`RecordingJobQueue`, `src/testing/memory-prisma.ts`).
- Détection : `mergeWatchSnapshot` / `detectWatchEvents` (`@raijin/shared-risk-engine`) sur les collecteurs de
  `@raijin/api-solana` (voie de crédits `watch`) ; idempotence par `WatchEvent @@unique([mint, dedupeKey])` et
  `Alert @@unique([userId, eventId])`.

`nx test api-alerts` · `nx e2e api-e2e` (Postgres, Redis, Mailpit de `docker-compose.dev.yml`).
