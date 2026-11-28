# Architecture

> **chore/slim-down (2026-11-21)** — phase 1 « Ménage » (`docs/contracts/slim-down.md`). Supprimés : score /100,
> zones / plan / TP / R/R Fibonacci et bougies de zone, modèle ×3, presets Momentum / Strict / « Jeune & fort », suivi
> rapide (`track-fast`), radar précoce (`scan-early`), stratégies `half_x2_rest_x3` / `thirds_x2_x3_x4` / `custom`,
> toplists Jupiter et tendance GeckoTerminal, liquidité Jupiter, watchlist, presets du Laboratoire autres que
> « Jeune calme / frénésie ». Les données correspondantes sont **archivées** (tables et colonnes gardées, plus aucune
> écriture) : liste complète dans `docs/ARCHIVE.md`. Migration : `20261121020000_slim_down.sql`.
>
> **feat/calm-sl-test (2026-11-22)** — phase 2 « Test du stop sur Jeune calme ». « Structure cassée » exclue de « Jeune
> calme » (et de son témoin « Jeune frénésie ») ; une seule alerte par token tant que la position « Calme » de l'alerte
> précédente n'est pas clôturée ; trois books de test `calm_sl30`, `calm_sl40`, `frenzy_sl30` (les books `calm_all_x2` /
> `frenzy_all_x2` sont archivés) ; `rpc('paper_book_comparison')` ; features de détection corrigées (sonde de détection) ;
> bougies 1 min des détections < 24 h en priorité absolue. Migration : `20261122010000_calm_sl_test.sql`.

## Flux de données
1. **pg_cron** appelle les Edge Functions via `pg_net`, avec l'en-tête `x-cron-secret` lu dans Supabase Vault :
   - `scan-tokens` aux minutes paires (`*/2 * * * *`, ~20–30 s typique, **≤ 45 s** au pire, voir « Budget de temps et chevauchement ») ;
   - `enrich-tokens` aux minutes impaires (`1-59/2 * * * *`, ≤ 45 s), 1 minute après chaque scan ;
   - `label-outcomes` aux minutes impaires (`1-59/2 * * * *`, ≤ 50 s) : ≤ 5 requêtes GeckoTerminal par appel, arrêt au premier 429 (voir « Détections et étiquetage ») ;
   - `paper-engine` aux minutes impaires (`1-59/2 * * * *`, ≤ 45 s) : exécution **simulée** des positions paper (voir « Paper trading ») ;
   - `backtest-run` chaque minute (`* * * * *`) et la mise en file nocturne (`40 3 * * *`) : Laboratoire (voir « Laboratoire »).
   - Purges nocturnes : snapshots (30 j), `scan_runs` (7 j), bougies (30 j), Laboratoire. Jobs supprimés par `supabase/sql/unschedule_slim_down.sql` : `raijin-early`, `raijin-purge-early`, `raijin-fast`, `raijin-purge-fast-ticks`.
2. `scan-tokens` :
   - collecte les mints candidats (voir « Sources de candidats ») : DexScreener (4 listes + mots-clés `SCAN_KEYWORDS`), GeckoTerminal (pools jeunes : tendance 1 h, PumpSwap, nouveaux pools), Jupiter `recent`, veille des jeunes tokens déjà gardés (`young_watch`) ; chaque source échoue seule ;
   - fusionne par mint (`mergeSources`), plafonne à 450 mints (`prioritizeMints`) et ajoute les tokens pump.fun persistés (`dex_id = 'pumpfun'`, < 24 h, ≤ 60) pour détecter leur **migration** ;
   - charge les paires DexScreener par lots de 30 (3 en parallèle), garde la plus liquide par token, ajoute la source `migration` ; filtres `MIN_MARKET_CAP` (50 000) et `MIN_LIQUIDITY` (10 000) inchangés ; puis le **quota d'âge** (classement = volume 1 h décroissant, puis liquidité : `rankByActivity`, `_shared/final-score.ts`) ;
   - relit l'enrichissement persisté par `enrich-tokens` (valeurs trop anciennes ignorées) ;
   - audits Jupiter (mint / freeze authority, top 10, holders, organic score, prix `usdPrice`, `stats1h` / `stats6h.holderChange`) pour les **40 premiers** : jeunes tokens d'abord, puis volume 1 h (`rankYoungFirst`) ; un token déjà renvoyé par Jupiter `recent` dans ce scan réutilise cet enregistrement ;
   - **sonde de détection** (feat/calm-sl-test, `_shared/detection-probe.ts`) des premières détections dont la paire a < 24 h (≈ 0,2 par scan) : résumé RugCheck → `lpLockedPct` (≤ 4, en parallèle des audits, `api.rugcheck.xyz`) et aller-retour Jupiter 0,1 SOL → `roundtripCostPct` (≤ 2, 2 appels chacun, **après** les audits sur le même rythmeur, plus d'achat après 30 s, plus de revente après 34 s). Valeurs écrites seulement là où elles sont inconnues (jamais par-dessus `enrich-tokens`) et lues par les drapeaux, les règles des presets, les colonnes « au moment du scan » des snapshots et les features de détection ; `tokens` n'en reçoit rien (colonnes d'enrichissement toujours à `enrich-tokens`) ;
   - calcule les **drapeaux** et le consensus (`finalFlags`, point d'entrée unique, voir « Drapeaux ») ;
   - calcule les features de la première détection, le narratif, `spark_6h` (rpc `x3_snapshot_history`, une seule requête) ;
   - upsert `tokens` (jamais les colonnes d'enrichissement ni les colonnes archivées), un `token_snapshots` par token (colonnes « au moment du scan »), première détection dans `signal_outcomes`, correspondances `young_calm` / `young_frenzy` dans `preset_signals` ;
   - alertes Web Push « Jeune calme » (voir « Notifications push »), **puis** auto-paper des books de test `calm_sl30` / `calm_sl40` / `frenzy_sl30`, suivi des alertes et prix forcés des positions paper ; aucune de ces étapes n'échoue le scan ;
   - logue le run dans `scan_runs` (`tokens_seen`, `tokens_kept`, `source_counts`, `sol_usd`, `eur_usd`) ; répond `{ seen, kept, sources: { candidates, fetched, watched, youngWatch, young: { candidates, passing, kept, oldCap, oldDropped }, migrated, excluded, failed, skipped, rateLimited, counts }, detections: { features, outcomes, computeMs }, tracking, timings: { collectMs, pairsMs, pushMs, trackingMs }, ms }`.
3. `enrich-tokens` met à jour par `UPDATE` l'enrichissement et les drapeaux des tokens frais. Aucune notification.
4. `label-outcomes` crée les lignes `signal_outcomes` manquantes (rattrapage), étiquette les détections (`signal_outcomes`, `preset_signals` `young_calm` / `young_frenzy`) et capture les bougies du Laboratoire.
5. Le front lit `tokens` (RLS : authentifiés), triés par âge (`pair_created_at` décroissant, index `tokens_pair_created_at_idx`), et s'abonne à Realtime.

## Sources de candidats (`scan-tokens`)
Code : `_shared/source-clients.ts` (requêtes, parseurs zod, rythme, migrations) et `_shared/sources.ts` (fusion, compteurs, priorités, quota d'âge). Tests : `source_clients_test.ts` (réponses réelles, `test-support/source-fixtures.ts`), `sources_test.ts`. Toutes les requêtes passent par `getJson()` avec `SOURCE_HOSTS` (https, pas de redirection, timeout 8 s, corps ≤ 2 Mo, `null` en cas d'échec).

| Source (`tokens.sources`) | Endpoint | Appels / scan | Extraction |
|---|---|---|---|
| `dex_profiles`, `dex_boosts_latest`, `dex_boosts_top`, `dex_cto` | DexScreener `/token-profiles/latest/v1`, `/token-boosts/latest/v1`, `/token-boosts/top/v1`, `/community-takeovers/latest/v1` | 4 en parallèle | `tokenAddress` des entrées `chainId = solana` |
| `dex_search` | DexScreener `/latest/dex/search?q=…` (`SCAN_KEYWORDS`, ≤ 10) | 0–10 | paires utilisées telles quelles |
| `gecko_trending_1h` | GeckoTerminal `/networks/solana/trending_pools?duration=1h&page=1..2` | ≤ 2, à chaque scan | mint de base des pools créés il y a **< 24 h** (`parseGeckoYoungPools`) |
| `gecko_pumpswap` | GeckoTerminal `/networks/solana/dexes/pumpswap/pools?sort=h24_tx_count_desc&page=1` | 1, à chaque scan | idem |
| `gecko_new_pools` | GeckoTerminal `/networks/solana/new_pools?page=1` (`GECKO_NEW_POOLS_PAGES` = 1) | 1, à chaque scan | idem (pools de quelques minutes) |
| `jup_recent` | Jupiter `/tokens/v2/recent` (`lite-api.jup.ag`, ou `JUP_API_BASE`) | 1 | `id` des 30 derniers tokens (premier pool < 24 h ; date inconnue acceptée), enregistrements réutilisés comme audits (`parseJupRecent`) |
| `young_watch` | aucun appel (lecture `tokens`) | 0 | tokens dont la paire a < 24 h, gardés il y a < 10 min, volume 1 h décroissant puis liquidité, ≤ 100 |
| `migration` | aucun appel | 0 | token persisté `pumpfun` passé sur PumpSwap/Raydium, ou paire PumpSwap/Raydium < 2 h d'un token pump.fun |

Retirées (noms gardés dans `tokens_sources_check` pour l'historique) : `gecko_trending`, `gecko_volume`, `jup_trending_1h/6h`, `jup_organic_1h/6h`, `jup_traded_1h/6h`.

Pagination GeckoTerminal : page suivante seulement après une page pleine (20 pools) qui contenait encore des pools < 24 h (`hasNextYoungPage`), dans la limite de pages de chaque liste ; ≤ `GECKO_SOURCE_CALLS_MAX` = 4 appels par scan, espacés de 2,2 s.

Filtres : SOL / USDC / USDT jamais candidats. L'**exclusion des non-memecoins** par étiquette Jupiter (`stable`, `lst`, `original-lst`, `stocks`, `xstocks`, `equities`, `prestocks`, `pre-ipo`, `rwa`, `major`, `defi`) est conservée sur `jup_recent` et appliquée à toutes les sources non DexScreener ; mais ces étiquettes n'étaient portées que par les toplists supprimées : `recent` ne renvoie que `unknown` / `token-2022` (mesuré le 21/11/2026), l'exclusion n'exclut donc plus rien en pratique (limite signalée).

Limites et rythme :
- **Jupiter lite-api** : 5 requêtes / 10 s, un seul rythmeur (2,1 s) pour l'appel marché (SOL + EURC), `recent` et les audits.
- **GeckoTerminal** (~30/min, partagé avec `enrich-tokens` (1 appel / run) et `label-outcomes` (≤ 5 / appel)) : ≤ 4 appels de sources par scan, **plus aucune bougie de zone**.
- **429** : le premier 429 d'un groupe arrête les requêtes restantes de ce groupe pour ce scan (`rateLimited`, sources listées dans `skipped`).
- **DexScreener** `/tokens/v1` (300/min) : ≤ 15 lots + suivi.

`scan_runs.source_counts` : par source `{ seen, kept, unique, uniqueKept, young, youngKept }` = mints amenés, gardés (filtres **et** quota d'âge), amenés par cette source seule, et parmi eux ceux dont la paire a < 24 h : c'est la mesure du rendement réel de `gecko_new_pools` et `jup_recent`. Requête de suivi : `select started_at, source_counts->'gecko_new_pools', source_counts->'jup_recent' from scan_runs order by id desc limit 30;`.

Appels GeckoTerminal par heure (30 scans / h) — avant → après : bougies de zone ≤ 300 → 0 ; tendance 24 h (3 pages, 1 scan sur 3) 30 → 0 ; pools jeunes (≤ 3, 2 scans sur 3) ≤ 60 → (≤ 4, chaque scan) ≤ 120 ; radar `scan-early` ≤ 20 → 0 ; total scan + radar **≤ 410 → ≤ 120 / h** (≈ −290). Inchangés : `enrich-tokens` ≤ 30, `label-outcomes` ≤ 150 (premier bénéficiaire du quota libéré).

### Jeunes tokens et quota d'âge
Objectif : **≥ 40 % des tokens gardés ont une paire de moins de 24 h** (8 % le 21/11 au matin, 36 % après fix/young-sources). Quota (`applyAgeQuota` / `oldKeptCap`, `_shared/sources.ts`) : tous les tokens < 24 h et les mints suivis (positions d'alerte, positions paper) sont gardés ; les tokens ≥ 24 h (ou d'âge inconnu) gardent `⌊jeunes × 1,5⌋` places bornées à **[25, 90]**, les plus actifs d'abord (volume 1 h, puis liquidité). La suppression des toplists Jupiter (≈ 83 % de tokens > 7 jours) réduit d'abord le nombre d'anciens candidats.

### Budget de temps et chevauchement (`_shared/scan-budget.ts`)
Un `ScanBudget` par scan (horloge injectable, testé dans `scan_budget_test.ts`) ; jalons depuis le début du scan :

| Jalon | Effet |
|---|---|
| 18 s (`collectStopMs`) | plus de nouvelle requête de source (DexScreener, GeckoTerminal pools jeunes, Jupiter `recent` ; y compris après une attente du rythmeur) |
| 22 s (`collectAbortMs`) | requêtes de sources en cours annulées (`collectSignal`, aussi l'appel marché SOL/EURC) |
| 28 s (`pairsStopMs`) | plus de nouveau lot DexScreener `/tokens/v1` |
| 30 s (`auditsStopMs`) | plus de nouvel audit Jupiter |
| 34 s (`trackingStopMs`) | plus de nouveau prix de suivi DexScreener (mints suivis hors du lot gardé) |
| 38 s (`abortMs`) | **toutes** les requêtes externes du scan annulées (`signal`, combiné au timeout de 8 s de chaque requête) |
| 40 s / 43 s (`pushStopMs` / `pushAbortMs`) | plus de nouvel envoi Web Push (alertes et relances) / envois en cours terminés (timeout réduit) |

Ce qui est déjà calculé est écrit ensuite (upsert, snapshots, `scan_runs`) : pire cas ≈ 43 s + ~2 s d'écritures ≈ **45 s**, sous le timeout de 55 s de `pg_net` (les requêtes Postgres n'ont pas de timeout propre ici).

**Garde anti-chevauchement** : chaque scan insère sa ligne `scan_runs` puis lit les lignes non terminées (`finished_at is null`) d'`id` **inférieur** démarrées il y a moins de 90 s (`isOverlapping`). S'il y en a une, il marque sa ligne `error = 'skipped: overlap'` et répond `200 { skipped: 'overlap' }` sans rien faire. De deux scans simultanés, celui qui a le plus petit `id` (identité Postgres) continue, l'autre s'arrête : jamais les deux (sinon les deux passeraient la déduplication `alert_log` avant que l'un n'écrive → alertes en double). Une ligne laissée ouverte par un scan planté ne bloque plus après 90 s. Si la lecture échoue, le scan continue comme avant. Pas de RPC ni de verrou : l'ordre des `id` suffit.


## Enrichissement (`enrich-tokens`)
Edge Function séparée pour ne pas allonger `scan-tokens`. Logique pure et clients dans `_shared/enrich-clients.ts` et `_shared/enrich-schemas.ts` (zod), correspondance lignes ↔ métriques dans `_shared/normalize.ts` (`rowToMetrics`, `enrichmentFromRow`, `buildEnrichmentUpdate`, `toTokenRow`). Tests : `enrich_test.ts` (réponses réelles enregistrées le 16/11/2026), `normalize_enrich_test.ts`.

1. Lit (service_role) les 100 tokens les plus actifs (volume 1 h, puis liquidité) mis à jour depuis moins de 10 min et garde les 30 premiers en mettant **les jeunes tokens (< 24 h) d'abord** (`rankYoungFirst` : « Jeune calme » a besoin de l'aller-retour, de RugCheck et de la liquidité GeckoTerminal).
2. En parallèle, trois hôtes différents, chacun avec sa limite :

| Source | Appels par run | Limite et réglage | Colonnes |
|---|---|---|---|
| GeckoTerminal `GET /api/v2/networks/solana/pools/multi/{30 paires}` | **1** | ~30/min partagé avec les sources du scan et `label-outcomes` : un seul appel | `liquidity_gecko_usd` (`reserve_in_usd`), `price_gecko_usd` (`base_token_price_usd` ou `quote_token_price_usd` selon le côté où se trouve le mint) |
| RugCheck `GET /v1/tokens/{mint}/report/summary` puis `GET /v1/tokens/{mint}/report` | ≤ 2 × 30 (le rapport complet seulement si le résumé a répondu), seulement si `rugcheck_at` est nul ou > 30 min (**cache**) | en-tête `x-rate-limit-limit: 15` sur une fenêtre d'environ 1 s : 3 tâches en parallèle (2 appels séquentiels chacune), 300 ms de pause | résumé : `lp_locked_pct` (`lpLockedPct`), `rugcheck_score` (`score` brut, non borné, plus haut = plus risqué), `rugcheck_dangers` (noms des risques `level = danger`, nettoyés, ≤ 5, ≤ 40 caractères), `creator_rug_history` (risque « Creator history of rugged tokens », tout niveau), `rugcheck_at` ; rapport complet : `insiders_detected` (`graphInsidersDetected > 0`) |
| Jupiter `GET lite-api.jup.ag/swap/v1/quote` (sans clé) | 2 × 15 (aller puis retour) | 2 allers-retours en parallèle, 300 ms de pause | `roundtrip_cost_pct`, `roundtrip_fee_pct`, `buy_impact_pct`, `quote_at` |

3. Aller-retour : achat de 0,1 SOL (100 000 000 lamports) SOL → token, puis revente de **exactement** le `outAmount` reçu token → SOL (calcul en BigInt). `roundtrip_cost_pct = (1 − SOL récupérés / 0,1) × 100`. `priceImpactPct` de Jupiter est une **fraction** (vérifié : 0,001 / 0,1 / 10 SOL, et achat 0,69 % + revente 1,02 % ≈ coût 1,76 %), donc × 100. `roundtrip_fee_pct = max(0, coût − impact achat − impact revente)` : **approximation** de la part qui ne dépend pas de la taille (frais de route des deux jambes). Si une jambe échoue → tout à `null` (inconnu), `quote_at = null`.
4. Pour chaque token : `rowToMetrics(ligne)` + résultats frais → `finalFlags` → `UPDATE` de **seulement** : colonnes d'enrichissement, `flags`, `liquidity_effective_usd`, `liquidity_divergence`, `data_confidence`, `enriched_at` (plus de score : chore/slim-down). Une source non interrogée ce run (cache RugCheck frais, hors top 15, échéance dépassée) n'est pas écrite ; une RugCheck en échec garde l'ancienne valeur (réessayée au run suivant) ; GeckoTerminal en échec écrit `null`.
5. Budget de temps (`createRunBudget`, `ENRICH_BUDGET` dans `_shared/enrich-clients.ts`) : aucune nouvelle tâche (RugCheck, aller-retour) après **30 s** ; la jambe de revente d'un aller-retour n'est plus lancée après **34 s** (l'aller-retour est alors « non coté ce run », colonnes intactes) ; à **40 s** un `AbortController` annule toutes les requêtes en cours (signal combiné au timeout de 8 s). Ce qui est terminé est quand même écrit. Pire cas ≈ 40 s + ~1 s d'`UPDATE`, sous le timeout de 55 s de `pg_net`. Réponse `{ tokens, gecko, rugcheck, quotes, ms }`.

RugCheck insiders (vérifié le 17/11/2026 sur 25 tokens frais) : le **résumé** n'a aucun champ insiders (clés : `tokenProgram`, `tokenType`, `risks`, `score`, `score_normalised`, `lpLockedPct`) et aucun risque nommé « insider » n'est apparu ; le **rapport complet** (9–95 Ko) expose `graphInsidersDetected` (entier : 0, 4, 5, 25, 40 vus) et `insiderNetworks`. Son `score` et ses `risks` sont identiques au résumé, mais il n'a pas de `lpLockedPct` global : on garde donc le résumé et on ajoute le rapport. Un rapport en échec laisse `insiders_detected` inchangé (dernière valeur connue) ; un risque explicite « insider » dans le résumé suffit à mettre `true`. Mesuré en local le 17/11/2026 : 22 tokens, résumé + rapport, run complet 3,8 s.

Durée attendue : GeckoTerminal ~1 s ; Jupiter 15 allers-retours à 2 en parallèle ≈ 8 vagues × (2 × ~0,3–0,6 s + 0,3 s) ≈ 8–12 s ; RugCheck ≤ 30 à 3 en parallèle ≈ 10 vagues × (~0,3 s + 0,3 s) ≈ 6 s, et presque rien quand le cache est chaud ; 30 `UPDATE` à 6 en parallèle ≈ 1 s. Total typique **5–15 s** (mesuré le 16/11/2026 sur 26 tokens réels : GeckoTerminal 0,8 s, 15 allers-retours 3,0 s, 26 RugCheck 4,4 s, aucun échec), pire cas borné à ~40 s par l'annulation globale.

**Limite connue des impacts Jupiter** : `priceImpactPct` est mesuré contre le prix de référence de Jupiter, pas contre le prix du pool. Il inclut donc déjà une partie des frais et peut être asymétrique (cas réel : achat 8,69 %, revente 0 %, coût réel 3,16 %). En pratique `roundtrip_fee_pct` vaut souvent 0 et `buy_impact_pct` est indicatif. **La valeur fiable est `roundtrip_cost_pct`** (SOL réellement récupérés).

**Fraîcheur relue par les drapeaux** (`ENRICHMENT_MAX_AGE_MS`, `enrichmentFromRow`) : GeckoTerminal ≤ 10 min (daté par `enriched_at`), aller-retour ≤ 20 min (`quote_at`), RugCheck ≤ 6 h (`rugcheck_at`). Au-delà, la valeur est traitée comme inconnue.

**Propriété des colonnes** : `scan-tokens` écrit les colonnes DexScreener / Jupiter (dont `price_jup_usd`, `volume_1h`), `sources`, `narrative`, `narrative_rank`, `features`, `spark_6h` ; `enrich-tokens` écrit `ENRICHMENT_OWNED_COLUMNS`, dont `insiders_detected` et `creator_rug_history` ; les deux réécrivent `flags`, `liquidity_effective_usd`, `liquidity_divergence`, `data_confidence`, **toujours** avec la sortie de `finalFlags` (point d'entrée unique, `_shared/final-score.ts`). `liquidity_dex_usd` est une colonne générée. Colonnes archivées (plus écrites) : `docs/ARCHIVE.md`.

## Tables
| Table | Rôle | Écriture |
|---|---|---|
| `tokens` | Dernier état de chaque token gardé (DexScreener, audit Jupiter, enrichissement, `flags`, consensus, `volume_1h`, `sources`, narratif, `features`, `spark_6h`). Colonnes archivées : voir `docs/ARCHIVE.md` | service_role |
| `token_snapshots` | Historique par scan (`source = 'scan'`) ou par suivi (`tracking`) : prix, MC, liquidité, volume, features (`holder_count`, `volume_1h`, `txns_1h`, `dex_id`, `organic_score`) et valeurs « au moment du scan » (autorités, top 10, insiders, aller-retour, `change_1h`, `buys_1h` / `sells_1h`, liquidité effective, LP). `score` / `zone_status` archivés (null). Purgé après 30 jours | service_role |
| `scan_runs` | Journal des scans (`source_counts`, `sol_usd`, `eur_usd`, erreur), purgé après 7 jours | service_role |
| `push_subscriptions` | Abonnements Web Push par appareil, 10 max | propriétaire (RLS) |
| `alert_settings` | Préférences : `enabled`, `alert_preset` (= `young_calm`), heures calmes, `max_per_hour`, `max_per_day`, `stake_sol`, `auto_paper` (pilote les books Calme / Frénésie), `paper_sl_pct`, `hide_bonding_curve` (écrit par le front). Colonnes archivées (non lues, valeur par défaut gardée) : voir `docs/ARCHIVE.md` | propriétaire (RLS) |
| `alert_log` | Alertes envoyées ; une alerte individuelle est une position suivie 7 jours (`entry_price`, `target_price` = ×2, `stop_price` = ×0,7, `rr`, `stake_sol`, max / min / dernier prix, `first_hit`, relance). `preset` = `young_calm` | service_role ; lecture : propriétaire |
| `test_push_throttle` | Rate limit de la notification de test | service_role (`claim_test_push`) |
| `signal_outcomes` | Première détection de chaque token (prix d'entrée, `features` lues par le backtest, `pair_age_h` généré depuis `features.log_age_h`) et son étiquette OHLCV | service_role ; lecture : authentifiés |
| `preset_signals` | Première correspondance par mint de `young_calm` / `young_frenzy` (+ historique archivé des anciens presets) et son étiquette | service_role ; lecture : authentifiés |
| `paper_wallets`, `paper_positions`, `paper_legs` | Paper trading (simulation) : books `main`, `calm_sl30`, `calm_sl40`, `frenzy_sl30`, stratégie `all_x2`. Books / stratégies archivés : historique seul (`cancel_reason = 'slim_down'` pour les positions annulées par la migration slim-down ; `calm_all_x2` / `frenzy_all_x2` : positions en cours menées à terme, aucune nouvelle) | RPC / `paper-engine` ; lecture : propriétaire |
| `ohlcv_candles`, `backtest_runs`, `backtest_trades`, `backtest_results`, `backtest_events`, `backtest_event_state`, `label_runs` | Laboratoire et étiquetage | service_role ; lecture : authentifiés (sauf `backtest_event_state`) |
| `watchlist`, `model_weights`, `early_*`, `fast_watch`, `fast_ticks`, `paper_orders_v1` | **Archivées** (`docs/ARCHIVE.md`) | plus aucune écriture |

## Drapeaux (sans score) — `_shared/flags.ts`, `_shared/final-score.ts`
Le score /100 n'existe plus. `tokenFlags(metrics)` (appelé seulement via `finalFlags`, par `scan-tokens` et `enrich-tokens`) renvoie les **drapeaux** (au plus 12, les plus importants d'abord) et le consensus des sources ; rien n'est pondéré ni classé. Ordre des drapeaux :

1. « Données incohérentes » (divergence de liquidité > 0,5) ;
2. **« Structure cassée »** : prix sous le niveau 0,786 du swing approximé par les variations 5 min / 1 h / 6 h / 24 h (`structureBroken`, `_shared/structure.ts`, impulsion ≥ 15 %, sans bougies : même définition que l'ancien statut `broken`). Règle de sécurité de « Jeune calme » et de « Jeune frénésie » depuis feat/calm-sl-test (`structure_broken` des lignes d'alerte du scan, même fonction que le drapeau) ;
3. « RugCheck : <nom> » (≤ 2, re-nettoyés) ; « LP peu verrouillée » (LP connue < 50 %) ;
4. « Coût d'aller-retour élevé (> 5 %) » / « (> 10 %) » ;
5. « Bonding curve » (`dex_id = 'pumpfun'`) ; « Chute −X % en 1 h » (< −25 %) ; « Chute −X % en 24 h » (< −50 %) ;
6. taille : « Liquidité très faible (< 10 k$) » / « faible (< 20 k$) » / « limitée (< 50 k$) » (exclusifs), « Petite capitalisation (< 100 k$) », « Liquidité faible vs MC » (< 5 %) ;
7. « Ventes > achats (1 h) », « Déjà +X % en 24 h (sur-extension) » (> 300 %), « Frénésie : +X % en 1 h » (paire < 24 h et > +150 %), « Prix divergent entre sources », « Moins d'1 h », « Aucun réseau social ».

Ordre des listes (remplace le score) : scan (quota d'âge, audits, historique, veille jeune) = volume 1 h décroissant puis liquidité (`rankByActivity`, les audits avec les jeunes d'abord : `rankYoungFirst`) ; candidats d'alerte « Jeune calme » = volume 1 h ; liste Opportunités (front) = âge croissant.

### Liquidité effective et recoupement des sources
- **Liquidité effective** = médiane des valeurs valides de DexScreener (meilleure paire) et GeckoTerminal (`reserve_in_usd`) : 2 valeurs → leur moyenne, 1 → celle-ci, aucune → 0 (`effectiveLiquidity`, `_shared/consensus.ts`). Jupiter n'en fait pas partie et sa liquidité n'est plus du tout dans la plomberie (`tokens.liquidity_jup_usd` archivée) ; le front ne l'affiche qu'en infobulle (valeur historique).
- **Divergence** = (max − min) / min entre DexScreener et GeckoTerminal, en fraction ; `null` si l'une manque. **> 0,5** → « Données incohérentes ».
- **Consensus de prix** = médiane des prix valides (DexScreener, Jupiter `usdPrice`, GeckoTerminal) ; écart > 5 % → « Prix divergent entre sources ».
- **Coût d'aller-retour** (0,1 SOL → token → SOL via les cotations Jupiter, `enrich-tokens`) : > 5 % puis > 10 % → drapeau ; inconnu → pas de drapeau (la confiance ne peut pas être « haute »). Utilisé aussi par la sécurité de « Jeune calme » (< 5 %).

### Confiance dans les données (`data_confidence`)
`dataConfidence({ liquiditySources, divergence, priceDivergent, roundtripKnown })`, avec `liquiditySources` (0–2) et `divergence` calculés sur DexScreener + GeckoTerminal uniquement :

| Niveau | Condition |
|---|---|
| `low` | DexScreener ou GeckoTerminal manquant, **ou** divergence > 0,5, **ou** prix divergent avec une divergence de liquidité > 0,2 |
| `high` | DexScreener et GeckoTerminal connus, divergence ≤ 0,2 (`DIVERGENCE_AGREE`), prix cohérents **et** coût d'aller-retour connu |
| `medium` | tout le reste (ex. sources cohérentes mais aller-retour inconnu, divergence entre 0,2 et 0,5, prix seuls divergents) |

Justification : 20 % est l'ordre de grandeur des écarts « normaux » entre agrégateurs ; une seule source ne peut pas être recoupée, d'où `low` (honnête : c'est le cas de tous les tokens non enrichis, Jupiter ne comptant pas comme seconde source). Information affichée à côté des drapeaux.


## Détections et étiquetage
- **Première détection** (`scan-tokens`) : un token absent de `tokens` avant le scan reçoit une ligne `signal_outcomes` (prix d'entrée DexScreener, liquidité effective, MC, dex, `features` de `buildFeatureVector` ; `features.score` et les indicateurs de zone valent `null` depuis chore/slim-down, les clés restent). `entry_score` / `entry_zone` : `null`. Depuis feat/calm-sl-test, les features de première vue ne sont plus vides (cause et correctif : `docs/MODEL.md` « Features vides à la détection ») : croissance des holders depuis l'audit Jupiter, `migrated_recently` déduit du dex / mint / âge, aller-retour et LP de la sonde de détection.
- **Narratif** (`narrativeRanks`, `features.ts`) → `tokens.narrative` (segments GTA du front et de Performance) ; **`spark_6h`** depuis l'historique `x3_snapshot_history` (une rpc, 15 min) ; **contexte de marché** (`sol_usd`, `eur_usd`, variation SOL 24 h) depuis une requête Jupiter.
- **`label-outcomes`** (minutes impaires) : rattrapage des `signal_outcomes` manquants (≤ 200 toutes les 10 min) ; file unique (`mergeWorkQueue`, `_shared/candle-queue.ts`) : 1 bougies 1 min des détections dont la paire avait **< 24 h** à la détection (priorité absolue, lecture dédiée filtrée sur `pair_age_h < 24` de `signal_outcomes` / `preset_signals`, feat/calm-sl-test), 2 autres bougies 1 min des détections (paire < 48 h ou âge inconnu), 3 bougies 1 min des événements `young_calm_ev` / `young_frenzy_ev`, 4 étiquettes `preset_signals` (`young_calm` / `young_frenzy`), 5 étiquettes `signal_outcomes`, 6 bougies 5 min. La file du radar (`early_outcomes`) et les lignes des presets archivés (`preset_signals` momentum / strict / young_strong, événements des anciens presets du Laboratoire) ne sont plus traitées. ≤ 5 requêtes GeckoTerminal espacées de 8 s, arrêt au premier 429, une ligne `label_runs` par appel. Jauge : `rpc('backfill_progress')` (5 catégories dans cet ordre).

## Paper trading — simulation uniquement
Aucune connexion de wallet, aucune clé, aucune signature, aucune transaction : le « solde » est un nombre en base.

- **Books** (`paper_wallets`, clé `(user_id, book)`) : `main` (positions manuelles) et les trois books de test de feat/calm-sl-test : `calm_sl30` (« Calme · stop 30 % »), `calm_sl40` (« Calme · stop 40 % »), `frenzy_sl30` (« Frénésie · stop 30 % », témoin, jamais alerté) ; 1,0 SOL chacun (créés par la migration pour les utilisateurs `auto_paper`, sinon à la première position). `calm_all_x2` / `frenzy_all_x2` sont archivés (plus d'ouverture, historique gardé, positions en cours menées à terme par `paper-engine`). Les books `half_x2_rest_x3`, `all_x2`, `young_*` sont archivés depuis chore/slim-down.
- **Stratégie** : `all_x2` seulement (1 jambe de 100 %, TP ×2, SL −`sl_pct`, recalculés sur le prix d'exécution). `half_x2_rest_x3`, `thirds_x2_x3_x4` et `custom` sont refusées par `paper_open_position_as` (historique conservé, CHECK inchangé).
- **Ouverture manuelle** : `rpc('paper_open_position', { p_mint, p_strategy: 'all_x2', p_stake, p_entry, p_sl_pct = 30, p_custom_tp = null, p_custom_sl = null, p_book = 'main' })` (signature inchangée). Annulation `paper_cancel_position`, remise à zéro `paper_reset_wallet(p_book)`, `paper_ensure_wallet(p_book)` (books `main`, `calm_sl30`, `calm_sl40`, `frenzy_sl30`).
- **Auto-paper des books de test** (`autoPaperCalmFrenzy`, à chaque scan, **après** les alertes, indépendant d'elles : ni plafonds, ni heures calmes, ni persistance) : pour chaque token `young_calm` / `young_frenzy` (≤ 10 par preset, ordre du volume 1 h) et chaque utilisateur `auto_paper = true` (≤ 25), une position `all_x2` de **0,1 SOL**, entrée **au marché** au premier snapshot du scan suivant (`entry_mode = 'next_tick'`, `nextTickEntries` ; jamais un ordre limite sous le prix) dans **chaque** book du preset : `young_calm` → `calm_sl30` (stop 30 %) **et** `calm_sl40` (stop 40 %) ; `young_frenzy` → `frenzy_sl30` (stop 30 %). Stop exécuté au prix observé (logique de glissement existante), frais réseau et rente comme avant. Pas de nouvelle position dans un book tant qu'une position du même token y est `pending` / `open` ; 12 h de délai après un stop sur le mint **dans ce book** (un stop de `calm_sl30` ne bloque pas `calm_sl40`, sinon la comparaison des stops serait biaisée ; le book `main` garde le délai tous books confondus). Plafonds communs 50 actives / 200 par 24 h.
- **Recette fixe par book** (vérifiée par `paper_open_position_as`, toutes les autres vérifications conservées) : `all_x2` + `auto_alert` + `next_tick` + mise 0,1 SOL + stop 30 % (`calm_sl30`, `frenzy_sl30`) ou 40 % (`calm_sl40`) ; index unique partiel = au plus une position `pending` / `open` par (utilisateur, book, mint) dans ces books.
- **Carte de comparaison** : `rpc('paper_book_comparison')` (security invoker, RLS de l'appelant, `authenticated` seul, sans argument) → 3 lignes dans l'ordre `calm_sl30`, `calm_sl40`, `frenzy_sl30` : `{ book, trades, tp_hits, sl_hits, tp_pct, sl_pct, pnl_sol, max_drawdown_sol, max_drawdown_pct, worst_losing_streak, open_positions, target_trades, balance_sol, initial_sol, since }` — `trades` = positions clôturées depuis la dernière remise à zéro du book (`since` = `reset_at`, `null` si jamais), `tp_pct` / `sl_pct` en % des trades (`null` sans trade), drawdown max depuis le pic de la courbe de P&L réalisé (ordre `closed_at`, `id` ; en SOL et en % de l'équité au pic `initial + pic`), `worst_losing_streak` = plus longue suite de trades clôturés à P&L < 0, `open_positions` = `pending` + `open`, `target_trades` = 50, `balance_sol` `null` si le portefeuille n'existe pas encore.

### `paper-engine` (cron `1-59/2 * * * *`, job `raijin-paper` inchangé)
`verify_jwt = false`, `x-cron-secret` comparé en temps constant (401 sinon), POST uniquement (405), client service_role, ne lève jamais d'exception (réponse JSON même en cas d'erreur, logs sans secret).
1. Charge les positions `pending` / `open` avec leurs jambes (`paper_legs` embarquées, ≤ 1000, les plus anciennes d'abord), validées position par position (`parseEnginePositions` : une jambe invalide écarte toute la position), puis **ordre équitable** entre utilisateurs (`fairOrder` : tour à tour, chaque utilisateur dans l'ordre d'ancienneté), ≤ 500 traitées par run.
2. Dernier prix par mint dans `token_snapshots` (`scan` ou `tracking`), capturé il y a **moins de 6 min** (`buildTicks`) ; sinon pas de tick et seule l'expiration peut se produire.
3. Cotations (`quoteCandidates`) : `step()` avec l'impact par défaut décide qui s'exécute ou quelles jambes se clôturent (ça ne dépend que du prix). Achat : 1 cotation SOL → token pour **la mise entière** (une entrée pour toutes les jambes). Sortie : SOL → token pour la **valeur des jambes qui se clôturent ensemble** (Σ mise × taille/100 × prix / entrée, `sellLamports`) puis token → SOL pour exactement les tokens obtenus ; l'impact de la 2e jambe sert d'impact de vente. Sorties avant entrées ; même mint + même montant = une cotation.
4. Cotations via `getJson()` (hôtes Jupiter seulement), une toutes les 2,1 s **à partir de t = 10 s**, ≤ 10 appels, aucune après 34 s, annulation à 38 s, arrêt au premier 429. Non coté → `step()` applique +2 %.
5. `step(position, tick, maintenant)` → `applyArgsV2` → `rpc('paper_apply_v2', { p_position, p_expected, p_step, p_delta })` (4 en parallèle, aucune lancée après 44 s). `p_step` = `{ kind: 'fill', fill_price, fees_sol, legs: [{ id, tp_price, stop_price }] }`, `{ kind: 'expire' }` ou `{ kind: 'legs', closes: [{ id, status, exit_price }], moves: [{ id, stop_price }], fees_sol, position_closed, pnl_sol }`. `paper_apply_v2` (security invoker, service_role seul) verrouille le portefeuille du book puis la position, n'applique **que si** la position a encore le statut attendu et que chaque jambe à clôturer est encore `open`, puis met à jour position + jambes + solde **dans la même transaction** : jamais de double exécution, rejouable sans effet (renvoie `null`). Une charge incohérente (signe du delta, jambes d'une autre position, `position_closed` faux…) lève une erreur et rien n'est écrit.
6. Réponse `{ pending, open, loaded, filled, closed, legs, moved, expired, ticks, quotes, rateLimited, stale, failed, deferred, ms }` (`legs` = clôture partielle, `moved` = seul déplacement de stop, `stale` = déjà appliqué/annulé entre-temps).

Choix du créneau, limites : inchangés depuis la v1 (minutes impaires, ~15–25 s après les snapshots du scan, aucun appel GeckoTerminal, pire cas ≈ 44 s + 1 RPC ; prix échantillonné toutes les 2 min, un gap sous le stop sort sous le stop).

### Suivi forcé des prix
`scan-tokens` lit les mints des positions `pending` / `open` de `paper_positions` (`loadPaperMints`, ≤ 500 lignes) et les ajoute au lot de suivi (`buildTrackingBatch`) : ≤ 100 mints par scan, positions ouvertes puis entrées en attente, **au plus 50 % des places au premier passage** (les alertes suivies gardent les leurs), le reste revient aux mints paper s'il en reste. Sans la migration, la lecture échoue silencieusement.


## Laboratoire — simulation uniquement
Contrats : `docs/contracts/strategy-lab.md`, `lab-v2.md`, `young-calm.md`, `slim-down.md` §10. Moteur pur : `_shared/backtest.ts`, `_shared/backtest-worker.ts`, `_shared/events.ts`, `_shared/event-scanner.ts`, `_shared/candles.ts`.

- **Presets** : `young_calm` / `young_frenzy` en mode **détection** (valeurs à la détection lues dans `signal_outcomes.features` : âge, dex, liquidité effective, `change_1h`, ratio achats / ventes 1 h, LP, RugCheck) et `young_calm_ev` / `young_frenzy_ev` en mode **événement** (premier snapshot où les règles de `presets.ts` deviennent vraies, colonnes « au moment du scan », entrée sur bougie 1 min).
- **« Structure cassée »** (règle des presets depuis feat/calm-sl-test) n'est **pas** appliquée par le Laboratoire : ni les features de détection ni les snapshots ne gardent les variations 5 min / 6 h / 24 h. Les résultats du Laboratoire restent donc ceux des règles de phase 1 (écart mesuré par `scripts/calm-replay-48h.ts`, champ `without_structure_rule`).
- **Grille** : sortie tout à ×2, stop −20 / −30 / −40 %, sans breakeven, sans sortie au temps, délai 0 / 2 min = **6 variantes par preset, 24 au total**. Stockage inchangé (`backtest_trades.returns` = 384 cases, seules les 6 cases de la grille sont simulées, les autres `null`), donc les runs archivés restent lisibles et les `CHECK` sont inchangés. Une détection n'est stockée que si elle porte un bit jeune (`isStoredDetection`) ; bit de ligne de détection = 1 (exigé par le `CHECK`), `young_calm` 1024, `young_frenzy` 2048, `young_calm_ev` 4096, `young_frenzy_ev` 8192.
- **Run** (`backtest-run`, cron chaque minute, nocturne 03:40 UTC ou `rpc('backtest_request_run')`) : `simulate` (détections des 30 derniers jours puis événements des deux presets jeunes), `split`, `aggregate` (1 tranche × 3 narratifs par preset = 12 étapes ; coupure 70 / 30 par preset, ≥ 30 trades de test, bootstrap 1 000 tirages, « robuste » = IC 95 % hors de 0), `done` (`backtest_runs.summary`). Rétention : trades des 3 derniers runs, résultats des 14 derniers.
- **Scanner d'événements** : quand aucun run n'est actif, relit `token_snapshots` (curseur `(captured_at, id)`) et écrit `backtest_events` (`young_calm_ev`, `young_frenzy_ev` ; une fois par preset et mint). Les curseurs et états écrits avant chore/slim-down restent valides (compteurs / presets supprimés ignorés).
- **Correctif du run du 21/11** (doublons de clé primaire dans le lot d'upsert, `dedupeTradeRows`) : toujours en place et couvert par `backtest_worker_test.ts`.
- Résultats anciens (presets `all`, `mc_300k_1m`, `momentum`, `young_24h`, `young_3h`, `post_migration`, `narrative_leader`, `*_explo`) : archivés (lisibles, plus produits).

## Étude des premiers acheteurs — hors ligne uniquement
Aucune alerte, aucun trading, aucune connexion de wallet. Collecte : Edge Function `wallet-study-collect` (cron chaque minute, `supabase/sql/schedule_wallet_study.sql`, job `raijin-wallet-study`) ; logique pure `_shared/wallet-collect.ts`, source d'historique derrière l'interface `TxHistorySource` (`_shared/wallet-collect-helius.ts`). Analyse : `_shared/wallet-study.ts` et `scripts/wallet-study*.ts` (scanner-quant).

- **Source** : Helius `getTransactionsForAddress` (mode `full`, `sortOrder: 'asc'`, `status: 'succeeded'`, 100 transactions par page = 10 crédits ; pagination `slot:position`). Plan Free utilisable (aucune restriction documentée, 10 req/s) ; la fonction se limite à ≈ 6,7 req/s.
- **File** : `signal_outcomes` labellisés (`status = 'final'` ou `x2_before_sl30` connu), plus ancienne détection d'abord ; les mints en cours (curseur stocké dans `wallet_study_state`) passent avant.
- **Par mint** : 1 requête sur le mint (limite 1) → créateur = payeur de la première transaction ; puis les pages du pool (`signal_outcomes.pair_address`) depuis sa création → créateur du pool = payeur de la première transaction. Achat = le solde du mint détenu par le payeur augmente ; montant SOL = WSOL reçu par l'autre côté du swap (vault du pool + frais, hors frais réseau, rente ATA et pourboire Jito ; `null` si la cotation n'est pas en SOL). On garde le **premier achat** de chacun des 50 premiers wallets distincts (rang 1–50), hors créateur, créateur du pool, pool, mint, programmes et autorités AMM connus. Fin : 50 acheteurs (`done`), historique épuisé (`exhausted`), 20 pages (`capped`), 3 échecs propres au mint (`failed`).
- **Limites connues** : les achats sur la bonding curve (avant migration pump.fun) ne sont pas dans l'historique du pool ; les transactions v1 non conformes au schéma sont ignorées (`dropped_txs`).
- **Budget** : chaque requête réserve 10 crédits (`rpc wallet_study_reserve`, atomique) ; refus = arrêt dur à 600 000 (contrainte `CHECK`). Une réponse d'erreur de Helius (gratuite) est remboursée (`wallet_study_refund`, jamais sous 0). Bail de 90 s avec jeton propriétaire (`wallet_study_claim` → jeton, `wallet_study_release(jeton)` ne libère que son propre bail) ; plus aucune requête après 30 s (délai 15 s par requête).
- **Pannes** (`_shared/wallet-collect.ts` `failurePolicy`) : 429 et pannes (HTTP 401/403/5xx, réseau, JSON invalide, erreur base) arrêtent l'appel **sans** incrémenter les tentatives du mint (clé révoquée = file intacte) ; seules les erreurs propres au mint (enveloppe invalide, erreur RPC) comptent une tentative.
- **Exclusion « wallet présent dans > 30 % des tokens »** : faite à l'analyse (dénominateur = mints `done` / `exhausted` / `capped`), pas à la collecte.

## Notifications push
Web Push standard (RFC 8030 / 8291 / 8292) en Web Crypto (`_shared/webpush.ts`). Logique pure : `_shared/alerts.ts`, `_shared/presets.ts`, `_shared/preset-alerts.ts`.

### Flux (dans `scan-tokens`, après l'upsert)
1. Sans clés VAPID valides : étape ignorée.
2. ≤ 25 `alert_settings` avec `enabled = true`, hors heures calmes (heure de Paris).
3. Abonnements (5 par utilisateur), `alert_log` des 24 h (`single` / `grouped`), snapshot précédent de chaque token (`source = 'scan'`, dans les 5 min avant le scan ; erreur de lecture = aucune alerte).
4. Candidats « Jeune calme » (`selectYoungCalmCandidates`), triés par volume 1 h puis liquidité effective.
5. Budget = min(reste horaire `max_per_hour`, reste quotidien `max_per_day`) en notifications distinctes ; au plus 3 individuelles puis une groupée.
6. Envoi (6 en parallèle, 8 s, 150 envois et 20 s max) ; 404 / 410 → abonnement supprimé.
7. `alert_log` (`preset = 'young_calm'`) pour chaque notification arrivée : l'individuelle porte son plan (×2 / ×0,7) et devient une position suivie 7 jours.

### Critères (`evaluateYoungCalmAlert`) — dans cet ordre
1. **Prédicat « Jeune calme »** (`matchesYoungCalm`) : mint valide ; paire < 24 h ; pumpswap ; liquidité effective ≥ 30 k$ ; mint **et** freeze authority désactivées, pas d'insiders ni de créateur déjà rug ; top 10 < 25 % ; aller-retour < 5 % (inconnu = refus) ; LP ≥ 90 % si connue ; **pas de « Structure cassée »** (feat/calm-sl-test) ; 0 ≤ `change_1h` ≤ 100 % et 0,8 ≤ ratio 1 h ≤ 1,3 (valeurs inconnues = refus).
2. **Une alerte par épisode de position** (`calmAlertGuard`, remplace la dédup 12 h) : refus (`position_open`) tant qu'une position `calm_sl30` / `calm_sl40` de l'utilisateur sur ce mint est `pending` / `open` **et** qu'une alerte a déjà été envoyée pour elle (alerte ≥ création de la position − 15 min : l'alerte part dans le même scan, quelques secondes avant la position, ou un scan plus tard quand la position a été ouverte dès la première vue) ; si aucune position n'a été ouverte pour la dernière alerte (pas d'auto-paper, délai après stop, solde…), **garde de 12 h** (`dedup`) comme avant ; une position ouverte pour la dernière alerte et clôturée lève la garde. Lecture fail-closed : positions (≤ 1000) ou historique d'alertes de ces mints (≤ 1000, sans limite d'âge) illisibles → aucune alerte ce scan.
3. **Persistance** : un scan précédent du token existe, âgé de 5 min au plus (aucune condition de score ni de zone).
4. **Plan de sortie** fixe (`fixedExitPlan`, `_shared/exit-plan.ts`) : objectif = entrée × 2 (+100 %), stop = entrée × 0,7 (−30 %), R/R 3,333.

`young_frenzy` n'alerte jamais (mesure et auto-paper `frenzy_sl30` seulement). « Structure cassée » est une règle des deux presets depuis feat/calm-sl-test (non historisée : le rejeu `scripts/calm-replay-48h.ts` la reconstruit depuis l'historique des prix des snapshots).

### Suivi après alerte (7 jours, `_shared/alert-tracking.ts`)
À chaque scan, après les alertes :
1. lit les positions ouvertes (`alert_log` avec `tracking_until > now()` et un plan, 1000 lignes max, les plus récentes d'abord ; lecture lancée dès le début du scan) ;
2. `buildTrackingBatch` : mints distincts (100 max ; positions paper ouvertes, puis entrées paper en attente, puis alerte la plus récente d'abord, voir « Paper trading »). Ceux qui ne sont pas dans les tokens gardés par le scan sont chargés quand même via DexScreener `/tokens/v1/solana/{30 mints}` (≤ 4 appels, en parallèle des audits) et reçoivent un `token_snapshots` `source = 'tracking'` (sans score ni zone ; `tokens` n'est pas modifié) ;
3. `trackPosition` par position : `max_price`, `min_price`, `last_price`, `last_price_at` et le **premier** franchissement : prix ≥ objectif → `target`, prix ≤ stop → `stop` ; une fois posé, `first_hit` ne change plus (le premier gagne) ;
4. applique tout en **un seul appel** rpc `apply_alert_tracking(jsonb)` (service_role uniquement, ≤ 1000 lignes, ne réécrit jamais un `first_hit` existant, renvoie les positions qui viennent d'être touchées).

**Limite** : le prix est un échantillon toutes les 2 min (prix DexScreener du scan) : une mèche entre deux scans peut être manquée, et `max_price` / `min_price` sont des bornes d'échantillons, pas les vrais extrêmes.

### Relances (48 h)
Une position est relancée si `first_hit` est posé, `followup_sent_at` est nul et l'alerte date de moins de 48 h : « ✅ Objectif atteint · SYMBOLE +X % » ou « 🛑 Invalidation touchée · SYMBOLE −Y % » (X/Y = niveau touché par rapport à l'entrée), corps « Prix … atteint/touché depuis l'alerte. Aide à la décision, pas un conseil financier. », `data.url = /token/{mint}`, `tag = raijin-followup-{mint}` (ne remplace pas l'alerte d'origine sur l'appareil). Règles : uniquement aux utilisateurs dont les alertes sont activées ; **respecte les heures calmes** (la relance part au premier scan après, si l'on est encore dans les 48 h) ; **ne consomme pas** le budget horaire (pas de ligne `alert_log`) ; 5 relances max par utilisateur et par scan, 8 s max d'envoi ; `followup_sent_at` n'est posé que si au moins un appareil l'a reçue (sinon nouvel essai au scan suivant, jusqu'à 48 h). Rien de cette étape ne fait échouer le scan.

### Contenu
- Individuelle : titre « ⚡ RAIJIN · Jeune calme · {SYMBOLE} », corps « Paire de 5 h · Objectif +100 % (0,002 $) · Stop −30 % (0,0007 $) · R/R 3,3 · MC 1,2 M$ · {2 premiers drapeaux} · Aide à la décision, pas un conseil financier. », `data.url = /token/{mint}`, `tag = raijin-{mint}`. Plus de score, de zone ni de mention du modèle.
- Relance : « ✅ Objectif atteint · {SYMBOLE} +X % » / « 🛑 Invalidation touchée · {SYMBOLE} −Y % », `data.url = /token/{mint}`, `tag = raijin-followup-{mint}`.
- Groupée : « ⚡ RAIJIN · N nouvelles opportunités », `data.url = /`.
- Test : « ⚡ RAIJIN · Notification de test », `data.url = /settings`.
- Forme JSON (ngsw) : `{ notification: { title, body, icon, tag, data: { url, onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url } } } } }`, < 3 Ko, aucun secret ; `url` toujours relatif et construit côté serveur.

### Front (PWA)
- Service worker Angular (`ngsw-config.json`) : uniquement des `assetGroups` (coquille en prefetch, icônes en lazy). **Aucun `dataGroups`** : les appels Supabase (cross-origin) ne sont jamais mis en cache (test `core/pwa/ngsw-config.spec.ts`).
- Abonnement : demandé **uniquement au toucher** de l'interrupteur « Notifications » (Réglages), jamais au chargement (exigence iOS). Sur iPhone, Safari n'expose Web Push qu'une fois Raijin ajouté à l'écran d'accueil : un guide s'affiche sinon.
- Clic sur une notification : `SwPush.notificationClicks` (app ouverte) et `data.onActionClick.default` (`navigateLastFocusedOrOpen`, app fermée). Chemin accepté : `/`, `/settings`, `/alerts` ou `/token/{mint}` ; tout le reste → `/` (`core/pwa/notification-url.ts`).
- ngsw n'affiche une notification que si le JSON a la forme `{ notification: { title, body, icon, tag, data: { url, onActionClick } } }`.

### Edge Function `send-test-push`
`verify_jwt = true`. Identifie l'appelant (`auth.getUser()` avec son JWT), applique le rate limit atomique `claim_test_push` (1/min/utilisateur, sinon 429), envoie la notification de test **uniquement** à ses abonnements, supprime les 404/410, répond `{ sent, removed }`. CORS : `http://localhost:4200` + `ALLOWED_ORIGINS`.
