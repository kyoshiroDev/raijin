# BENCH — Raijin-banc-de-test : inventaire Supabase → VPS

Phase 8 bis, tâche T1. Source : `legacy/supabase` (copie de `raijin-old/supabase`, 29 migrations du 16/11 au 23/11/2026),
`legacy/docs/ARCHIVE.md`, front `apps/raijin-banc-de-test/src`. Inventaire **statique** (fichiers du dépôt) : aucune
connexion à Supabase (réf. `jntknbxdpetvcmoejncm`), aucune lecture de `.env*` / `.secrets/`, aucune valeur de secret.
Les volumétries sont des estimations tirées des commentaires des migrations et des contrats ; les chiffres réels
seront relevés par `infra/bench-migrate.sh --dry-run` (T9, lancé par l'utilisateur).

Légende cible : **P** = table Prisma de `raijin_bench` (`libs/bench/prisma`) · **J** = job BullMQ (préfixe `raijin-bench`,
verrou anti-chevauchement, ligne `job_runs`) · **E** = endpoint `/api/...` de `apps/raijin-banc-de-test-api` · **SSE** =
événement de `GET /api/events` · **Ab.** = abandonné (mort, non porté).

## 1. Chiffres clés

| Élément | Source | Nombre | Portés | Abandonnés |
|---|---|---|---|---|
| Edge Functions | `functions/*` (hors `_shared`, `_typecheck`) | 7 | 7 | 0 |
| Fichiers pg_cron | `sql/schedule_*.sql` | 7 | — | — |
| Jobs pg_cron (noms distincts) | `cron.schedule('raijin-…')` | 12 | 12 (dont 1 à vérifier) | 0 (+ 4 déjà retirés le 21/11) |
| Tables `public` | `create table` | 31 | 21 | 10 |
| Vues | `create view` | 1 | 0 | 1 |
| Fonctions SQL (noms distincts) | `create [or replace] function` | 31 (28 vivantes) | 25 | 3 supprimées + 3 remplacées |
| Déclencheurs vivants | `create trigger` | 9 | 9 (SQL ou service) | 1 supprimé |
| Policies RLS vivantes | `create policy` | 35 (37 − 2 supprimées) | 0 (garde applicative) | 35 |
| RPC appelées par le front | `supabase.rpc(…)` | 8 | 8 → E | 0 |
| Canaux Realtime | `supabase.channel(…)` | 2 (3 tables) | 2 → SSE | 0 |
| Fichiers du front injectant `SUPABASE` | `inject(SUPABASE)` | 13 (+ `supabase-client.ts`) | 13 → `bench-data-access` | — |
| Secrets Vault | `vault.decrypted_secrets` | 2 noms | 0 | 2 |

## 2. Edge Functions → modules NestJS

Toutes (sauf `send-test-push`) : appel `POST` par pg_cron via `pg_net` avec l'en-tête `x-cron-secret` (comparaison à
temps constant, 401 sinon), `verify_jwt = false`, délai `pg_net` 55 s. Sur le VPS : pas d'appel HTTP, le job BullMQ
appelle directement le service ; `CRON_SECRET` disparaît.

| Fonction (lignes) | Rôle | Déclencheur / fréquence | Tables lues → écrites | Appels externes / budget | Crédits Helius | Cible |
|---|---|---|---|---|---|---|
| `scan-tokens` (848 + `notify.ts`) | Collecte des candidats, filtres MC/liquidité, quota d'âge, enrichissement fusionné, audits Jupiter (top 40), drapeaux + consensus, features de détection, `spark_6h`, contexte marché (SOL/USD, EUR/USD via EURC), `preset_signals` (young_calm / young_frenzy), alertes « Jeune calme » (push VAPID), auto-paper « Calme / Frénésie », suivi d'alerte 7 j | `raijin-scan` `*/2 * * * *` ; garde de chevauchement : un scan plus ancien < 90 s non terminé → saut | `scan_runs`, `tokens`, `token_snapshots`, `signal_outcomes`, `preset_signals`, `alert_settings`, `alert_log`, `push_subscriptions`, `paper_positions` ; RPC `x3_snapshot_history`, `apply_alert_tracking`, `paper_open_position_as` | DexScreener (listes + mots-clés + paires), GeckoTerminal (≤ 4 appels, pools < 24 h), Jupiter `lite-api.jup.ag`/`api.jup.ag` (recent + audits) ; `ScanBudget` : tout annulé à 38 s ; hôtes en liste blanche, pas de redirection | 0 | `bench-collect` / `ScanModule`, **J** `scan` `*/2 * * * *` (verrou BullMQ remplace la garde 90 s, sauts journalisés `skipped`) ; push via `server-push` (coupé en `shadow`) ; **SSE** `tokens` |
| `enrich-tokens` (166) | Données croisées des tokens frais : GeckoTerminal multi-pools (1 appel, top 30), RugCheck (top 30, cache 30 min via `rugcheck_at`), aller-retour Jupiter 0,1 SOL (top 15) ; `UPDATE` des seules colonnes d'enrichissement + drapeaux | `raijin-enrich` `1-59/2 * * * *` | `tokens` → `tokens` (UPDATE) | GeckoTerminal 1, RugCheck ≤ 30, Jupiter ≤ 30 quotes ; plus de tâche après 30 s, abandon à 40 s | 0 | `bench-collect` / `EnrichModule`, **J** `enrich` `1-59/2 * * * *` ; clients `api-solana` (RugCheck, GeckoTerminal, Jupiter) |
| `label-outcomes` (393) | (1) rattrapage `signal_outcomes` depuis le 1er snapshot (≤ 200, minutes 1, 11, 21…) ; (2) étiquettes 7 j (x2, x3, x5, SL30, dd50…) aux points de contrôle `next_label_at` ; (3) capture de bougies 1 min × 360 / 5 min × 864 en 1 ligne compacte `ohlcv_candles` ; file fusionnée à 6 priorités ; journal `label_runs` | `raijin-label` `1-59/2 * * * *` (le `7-59/10` de `schedule_cron.sql` est remplacé par `schedule_label.sql`) | `signal_outcomes`, `preset_signals`, `backtest_events`, `ohlcv_candles`, `token_snapshots` → idem + `label_runs` ; RPC `x3_backfill_candidates` | GeckoTerminal OHLCV ≤ 5 req/appel, 1 toutes les 8 s, arrêt au 1er 429, plus rien après 40 s | 0 | `bench-collect` / `LabelModule`, **J** `label` `1-59/2 * * * *` (rattrapage si `minute % 10 == 1`) |
| `paper-engine` (162) | Simulation paper v2 : positions actives (≤ 1000 lues, ≤ 500 traitées, tourniquet par utilisateur), prix du dernier snapshot < 6 min, quotes Jupiter pour remplissage / sortie, `step()` → `paper_apply_v2`, expirations | `raijin-paper` `1-59/2 * * * *` (~20 s après le scan) | `paper_positions`, `paper_legs`, `token_snapshots` → RPC `paper_apply_v2` | Jupiter quote ≤ 10, 1 / 2,1 s à partir de t = 10 s, rien après 34 s, arrêt sur 429 ; sans quote : impact +2 % | 0 | `bench-trading` / `PaperEngineModule`, **J** `paper` `1-59/2 * * * *` (délai de démarrage 10 s conservé) ; **SSE** `paper` |
| `backtest-run` (792) | Laboratoire : machine à états d'un run (simulate → split 70/30 → aggregate → done), tranches idempotentes, bootstrap IC ; garde 3 runs de trades, 14 de résultats | `raijin-backtest-worker` `* * * * *` ; runs créés par `backtest_enqueue_nightly` (03:40) ou `rpc backtest_request_run` | `signal_outcomes`, `preset_signals`, `ohlcv_candles`, `tokens`, `token_snapshots`, `backtest_events`, `backtest_event_state` → `backtest_runs`, `backtest_trades`, `backtest_results`, `backtest_events` ; RPC `backtest_trades_slice` | aucun ; calcul ≤ 1,2 s par tranche (limite CPU Edge) | 0 | `bench-trading` / `BacktestModule`, **J** `backtest-worker` `* * * * *` ; bail `locked_until` conservé (double sécurité avec le verrou BullMQ). Les limites CPU Edge (1,2 s) peuvent être relâchées ensuite, **pas au portage** (comportement inchangé) |
| `wallet-study-collect` (125) | Étude hors ligne des premiers acheteurs (≤ 50 par mint) des détections étiquetées : créateur, pages de transactions du pool | `raijin-wallet-study` `* * * * *` ; bail 90 s à jeton propriétaire | `wallet_study_state`, `early_buyers`, `wallet_study_budget` ; RPC `wallet_study_claim/release/reserve/refund/queue` | Helius RPC `getTransactionsForAddress` (`mainnet.helius-rpc.com`, clé en paramètre d'URL), ≥ 150 ms entre requêtes, rien après 30 s, 15 s par requête ; ≤ 5 mints × 20 pages par appel | **10 / page de 100 tx**, réservés avant chaque requête ; plafond **cumulé** 600 000 (CHECK) ; pire cas théorique ≈ 2 000 / min | `bench-collect` / `WalletStudyModule`, **J** `wallet-study` `* * * * *` ; clé `BENCH_HELIUS_API_KEY` via `api-solana` (T4) ; **budget à trancher** (§9 P1) |
| `send-test-push` (76) | Notification de test vers les abonnements de l'appelant, 1 / min / utilisateur (`claim_test_push`), contrôle d'origine (`ALLOWED_ORIGINS`) | HTTP depuis Réglages → « Tester », `verify_jwt = true` | `push_subscriptions` (lecture, suppression des abonnements morts), `test_push_throttle` | services push (`web.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com`) | 0 | **E** `POST /api/push/test` (`bench-core`, `server-push`), limite 1 / min par throttler Redis ; refus en `shadow` (409 explicite) |

Code partagé `_shared/` (≈ 60 modules + 36 fichiers `*_test.ts`, fixtures enregistrées dans `_shared/test-support/` :
`source-fixtures.ts`, `enrich-fixtures.ts`, `x3-fixtures.ts`, `paper-v1-migration.ts`) : porté module par module dans les
libs ci-dessus ; les tests Deno et leurs fixtures servent de **référence de comportement** pour les tests Jest de T7
(mêmes entrées, mêmes sorties). Fonctions déjà supprimées avant l'import : `scan-early`, `track-fast` (Ab.).

## 3. Tâches pg_cron → jobs BullMQ

Mêmes motifs cron (fuseau UTC, comme pg_cron Supabase). Chaque job : verrou (une seule exécution à la fois, la suivante
est journalisée `skipped`), ligne `job_runs` (début, fin, statut, durée, erreur tronquée sans secret).

| Job pg_cron | Fichier | Motif | Action | Cible |
|---|---|---|---|---|
| `raijin-scan` | `schedule_cron.sql` | `*/2 * * * *` | `scan-tokens` | **J** `scan` |
| `raijin-enrich` | `schedule_cron.sql`, `schedule_enrich.sql` | `1-59/2 * * * *` | `enrich-tokens` | **J** `enrich` |
| `raijin-label` | `schedule_cron.sql` (`7-59/10`, remplacé), `schedule_label.sql` | `1-59/2 * * * *` | `label-outcomes` | **J** `label` |
| `raijin-paper` | `schedule_cron.sql`, `schedule_paper.sql` | `1-59/2 * * * *` | `paper-engine` | **J** `paper` |
| `raijin-backtest-worker` | `schedule_backtest.sql` | `* * * * *` | `backtest-run` | **J** `backtest-worker` |
| `raijin-backtest-nightly` | `schedule_backtest.sql` | `40 3 * * *` | `select backtest_enqueue_nightly()` | **J** `backtest-nightly` |
| `raijin-wallet-study` | `schedule_wallet_study.sql` | `* * * * *` | `wallet-study-collect` | **J** `wallet-study` |
| `raijin-purge-snapshots` | `schedule_cron.sql` (30 j simple, remplacé), `schedule_purge_snapshots.sql` | `15 3 * * *` | supprime `token_snapshots` > 30 j, ou > 3 j si le mint n'a pas d'alerte < 30 j **et** existe dans `signal_outcomes` | **J** `purge` (étape `snapshots`), après les agrégats (`bench-quality`, §16.5) |
| `raijin-purge-scan-runs` | `schedule_cron.sql` | `20 3 * * *` | `scan_runs` > 7 j | **J** `purge` (étape `scan-runs`) |
| `raijin-purge-alert-log` | `schedule_cron.sql` | `25 3 * * *` | `alert_log` > 30 j | **J** `purge` (étape `alert-log`) — **absent de la liste de contrôle du 21/11 (10 jobs)** : vérifier `select jobname from cron.job` (lecture, par l'utilisateur) |
| `raijin-purge-candles` | `schedule_backtest.sql` | `25 3 * * *` | `ohlcv_candles` (`detected_at` > 30 j) | **J** `purge` (étape `candles`) |
| `raijin-purge-lab` | `schedule_backtest.sql` | `30 3 * * *` | `backtest_events` > 30 j ; `backtest_event_state` (hors `cursor`) > 7 j ; `label_runs` > 7 j | **J** `purge` (étape `lab`) |
| `raijin-early`, `raijin-purge-early`, `raijin-fast`, `raijin-purge-fast-ticks` | retirés par `unschedule_slim_down.sql` (21/11) | — | — | **Ab.** (déjà morts) |

Nouveaux jobs sans équivalent Supabase (§16 ; noms de `BENCH_JOB_NAMES`, `@raijin/bench-contracts`) : `verdict-follow-up` (fenêtres 24 h / 72 h / 7 j), `verdict-aggregate`
(agrégats avant purge), `storage-check` (alerte 80 % / 95 %), purge `job_runs` 30 j. Les 4 purges nocturnes sont regroupées
en un job `retention-purge` à étapes ordonnées (03:15 → 03:30) ; à défaut, 4 jobs aux mêmes motifs (à trancher en T6, sans effet
sur les données).

## 4. Tables (31) → `raijin_bench`

RLS activée sur les 31. Policies : lecture `authenticated` (« readable by signed-in users ») sauf mention ; aucune
écriture client hors `watchlist`, `push_subscriptions`, `alert_settings`. Écritures par `service_role` (Edge Functions)
ou RPC `security definer`. Clés étrangères vers `auth.users` notées **(U)**. Colonnes complètes : annexe A.

| Table | Créée | Cols | Clé primaire / unicité | Index (hors PK) | RLS / droits | Volumétrie estimée | Cible |
|---|---|---|---|---|---|---|---|
| `tokens` | 16/11 | 71 | `mint` | `score desc`, `updated_at desc`, `zone_status`, `sources` (GIN), `pair_created_at desc nulls last` | select `authenticated` ; Realtime | quelques milliers (upsert) | **P** `tokens` ; colonnes archivées (score, zones, ×3, `liquidity_jup_usd`) : §9 P3 ; **SSE** `tokens` |
| `token_snapshots` | 16/11 | 25 | `id` ; FK `tokens` | `(mint, captured_at desc)`, `captured_at`, `(captured_at, id)` | select `authenticated` | **≈ 115 000 / jour** ; rétention 3 j / 30 j (purge) | **P** `token_snapshots` (rétention configurable, §16.5) |
| `scan_runs` | 16/11 | 9 | `id` | `started_at desc` | select `authenticated` | 720 / jour, 7 j | **P** `scan_runs` (en plus de `job_runs` : compteurs par source, SOL/USD, EUR/USD lus par le front) |
| `watchlist` | 16/11 | 4 | `(user_id, mint)` **(U)**, FK `tokens` | — | CRUD propriétaire (4 policies) | très faible | **Ab.** archivée 21/11, aucun écran |
| `push_subscriptions` | 16/11 | 7 | `id` **(U)** ; `endpoint` unique (upsert `onConflict: endpoint`) | `(user_id, created_at desc)` | CRUD propriétaire (4) ; déclencheur plafond 10 / utilisateur | ≤ 10 | **P** `push_subscriptions` (sans `user_id` ou `user_id` = propriétaire, §9 P2) ; plafond 10 en service |
| `alert_settings` | 16/11 | 22 | `user_id` **(U)** | `user_id where enabled`, `user_id where early_enabled` | CRUD propriétaire (4) ; déclencheur `touch_updated_at` | 1 ligne | **P** `alert_settings` (singleton) ; colonnes archivées : §9 P3 |
| `alert_log` | 16/11 | 23 | `id` **(U)** | `(user_id, sent_at desc)`, `(user_id, mint, sent_at desc)`, `sent_at`, `tracking_until desc where not null`, `(user_id, sent_at desc) where preset='young_strong'` | select propriétaire | faible, 30 j | **P** `alert_log` |
| `test_push_throttle` | 16/11 | 2 | `user_id` **(U)** | — | RLS sans policy (service seul) | 1 ligne | **Ab.** → throttler Redis `raijin-bench:` (1 / min) |
| `signal_outcomes` | 17/11 | 37 | `mint` ; FK `tokens` | `(status, detected_at desc)`, `(labelled_at nulls first, detected_at) where pending`, `next_label_at where pending`, `candles_1m_at`/`candles_5m_at where not null` | select `authenticated` ; déclencheurs de points de contrôle | **≈ 270 / jour**, sans purge | **P** `signal_outcomes` |
| `model_weights` | 17/11 | 6 | `id` ; unique `active where active` | — | select `authenticated` | quelques lignes | **Ab.** modèle ×3 supprimé (archivée 21/11) |
| `paper_wallets` | 17/11 | 6 | `user_id` → `(user_id, book)` depuis 18/11 **(U)** | — | select propriétaire | 1 par book (≤ 12) | **P** `paper_wallets` (clé `book` + propriétaire) |
| `paper_orders_v1` (ex-`paper_orders`) | 17/11 | 21 | `id` **(U)** | `(user_id, status)`, `(user_id, created_at desc)`, `status where active`, `mint where active` | select propriétaire (policies supprimées 18/11) | figée 18/11 | **Ab.** gelée (migrée en v2 le 18/11) ; historique : §9 P4 |
| `early_candidates` | 18/11 | 36 | `mint` | `(eligible, early_score desc)`, `last_seen_at desc` | select `authenticated` | figée 21/11 | **Ab.** radar précoce supprimé |
| `early_observations` | 18/11 | 23 | `id` ; FK `early_candidates` | `(mint, at desc)`, `at` | RLS sans policy | figée 21/11 (non purgée) | **Ab.** |
| `early_outcomes` | 18/11 | 26 | `mint` | `(status, detected_at desc)`, `labelled_at… where pending`, `next_label_at where pending` | select `authenticated` ; déclencheur | figée 21/11 | **Ab.** |
| `early_runs` | 18/11 | 10 | `id` | `started_at desc` | RLS sans policy | figée 21/11 | **Ab.** |
| `paper_positions` | 18/11 | 23 | `id` ; unique `(id, user_id)` **(U)** ; FK `alert_log` | `(user_id, book, status)`, `(user_id, created_at desc)`, `created_at where active`, `mint where active`, `alert_id`, `(book, status) where active` ; uniques partielles `(user_id, book, mint)` (books calm/frenzy_all_x2 ; calm_sl30/40, frenzy_sl30 actifs) | select propriétaire ; déclencheur `before insert` ; Realtime | centaines | **P** `paper_positions` (uniques partielles en SQL brut dans la migration Prisma) ; **SSE** `paper` |
| `paper_legs` | 18/11 | 9 | `id` **(U)** ; FK `paper_positions` | `position_id`, `user_id`, `(user_id, closed_at desc) where sl_hit` | select propriétaire ; Realtime | ≤ 3 × positions | **P** `paper_legs` ; **SSE** `paper` |
| `preset_signals` | 19/11 | 35 | `id` ; unique `(preset, mint)` | `(status, detected_at desc)`, `labelled_at… where pending`, `next_label_at where pending`, `(preset, detected_at desc)`, `candles_1m_at`/`candles_5m_at` | select `authenticated` ; déclencheurs | dizaines / jour | **P** `preset_signals` (lignes des presets archivés : importées, en lecture) |
| `fast_watch` | 19/11 | 14 | `mint` | `until desc` | select `authenticated` | figée 21/11 | **Ab.** « Jeune & fort » supprimé |
| `fast_ticks` | 19/11 | 6 | `id` ; unique `(mint, at)` | `at` | select `authenticated` | figée 21/11 (non purgée, potentiellement volumineuse) | **Ab.** |
| `ohlcv_candles` | 19/11 | 15 | `id` ; unique `(mint, tf, ts_start)` | `detected_at`, `fetched_at` | select `authenticated` (pas de `grant` explicite au front) | ≈ 2 lignes compactes / détection, 30 j | **P** `ohlcv_candles` (tableaux `real[]` conservés : stockage compact obligatoire) |
| `backtest_runs` | 19/11 | 17 | `id` ; FK `requested_by` **(U)** | `created_at desc`, `created_at where queued/running` | select `authenticated` ; **grant de colonne** (`summary`, …) | 1 / nuit + demandes | **P** `backtest_runs` (`requested_by` → propriétaire ou null) |
| `backtest_trades` | 19/11 | 9 | `(run_id, source, mint, detected_at)` ; FK `backtest_runs` | `(run_id, detected_at)` | select `authenticated` (non lue par le front) | 3 derniers runs | **P** `backtest_trades` |
| `backtest_results` | 19/11 | 25 | `(run_id, preset, exit, sl_pct, breakeven, time_exit_h, delay_min, narrative, split)` | `(run_id, narrative, split, avg_net_pct desc) where retained` | select `authenticated` | 14 derniers runs | **P** `backtest_results` |
| `backtest_events` | 19/11 | 18 | `id` ; unique `(preset, mint)` | `event_at`, `candles_1m_at`/`candles_5m_at where not null` | select `authenticated` ; déclencheur | 30 j | **P** `backtest_events` |
| `backtest_event_state` | 19/11 | 4 | `key` | `updated_at` | RLS sans policy | quelques lignes, 7 j | **P** `backtest_event_state` |
| `label_runs` | 19/11 | 10 | `id` | `at` | select `authenticated` | 720 / jour, 7 j | **P** `label_runs` (compteurs métier lus par `backfill_progress` ; `job_runs` ne le remplace pas) |
| `wallet_study_state` | 23/11 | 18 | `mint` | `(status, detected_at)` | select `authenticated` | ≤ détections étiquetées | **P** `wallet_study_state` |
| `early_buyers` | 23/11 | 8 | `(mint, wallet)` ; unique `(mint, rank)` ; FK `wallet_study_state` | `wallet` | select `authenticated` | ≤ 50 / mint | **P** `early_buyers` |
| `wallet_study_budget` | 23/11 | 6 | `id` (singleton) | — | select `authenticated` ; CHECK `credits_used ≤ hard_cap ≤ 600 000` | 1 ligne | **P** `wallet_study_budget` (+ budget journalier, §9 P1) |

Repère d'ensemble : base ≈ 133 Mo à la date du contrat strategy-lab (19/11, offre gratuite 500 Mo) ; dominée par
`token_snapshots` et `ohlcv_candles`.

Tables ajoutées sur le VPS (T5, `libs/bench/prisma`) : `bench_owner` (compte unique, remplace `auth.users`),
`bench_owner_totp` (secret chiffré), `bench_recovery_codes` (hachés), `bench_sessions`, `job_runs` (statut
`running|success|failed|skipped`), `bench_state` (niveau d'alerte de stockage…), `verdict_records`,
`follow_up_observations`, `daily_verdict_metrics`, `engine_variants` (drapeau `enabled`), `variant_replays` ;
schéma `shadow_ref` (7 tables comparées + `snapshot_meta`, rempli par T9) et schéma `archive` vide (import
facultatif, P3/P4). Colonnes archivées retirées de `public` et exceptions encore lues : `libs/bench/prisma/README.md`.

**Vue** `ohlcv_candles_flat` (19/11, `security_invoker`, une ligne par bougie via `unnest`) : lisibilité seule, lue par
aucun code → **Ab.** (requête équivalente documentée dans `libs/bench/prisma` si besoin).

## 5. Fonctions SQL, déclencheurs et RPC

`definer` = `security definer` ; `search_path = ''` partout. Les RPC appelées par le front deviennent des endpoints ;
les autres, des méthodes de service transactionnelles (Prisma `$transaction` + SQL brut quand la requête est longue,
**même SQL** pour garder les résultats identiques).

| Fonction | Sécurité / droit | Appelée par | Rôle | Cible |
|---|---|---|---|---|
| `paper_open_position(…)` | definer, `authenticated` | **front** (`paper-trade-store.ts`) | ouvre une position manuelle (book `main`, `all_x2`) | **E** `POST /api/paper/positions` |
| `paper_cancel_position(p_id)` | definer, `authenticated` | **front** (`portfolio-store.ts`) | annule une position pending, libère la mise | **E** `POST /api/paper/positions/:id/cancel` |
| `paper_reset_wallet(p_book)` | definer, `authenticated` | **front** (`portfolio-store.ts`) | réinitialise un book | **E** `POST /api/paper/wallets/:book/reset` |
| `performance_by_preset()` | invoker, `authenticated` | **front** (`performance-store.ts`) | statistiques par preset | **E** `GET /api/performance/presets` |
| `performance_breakdown()` | invoker, `authenticated` | **front** (`performance-store.ts`) | ventilation par source / dex / MC / liquidité | **E** `GET /api/performance/breakdown` |
| `paper_book_comparison()` | invoker, `authenticated` | **front** (`performance-store.ts`) | comparaison des books de test SL | **E** `GET /api/performance/books` |
| `backfill_progress()` | invoker, `authenticated` | **front** (`strategy-lab-store.ts`) | jauge de rattrapage (5 catégories) | **E** `GET /api/lab/backfill-progress` |
| `backtest_request_run()` | definer, `authenticated` | **front** (`strategy-lab-store.ts`) | met un run en file (garde-fous de fréquence) | **E** `POST /api/lab/runs` |
| `paper_open_position_as(…)` (12 args) | definer, `service_role` | `scan-tokens/notify.ts` | ouverture auto-paper (verrou consultatif, plafonds 50 actives / 200 par 24 h, cooldown 12 h) | `bench-trading` `PaperService.openAs` (`pg_advisory_xact_lock`) ; **jamais** en `shadow` |
| `paper_apply_v2(…)` | `service_role` | `paper-engine` | applique un pas (garde optimiste, jambes + solde) | `bench-trading` `PaperService.apply` |
| `paper_ensure_wallet(p_book)` | definer, `authenticated` | interne (ouverture) | crée le portefeuille d'un book | `PaperService` (privé) |
| `backtest_enqueue_nightly()` | `service_role` | pg_cron 03:40 | run nocturne | **J** `backtest-nightly` |
| `backtest_trades_slice(…)` | `service_role` | `backtest-run` | tranche des rendements | `BacktestRepository` (SQL brut) |
| `x3_snapshot_history(mints, since)` | `service_role` | `scan-tokens` | historique pour `spark_6h` | `ScanRepository` (SQL brut) |
| `x3_backfill_candidates(limit)` | `service_role` | `label-outcomes` | tokens sans `signal_outcomes` | `LabelRepository` |
| `apply_alert_tracking(rows)` | `service_role` | `scan-tokens` | suivi d'alerte 7 j (max/min/premier touché) | `AlertTrackingService` |
| `wallet_study_claim/release(…)` | `service_role` | `wallet-study-collect` | bail 90 s à jeton | conservé en SQL (double sécurité avec le verrou BullMQ) |
| `wallet_study_reserve/refund(…)` | `service_role` | `wallet-study-collect` | réservation atomique de crédits | conservé (UPDATE atomique) + plafond journalier |
| `wallet_study_queue(limit)` | `service_role` | `wallet-study-collect` | file des mints | `WalletStudyRepository` |
| `claim_test_push(p_user)` | definer, interne | `send-test-push` | 1 test / min | **Ab.** → throttler Redis |
| `enforce_push_subscription_cap()` | déclencheur `push_subscriptions` | — | ≤ 10 abonnements | conservé en SQL (T5, P5) ; le service peut aussi le contrôler |
| `touch_updated_at()` | déclencheur `alert_settings` | — | `updated_at = now()` | conservé en SQL (T5, P5) |
| `paper_positions_before_insert()` | déclencheur | — | normalisation / contrôles à l'insertion | conservé en SQL brut (migration Prisma) ou porté en service : §9 P5 |
| `set_first_label_checkpoint()` | 3 déclencheurs (`signal_outcomes`, `early_outcomes`, `preset_signals`) | — | `next_label_at = détection + 12 h` | conservé en SQL (2 tables ; `early_outcomes` Ab.) |
| `set_first_candle_checkpoint()` | 2 déclencheurs (`signal_outcomes`, `preset_signals`) | — | `candles_1m_at` / `candles_5m_at` | conservé en SQL |
| `set_event_candle_checkpoint()` | déclencheur `backtest_events` | — | idem pour les événements | conservé en SQL |
| `paper_apply`, `paper_cancel_order`, `paper_orders_before_insert` | supprimées 18/11 | — | paper v1 | **Ab.** (déjà mortes) |

## 6. RLS, Auth, Realtime, Vault

| Mécanisme Supabase | Usage actuel | Cible VPS |
|---|---|---|
| **RLS** (35 policies, 31 tables) | lecture `authenticated` ou propriétaire (`auth.uid() = user_id`) ; `anon` sans aucun droit ; `truncate/references/trigger/maintain` révoqués | Pas de RLS : base `raijin_bench` accessible au seul utilisateur Postgres `raijin_bench` (aucun droit croisé avec `raijin`) ; **garde applicative unique** sur chaque route (session du compte propriétaire + TOTP, 401 sinon) ; DTO à colonnes en liste blanche (reprend les `grant` de colonnes, p. ex. `backtest_runs`) |
| **Auth** (GoTrue) | e-mail + mot de passe, `enable_signup = false`, ≥ 12 caractères avec 4 classes, confirmation e-mail, `secure_password_change`, PKCE, session persistée, mot de passe oublié / réinitialisation par e-mail, `signOut({scope:'others'})`, `onAuthStateChange` ; `site_url` `raijin.vercel.app` | Décision 7 : compte unique `BENCH_OWNER_EMAIL`, argon2id + TOTP (`server-security`), mot de passe et TOTP posés par CLI, **pas** d'inscription, de mot de passe oublié ni de réinitialisation par e-mail ; changement de mot de passe connecté conservé (`account-page.ts`) avec TOTP ; « déconnecter les autres sessions » → suppression des `bench_sessions` sauf la courante |
| **Realtime** canal `tokens-live` | `opportunities-store.ts` : `postgres_changes` `*` sur `tokens` (INSERT/UPDATE/DELETE, ligne complète) | **SSE** `tokens` : un message par lot après chaque scan / enrichissement (liste des lignes modifiées, colonnes `TOKEN_COLUMNS`), `deleted` pour les suppressions ; heartbeat ; reconnexion `EventSource` |
| **Realtime** canal `paper-positions-live` | `portfolio-store.ts` : `*` sur `paper_positions` + `paper_legs`, simple signal → rechargement | **SSE** `paper` (signal sans données, le front recharge par HTTP) |
| Publication `supabase_realtime` | `tokens`, `paper_positions`, `paper_legs` (`paper_orders` retirée 18/11) | — (émission depuis les services après commit) |
| **Vault** | `raijin_project_url`, `raijin_cron_secret` (lus par les 9 commandes `net.http_post` des crons) | **Ab.** : plus d'appel HTTP de cron |
| Secrets Edge (noms) | `CRON_SECRET` ; `SCAN_KEYWORDS`, `MIN_MARKET_CAP`, `MIN_LIQUIDITY` ; `JUP_API_BASE`, `JUP_API_KEY` ; `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` ; `ALLOWED_ORIGINS` ; `HELIUS_API_KEY` ; plate-forme : `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | `infra/.env.bench-api` (T10) : `BENCH_SCAN_KEYWORDS`, `BENCH_MIN_MARKET_CAP`, `BENCH_MIN_LIQUIDITY`, `BENCH_JUP_API_BASE`, `BENCH_JUP_API_KEY`, `BENCH_VAPID_*` (paire distincte de Raijin), `BENCH_HELIUS_API_KEY`, `BENCH_DATABASE_URL`, Redis ACL ; **Ab.** : `CRON_SECRET`, `ALLOWED_ORIGINS` (même origine), `SUPABASE_*` |
| Storage | non utilisé | — |
| Extensions | `pg_cron`, `pg_net` | **Ab.** (BullMQ) |

## 7. Front : dépendances à supabase-js

Client unique `core/supabase/supabase-client.ts` (`createClient`, clé anon publique, PKCE) ; `environment.ts`
(valeurs factices) + `environment.local.ts` ignoré, généré par `scripts/write-env.mjs` ; dépendance
`@supabase/supabase-js@^2.119.2` (`package.json` racine) ; CSP de `legacy/vercel.json` (`connect-src` vers le projet
Supabase, M4). Cible T8 : `libs/bench/data-access` (HttpClient + cookies httpOnly + CSRF, `EventSource`).

| Fichier (`src/app/…`) | Appels | Cible |
|---|---|---|
| `core/auth/auth-store.ts` | `auth.onAuthStateChange`, `getSession`, `signInWithPassword`, `resetPasswordForEmail`, `updateUser({password})`, `signOut({scope:'others'})`, `signOut()` | `POST /api/auth/login` (+ `/totp`), `GET /api/auth/session`, `POST /api/auth/password`, `POST /api/auth/logout[-others]` ; reset **Ab.** |
| `core/preferences/user-preferences.ts` | `from('alert_settings').select().maybeSingle()` | `GET /api/settings` |
| `core/market/market-context.ts` | `from('scan_runs').select('sol_usd,eur_usd').not(null).order(started_at).limit(1)` | `GET /api/market/rates` |
| `features/opportunities/opportunities-store.ts` | `from('tokens').select(TOKEN_COLUMNS).gte(updated_at).order(pair_created_at).limit(300)` ; `channel('tokens-live')`, `removeChannel` | `GET /api/tokens?since=` + **SSE** `tokens` |
| `features/opportunities/token-query.ts`, `token-page.ts` | `from('tokens').select().eq('mint')` | `GET /api/tokens/:mint` |
| `features/opportunities/components/price-chart-store.ts` | `token_snapshots` (mint, depuis, asc, limite) ; `alert_log` (marqueurs) ; `paper_positions` (marqueurs) | `GET /api/tokens/:mint/history`, `/alerts`, `/positions` |
| `features/alerts/alerts-store.ts` | `from('alert_log').in(kind).order(sent_at).limit(300)` ; `from('tokens').in(mint)` | `GET /api/alerts` (tokens joints côté API) |
| `features/portfolio/portfolio-store.ts` | `paper_wallets.in(book)` ; `paper_positions.in(book).order.limit(500)` ; `tokens(mint,price_usd)` ; dernier `token_snapshots` par mint ; `rpc paper_cancel_position`, `rpc paper_reset_wallet` ; `channel('paper-positions-live')` | `GET /api/paper/portfolio`, `GET /api/prices?mints=`, endpoints §5, **SSE** `paper` |
| `features/paper-trade/paper-trade-store.ts` | `paper_wallets.eq(main)`, `paper_positions(pending)` ; `rpc paper_open_position` | `GET /api/paper/wallets/main`, `POST /api/paper/positions` |
| `features/performance/performance-store.ts` | `rpc performance_by_preset`, `paper_book_comparison`, `performance_breakdown` | `GET /api/performance/*` |
| `features/strategy-lab/strategy-lab-store.ts` | `rpc backfill_progress`, `rpc backtest_request_run` ; `backtest_runs` (dernier, `done`) ; `backtest_results.eq(run).eq(retained)` | `GET /api/lab/*`, `POST /api/lab/runs` |
| `features/settings/settings-store.ts` | `alert_settings` select / upsert ×3 ; `push_subscriptions` upsert (`endpoint`) / delete ; `functions.invoke('send-test-push')` | `GET/PUT /api/settings`, `PUT/DELETE /api/push/subscriptions`, `POST /api/push/test` |
| Écrans `features/auth/forgot-password-page.ts`, `reset-password-page.ts` | via `auth-store` | **Ab.** (supprimés) ; `login-page.ts` + écran TOTP |

Autres fichiers contenant le mot « supabase » (commentaires, types, données de test) : `shared/models/token.ts`,
`shared/utils/solana-address.ts`, `opportunities/token-display.ts`, `token-signals.ts`, `paper-trade/paper-strategy.ts`,
`strategy-lab/lab-test-data.ts`, `backtest.ts`, `portfolio/paper-stats.ts`, `settings/alert-settings.ts`,
`auth/password-rules.ts` + 22 specs : à nettoyer en T8 (critère `grep -r supabase apps/raijin-banc-de-test/src` vide).

## 8. Liste « mort, non porté »

Tables : `watchlist`, `model_weights`, `paper_orders_v1`, `early_candidates`, `early_observations`, `early_outcomes`,
`early_runs`, `fast_watch`, `fast_ticks`, `test_push_throttle` (→ Redis). Vue : `ohlcv_candles_flat`. Fonctions :
`claim_test_push` (remplacée par Redis), `paper_apply`, `paper_cancel_order`,
`paper_orders_before_insert` (déjà supprimées). Crons : `raijin-early`, `raijin-purge-early`, `raijin-fast`,
`raijin-purge-fast-ticks` (retirés 21/11). Vault : `raijin_project_url`, `raijin_cron_secret`. Secrets : `CRON_SECRET`,
`ALLOWED_ORIGINS`, `SUPABASE_*`. Extensions `pg_cron`, `pg_net`. Auth : inscription (déjà coupée), mot de passe oublié,
réinitialisation par e-mail. Front : `forgot-password-page`, `reset-password-page`, `supabase-client.ts`, `write-env`.
Colonnes archivées le 21/11 (`legacy/docs/ARCHIVE.md`) : selon §9 P3.

## 9. Risques et points à trancher

| # | Point | Risque | Proposition |
|---|---|---|---|
| P1 | **Budget Helius** : `wallet-study-collect` a un plafond **cumulé** de 600 000 crédits (pire cas ≈ 2 000 / min) alors que le banc a 10 000 crédits / jour (Décision 4), à partager avec les verdicts Raijin (≈ 14 crédits / analyse, ≈ 270 détections / jour ≈ 3 800 / jour + suivis 24 h / 72 h / 7 j) | épuisement quotidien, verdicts manquants | priorité aux verdicts ; `wallet-study` borné par un plafond journalier (`BENCH_WALLET_STUDY_DAILY_CREDITS`, ex. 4 000) en plus du plafond cumulé, ou gelé jusqu'à décision. `getTransactionsForAddress` : disponibilité sur l'offre Helius de l'utilisateur à vérifier |
| P2 | Références `auth.users` (10 tables : `user_id`, `backtest_runs.requested_by`) | réécriture du SQL des RPC si `user_id` disparaît | garder une colonne `user_id uuid` = id de `bench_owner` (constante) : SQL porté quasi à l'identique, transformation triviale dans `bench-migrate.sh` |
| P3 | Colonnes archivées (≈ 30 : `tokens.score`, zones, ×3, `alert_settings.min_*`…) | schéma lourd, ou perte d'historique | ne pas les créer dans `public` ; si l'historique compte, copier les tables d'origine telles quelles dans un schéma `archive` (lecture seule, non lu par le code) |
| P4 | Historique des tables mortes (`early_*`, `fast_*`, `paper_orders_v1`, `model_weights`) | volume inutile (`fast_ticks` non purgée) | ne pas importer par défaut ; option `--with-archive` de `bench-migrate.sh` vers `archive` |
| P5 | Déclencheurs (points de contrôle, `paper_positions_before_insert`) | comportement subtil perdu en le réécrivant | les garder en SQL brut dans la migration Prisma (comportement identique), testés par T5 |
| P6 | IP partagée : sur le VPS, le banc et l'API Raijin appellent GeckoTerminal / DexScreener / Jupiter depuis la **même IP** (limites par IP, 429 déjà mesurés sur `label-outcomes`) | 429 côté Raijin en production | compteurs de débit séparés par préfixe mais plafond global par hôte partagé ; le banc cède la priorité (arrêt au 1er 429, déjà le cas) |
| P7 | Mode ombre : `scan-tokens` ouvre des positions auto-paper et envoie des push ; deux collectes en parallèle doublent la charge sur les API publiques | doublons de notifications, écart de comparaison dû aux 429 | `shadow` : ni push, ni e-mail, ni `paper_open_position_as` ; seuils de comparaison tolérants aux 429 (T11) |
| P8 | Fréquences dépendantes des limites Edge (calcul ≤ 1,2 s, arrêt à 30–44 s, `pg_net` 55 s) | changer ces bornes change les données (débit d'étiquetage, tranches de backtest) | conserver les bornes au portage ; les relâcher ensuite derrière un réglage, mesuré séparément |
| P9 | `raijin-purge-alert-log` défini mais absent de la liste de contrôle du 21/11 | purge à tort ou absente | l'utilisateur vérifie `select jobname, schedule, active from cron.job` (lecture seule) avant T6 |
| P10 | Le banc actuel n'enregistre **aucun verdict du moteur Raijin** (il produit des drapeaux `flags.ts`, pas `shared-risk-engine`) | pas d'historique de justesse à migrer | la justesse démarre à la mise en service du VPS (`verdict_records`) ; les issues historiques (`signal_outcomes` : x2, SL30, dd50) ne sont **pas** des issues §16.2 et ne doivent pas être mélangées ; afficher `n` et « échantillon insuffisant » tant que n < 30 |
| P11 | `noUncheckedIndexedAccess` désactivé dans le banc | portage Deno → Node avec erreurs d'indexation | traitement en T8 seulement si aucun calcul ne change |

## 10. Contrôle d'exhaustivité (grep, depuis la racine)

| Contrôle | Commande | Attendu |
|---|---|---|
| Edge Functions | `ls -d legacy/supabase/functions/*/ \| grep -v '/_' \| wc -l` | 7 (§2) |
| Fichiers cron | `ls legacy/supabase/sql/schedule_*.sql \| wc -l` | 7 (§3) |
| Jobs cron | `grep -A1 -hE "cron\.schedule\(" legacy/supabase/sql/*.sql \| grep -oE "'raijin-[a-z-]+'" \| sort -u` | 12 noms (§3) |
| Tables | `grep -hoiE "create table (if not exists )?public\.\w+" legacy/supabase/migrations/*.sql \| sort -u \| wc -l` | 31 (§4) |
| Vues | `grep -hoiE "create (or replace )?view public\.\w+" legacy/supabase/migrations/*.sql \| sort -u` | 1 (§4) |
| Fonctions | `grep -hoiE "create (or replace )?function public\.\w+" legacy/supabase/migrations/*.sql \| awk '{print $NF}' \| sort -u \| wc -l` | 31 (§5) |
| Policies | `grep -hoiE "create policy" legacy/supabase/migrations/*.sql \| wc -l` | 37 (dont 2 supprimées) |
| Realtime | `grep -hiE "alter publication" legacy/supabase/migrations/*.sql` | 4 instructions, 3 tables publiées au final (§6) |
| Vault | `grep -hoE "name = '[a-z_]+'" legacy/supabase/sql/*.sql \| sort -u` | 2 (§6) |
| RPC du front | `grep -rhoE "rpc\('[a-z_]+" apps/raijin-banc-de-test/src --include=*.ts --exclude=*.spec.ts \| sort -u` | 8 (§5) |
| Fichiers du front | `grep -rlE "inject\(SUPABASE\)\|SupabaseClient" apps/raijin-banc-de-test/src --include=*.ts --exclude=*.spec.ts` | 14 dont le client (§7) |

## Annexe A — Colonnes par table

Colonnes de création, puis colonnes ajoutées (date de migration). Générée depuis les migrations ; types et contraintes
dans `legacy/supabase/migrations/`.

**`tokens`**  
Colonnes (40) : mint, symbol, name, pair_address, dex_id, image_url, website_url, x_url, telegram_url, price_usd, market_cap, liquidity_usd, volume_24h, change_5m, change_1h, change_6h, change_24h, buys_1h, sells_1h, buys_24h, sells_24h, pair_created_at, score, flags, zone_status, zone_source, swing_low, swing_high, zone_low, zone_high, invalidation, tp1, tp2, mint_authority_disabled, freeze_authority_disabled, top10_pct, holder_count, organic_score, first_seen_at, updated_at  
Ajoutées : liquidity_jup_usd (20261116), liquidity_dex_usd (20261116), liquidity_gecko_usd (20261116), liquidity_effective_usd (20261116), liquidity_divergence (20261116), roundtrip_cost_pct (20261116), roundtrip_fee_pct (20261116), buy_impact_pct (20261116), lp_locked_pct (20261116), rugcheck_score (20261116), rugcheck_dangers (20261116), price_jup_usd (20261116), price_gecko_usd (20261116), data_confidence (20261116), quote_at (20261116), rugcheck_at (20261116), enriched_at (20261116), p_x3 (20261117), p_dd50 (20261117), rr (20261117), model_version (20261117), model_calibrated (20261117), narrative (20261117), narrative_rank (20261117), features (20261117), insiders_detected (20261117), creator_rug_history (20261117), zone_candles_at (20261117), sources (20261117), spark_6h (20261118), volume_1h (20261121)  

**`token_snapshots`**  
Colonnes (9) : id, mint, captured_at, price_usd, market_cap, liquidity_usd, volume_24h, score, zone_status  
Ajoutées : holder_count (20261117), volume_1h (20261117), txns_1h (20261117), dex_id (20261117), organic_score (20261117), source (20261117), mint_authority_disabled (20261119), freeze_authority_disabled (20261119), top10_pct (20261119), insiders_detected (20261119), roundtrip_cost_pct (20261119), change_1h (20261119), buys_1h (20261120), sells_1h (20261120), liquidity_effective_usd (20261120), lp_locked_pct (20261120)  

**`scan_runs`**  
Colonnes (6) : id, started_at, finished_at, tokens_seen, tokens_kept, error  
Ajoutées : source_counts (20261117), sol_usd (20261117), eur_usd (20261117)  

**`watchlist`**  
Colonnes (4) : user_id, mint, note, created_at  

**`push_subscriptions`**  
Colonnes (7) : id, user_id, endpoint, p256dh, auth, user_agent, created_at  

**`alert_settings`**  
Colonnes (9) : user_id, enabled, min_score, only_in_zone, hide_bonding_curve, quiet_start, quiet_end, max_per_hour, updated_at  
Ajoutées : stake_sol (20261116), min_p_x3 (20261117), max_p_dd50 (20261117), min_rr (20261117), auto_paper (20261117), early_enabled (20261118), early_min_score (20261118), paper_default_strategy (20261118), paper_sl_pct (20261118), auto_paper_parallel (20261118), alert_preset (20261119), max_per_day (20261119), young_strong_enabled (20261119)  

**`alert_log`**  
Colonnes (6) : id, user_id, mint, notification_id, kind, sent_at  
Ajoutées : entry_price (20261117), target_price (20261117), stop_price (20261117), rr (20261117), entry_score (20261117), entry_zone (20261117), entry_roundtrip_pct (20261117), stake_sol (20261117), max_price (20261117), min_price (20261117), last_price (20261117), last_price_at (20261117), first_hit (20261117), first_hit_at (20261117), followup_sent_at (20261117), tracking_until (20261117), preset (20261119)  

**`test_push_throttle`**  
Colonnes (2) : user_id, last_sent_at  

**`signal_outcomes`**  
Colonnes (26) : mint, pair_address, source, detected_at, entry_price, entry_mc, entry_liq_eff, entry_roundtrip_pct, entry_score, entry_zone, features, model_version, p_x3, p_dd50, status, hit_x2, hit_x3, hit_x5, dd50_first, max_multiple_7d, hours_to_x3, observed_hours, labelled_at, label_attempts, label_error, created_at  
Ajoutées : hit_sl30 (20261119), x2_before_sl30 (20261119), sl30_before_x2 (20261119), min_multiple_7d (20261119), hours_to_x2 (20261119), entry_dex_id (20261119), next_label_at (20261119), candles_1m_at (20261119), candles_5m_at (20261119), candles_attempts (20261119), pair_age_h (20261122)  

**`model_weights`**  
Colonnes (6) : id, version, trained_at, payload, active, created_at  

**`paper_wallets`**  
Colonnes (4) : user_id, balance_sol, created_at, reset_at  
Ajoutées : book (20261118), initial_sol (20261118)  

**`paper_orders`**  
Colonnes (21) : id, user_id, mint, symbol, side, type, stake_sol, entry_price, tp_price, sl_price, status, group_id, source, expires_at, created_at, filled_at, closed_at, fill_price, exit_price, fees_sol, pnl_sol  

**`early_candidates`**  
Colonnes (36) : mint, symbol, name, first_seen_at, last_seen_at, mc_at_detection, price_at_detection, first_eligible_at, mc, price, liquidity, holders, txns_5m, volume_5m_usd, buys_5m, sells_5m, organic_score, pro_trader_share, top10_pct, bundlers_pct, snipers_pct, dev_pct, mint_authority_disabled, freeze_authority_disabled, age_minutes, migrated_at, early_score, eligible, excluded_by, signals, sources, pair_address, dex_id, roundtrip_cost_pct, roundtrip_at, updated_at  

**`early_observations`**  
Colonnes (23) : id, mint, at, mc, price, liquidity, holders, txns_5m, volume_5m_usd, buys_5m, sells_5m, organic_score, pro_trader_share, top10_pct, bundlers_pct, snipers_pct, dev_pct, mint_authority_disabled, freeze_authority_disabled, age_minutes, migrated_at, early_score, eligible  

**`early_outcomes`**  
Colonnes (20) : mint, pair_address, detected_at, entry_price, entry_mc, entry_score, entry_age_minutes, entry_dex_id, status, hit_x2, hit_x3, hit_x5, dd50_first, max_multiple_7d, hours_to_x3, observed_hours, labelled_at, label_attempts, label_error, created_at  
Ajoutées : hit_sl30 (20261119), x2_before_sl30 (20261119), sl30_before_x2 (20261119), min_multiple_7d (20261119), hours_to_x2 (20261119), next_label_at (20261119)  

**`early_runs`**  
Colonnes (10) : id, started_at, finished_at, candidates, observed, eligible, outcomes, alerts, stats, error  

**`paper_positions`**  
Colonnes (21) : id, user_id, book, mint, symbol, strategy, stake_sol, source, alert_id, status, entry_target_price, fill_price, sl_price, custom_tp_price, sl_pct, expires_at, created_at, filled_at, closed_at, pnl_sol, fees_sol  
Ajoutées : entry_mode (20261119), cancel_reason (20261121)  

**`paper_legs`**  
Colonnes (9) : id, position_id, user_id, size_pct, tp_price, stop_price, status, exit_price, closed_at  

**`preset_signals`**  
Colonnes (29) : id, preset, mint, pair_address, detected_at, entry_price, entry_mc, entry_liq_eff, entry_zone, entry_dex_id, entry_change_1h, entry_roundtrip_pct, status, hit_x2, hit_x3, hit_x5, dd50_first, max_multiple_7d, hours_to_x3, hit_sl30, x2_before_sl30, sl30_before_x2, min_multiple_7d, hours_to_x2, observed_hours, labelled_at, label_attempts, label_error, created_at  
Ajoutées : next_label_at (20261119), narrative (20261119), pair_age_h (20261119), candles_1m_at (20261119), candles_5m_at (20261119), candles_attempts (20261119)  

**`fast_watch`**  
Colonnes (14) : mint, pair_address, preset, started_at, until, entry_price, max_multiple, min_multiple, first_x2_at, first_sl30_at, x2_before_sl30, sl30_before_x2, ticks, last_tick_at  

**`fast_ticks`**  
Colonnes (6) : id, mint, pair_address, at, price_usd, liquidity_usd  

**`ohlcv_candles`**  
Colonnes (15) : id, mint, pool, tf, ts_start, step_s, ts, o, h, l, c, v, source, detected_at, fetched_at  

**`backtest_runs`**  
Colonnes (16) : id, status, requested_by, trigger, params, data_version, n_detections, n_variants, n_distinct_variants, progress, cursor, locked_until, error, created_at, started_at, finished_at  
Ajoutées : summary (20261119)  

**`backtest_trades`**  
Colonnes (9) : run_id, source, mint, detected_at, split, preset_flags, narrative, returns, open_at_end  

**`backtest_results`**  
Colonnes (24) : run_id, preset, exit, sl_pct, breakeven, time_exit_h, delay_min, narrative, split, trades, win_rate, avg_win_pct, avg_loss_pct, avg_net_pct, avg_net_sol, profit_factor, max_drawdown_sol, worst_losing_streak, ci_low, ci_high, ci_contains_zero, open_at_end, retained, robust  
Ajoutées : exploratory (20261119)  

**`backtest_events`**  
Colonnes (18) : id, preset, mint, pool, event_at, entry_snapshot_id, price_at_event, mc, liquidity, narrative, pair_age_h, roundtrip_known, roundtrip_pct, conditions, candles_1m_at, candles_5m_at, candles_attempts, created_at  

**`backtest_event_state`**  
Colonnes (4) : key, state, locked_until, updated_at  

**`label_runs`**  
Colonnes (10) : id, at, requests, rate_limited, rows_written, labels, candles, failed, queued, ms  

**`wallet_study_state`**  
Colonnes (18) : mint, pair_address, pair_created_at, detected_at, status, cursor, pages, buyers, creator, creator_checked, pool_creator, credits_used, dropped_txs, attempts, error, started_at, updated_at, finished_at  

**`early_buyers`**  
Colonnes (8) : mint, wallet, ts, sol_amount, rank, slot, signature, created_at  

**`wallet_study_budget`**  
Colonnes (6) : id, credits_used, hard_cap, lease_until, lease_token, updated_at  
