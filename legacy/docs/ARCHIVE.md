# Données archivées

Archivage du **2026-11-21** (branche `chore/slim-down`, contrat `docs/contracts/slim-down.md`, migration
`20261121020000_slim_down.sql`). Principe : les tables et colonnes ci-dessous sont **conservées** (rien n'est supprimé,
la RLS reste activée, les politiques et privilèges sont inchangés) mais **aucun code ne les écrit plus** depuis cette date
(ni les Edge Functions, ni les scripts, ni le front) et aucune n'est plus lue par une Edge Function. Les contraintes
`NOT NULL` des colonnes qui ne sont plus écrites ont été levées ; les `CHECK` restent valides pour les lignes existantes.
Les colonnes archivées portent un commentaire SQL « ARCHIVED 2026-11-21 ».

## Tables archivées

| Table | Raison | Dernier écrivain (supprimé) | Purge |
|---|---|---|---|
| `watchlist` | Aucun écran ; le scan ne lit plus les mints suivis (`loadWatchlistMints` retiré) | front (écran déjà absent) | aucune |
| `model_weights` | Modèle ×3 supprimé (`model.ts`, `scripts/calibrate.ts`) | `scripts/calibrate.ts` | aucune |
| `early_candidates` | Radar précoce supprimé (`scan-early`, `early*.ts`, écran Radar) | `scan-early` | `raijin-purge-early` désactivé : plus purgée |
| `early_observations` | Radar précoce supprimé | `scan-early` | plus purgée |
| `early_outcomes` | Radar précoce supprimé ; `label-outcomes` ne l'étiquette plus (file vidée) | `scan-early`, `label-outcomes` | aucune |
| `early_runs` | Radar précoce supprimé | `scan-early` | plus purgée |
| `fast_watch` | « Jeune & fort » et suivi rapide supprimés (`track-fast`, `fast-track.ts`) | `scan-tokens`, `track-fast` | aucune |
| `fast_ticks` | Suivi rapide supprimé | `track-fast` | `raijin-purge-fast-ticks` désactivé : plus purgée |
| `paper_orders_v1` | Déjà gelée depuis `20261118020000` (rappel) | — | aucune |

## Colonnes archivées

| Table.colonne | Raison | Depuis le 21/11 |
|---|---|---|
| `tokens.score` | Score /100 supprimé | plus écrite, `NOT NULL` levé (valeur périmée sur les anciennes lignes) |
| `tokens.zone_status`, `zone_source` | Zones Fibonacci supprimées | plus écrites (valeurs par défaut `none` / `approx` sur les nouvelles lignes) |
| `tokens.swing_low`, `swing_high`, `zone_low`, `zone_high` | Zones Fibonacci supprimées | plus écrites |
| `tokens.invalidation`, `tp1`, `tp2`, `rr` | Plan Fibonacci (TP1 / TP2 / invalidation / R/R) supprimé | plus écrites |
| `tokens.zone_candles_at` | Bougies de zone supprimées | plus écrite |
| `tokens.liquidity_jup_usd` | Liquidité Jupiter retirée de la plomberie (liquidité effective = médiane DexScreener / GeckoTerminal) | plus écrite ; le front peut encore l'afficher en infobulle (valeur historique) |
| `tokens.p_x3`, `p_dd50`, `model_version`, `model_calibrated` | Modèle ×3 supprimé | plus écrites |
| `token_snapshots.score`, `zone_status` | Score et zones supprimés | `null` sur les nouveaux snapshots, `NOT NULL` levé |
| `alert_log.entry_score`, `entry_zone` | Score et zones supprimés | `null` sur les nouvelles alertes ; `alert_log_single_has_plan` ne les exige plus |
| `signal_outcomes.entry_score`, `entry_zone`, `model_version`, `p_x3`, `p_dd50` | Score, zones et modèle supprimés | `null` sur les nouvelles détections (`entry_score` / `entry_zone` gardent la valeur du snapshot pour les rattrapages anciens) ; `features` reste écrite (lue par le backtest), avec `score` et les indicateurs de zone à `null` |
| `preset_signals.entry_zone` | Zones supprimées | `null` sur les nouvelles lignes |
| `preset_signals` (lignes `momentum`, `strict`, `young_strong`) | Presets supprimés | plus de nouvelles lignes, plus étiquetées ni affichées |
| `alert_settings.min_score` | Score supprimé | non lue, défaut gardé |
| `alert_settings.only_in_zone` | Zones supprimées | non lue, défaut gardé |
| `alert_settings.min_rr` | R/R du plan Fibonacci supprimé (plan fixe ×2 / ×0,7) | non lue, défaut gardé |
| `alert_settings.min_p_x3`, `max_p_dd50` | Modèle ×3 supprimé | non lues, défauts gardés |
| `alert_settings.young_strong_enabled` | « Jeune & fort » supprimé | non lue, défaut gardé |
| `alert_settings.paper_default_strategy` | `all_x2` seule stratégie | non lue, défaut passé à `all_x2` |
| `alert_settings.auto_paper_parallel` | Auto-paper parallèle supprimé | non lue, défaut gardé |
| `alert_settings.early_enabled`, `early_min_score` | Radar précoce supprimé | non lues, défauts gardés |
| `alert_settings.hide_bonding_curve` | Plus lue par les alertes (« Jeune calme » exige pumpswap) | écrite par le front uniquement |
| `alert_settings.alert_preset` | Toujours active, mais une seule valeur : les lignes `momentum` / `strict` sont passées à `young_calm` | — |
| `alert_log` (lignes `kind = 'early'`, `preset = 'momentum' / 'strict' / 'young_strong'`) | Flux supprimés | historique seul |
| `paper_wallets` / `paper_positions` / `paper_legs` des books `half_x2_rest_x3`, `all_x2`, `young_all_x2`, `young_half_x2_rest_x3`, `young_thirds_x2_x3_x4` | Books archivés (plus d'ouverture : `paper_open_position_as` n'accepte que `main`, `calm_all_x2`, `frenzy_all_x2`) | les positions encore `pending` / `open` ont été annulées par la migration (`status = 'cancelled'`, `cancel_reason = 'slim_down'`, solde inchangé) |
| `paper_positions` des stratégies `half_x2_rest_x3`, `thirds_x2_x3_x4`, `custom` | `all_x2` seule stratégie | gardent leurs valeurs (CHECK inchangé), positions actives annulées comme ci-dessus |
| `backtest_events` (presets `momentum`, `young_24h`, `young_3h`, `post_migration`, `narrative_leader`, `*_explo`) | Presets du Laboratoire retirés | plus produits ni capturés (bougies) ni simulés |
| `backtest_results` / `backtest_trades` des runs antérieurs (presets `all`, `mc_300k_1m`, … , cases hors grille) | Grille réduite à 4 presets × 6 variantes | lisibles, plus produits |
| `tokens.sources` (noms `gecko_trending`, `gecko_volume`, `jup_trending_1h/6h`, `jup_organic_1h/6h`, `jup_traded_1h/6h`) | Sources retirées | encore acceptés par `tokens_sources_check`, plus produits |

## Archivage du 2026-11-22 (feat/calm-sl-test)

Migration `20261122010000_calm_sl_test.sql`, phase 2 « Test du stop sur Jeune calme ».

| Données | Raison | Depuis le 22/11 |
|---|---|---|
| `paper_wallets` / `paper_positions` / `paper_legs` des books `calm_all_x2` (« Calme ») et `frenzy_all_x2` (« Frénésie ») | Remplacés par les books de test `calm_sl30`, `calm_sl40`, `frenzy_sl30` (même recette, stop 30 / 40 / 30 %, plus de règle « une fois pour toujours ») | `paper_open_position_as`, `paper_ensure_wallet` et `paper_reset_wallet` refusent ces books ; **aucune position annulée** : celles encore `pending` / `open` (1 + 2 le 21/11) sont menées à terme par `paper-engine` (TP / stop / expiration), puis le book reste en lecture seule. L'index `paper_positions_calm_frenzy_once_idx` reste en place (historique) |
| `performance_by_preset()` (colonnes `trades`, `paper_pnl_sol`, `paper_open`) | Lit toujours `calm_all_x2` / `frenzy_all_x2` (historique) | inchangée ; la carte de comparaison des books de test lit `paper_book_comparison()` |

Rien n'est supprimé ; RLS, politiques et privilèges inchangés.

## Jobs pg_cron retirés
`raijin-early`, `raijin-purge-early`, `raijin-fast`, `raijin-purge-fast-ticks` (`supabase/sql/unschedule_slim_down.sql`).
Conséquence : les tables `early_*` et `fast_ticks` ne sont plus purgées (volume figé).

## Code supprimé (rappel)
Edge Functions `scan-early`, `track-fast` ; `_shared/early*.ts`, `fast-track.ts`, `model.ts`, `fib.ts`, `zone-stability.ts`,
`scoring.ts` (remplacé par `flags.ts` + `structure.ts`), `young-wiring.ts` (`nextTickEntries` déplacé dans
`paper-engine.ts`) ; scripts `calibrate.ts`, `replay-young-strong.ts`, `explo-events*.ts`, `event-report*.ts`,
`source-mix.ts` ; `supabase/sql/schedule_early.sql`, `schedule_fast.sql`.
