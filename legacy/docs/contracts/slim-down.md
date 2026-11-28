# Contrat — chore/slim-down (phase 1 « Ménage »)

Principe : on ARCHIVE les données (tables / colonnes conservées, plus aucune écriture, listées dans
`docs/ARCHIVE.md` avec la raison et la date 2026-11-21) et on SUPPRIME le code, les crons et les écrans.
Aucune table ni colonne n'est supprimée ; les contraintes NOT NULL des colonnes qui ne sont plus écrites sont levées
par migration ; les CHECK restent compatibles avec les lignes existantes. Aucune migration appliquée n'est modifiée.

À garder intacts : scan, filtres de sécurité (mint/freeze, top 10, RugCheck, LP verrouillée), coût d'aller-retour
(devis Jupiter), copie d'adresse, auth, PWA et push (send-test-push), étiquetage sur bougies (signal_outcomes,
preset_signals, ohlcv_candles, label-outcomes), paper trading all_x2 (books `main`, `calm_all_x2`, `frenzy_all_x2`),
Performance, narratif (tokens.narrative → segments GTA), spark_6h (rpc x3_snapshot_history), market context (sol_usd).

## Décisions (arbitrages de l'inventaire)
1. **Score /100 supprimé.** `scoreToken` devient une fonction de **drapeaux + consensus** (drapeaux de sécurité,
   RugCheck, LP, coût, bonding curve, liquidité effective, data_confidence) sans score. Remplacements d'ordre :
   - scan (quota d'âge des anciens, top N audits/historique, young watch) : `volume_1h` décroissant puis liquidité ;
   - liste Opportunités : âge croissant (plus jeunes d'abord) ; candidats d'alerte young_calm : `volume_1h`.
   Migration : `tokens.score`, `token_snapshots.score` → NOT NULL levé (plus écrits). `alert_settings.min_score`
   archivé. Front : badges factuels sur chaque carte — âge, « Calme » / « Frénésie » (règles young_calm / frenzy de
   presets.ts ; « — » si ni l'un ni l'autre), « Sécurité OK » / « Sécurité KO » (mêmes règles que le preset),
   coût d'aller-retour en SOL pour la mise (`alert_settings.stake_sol`, utilitaire roundtrip existant).
2. **Fibonacci supprimé** (zones, plan, TP1/TP2, invalidation, R/R, in/wait/deep, bougies de zone dans le scan → appels
   GeckoTerminal économisés). **« Structure cassée » est conservé** car la phase 2 l'exige dans la sécurité de
   « Jeune calme » : petite fonction pure `structureBroken(metrics)` calculée sans bougies (même définition qu'avant :
   prix sous le niveau 0,786 du swing approximé par `approxSwing`), qui émet `FLAG_ZONE_BROKEN`. `tokens.zone_*`, `tp*`,
   `invalidation`, `swing_*`, `rr`, `zone_candles_at`, `alert_settings.only_in_zone`, `min_rr` : archivés (plus écrits,
   NOT NULL levés si besoin). Le plan de sortie des alertes reste ×2 / ×0,7 (type `ExitPlan` conservé).
3. **Modèle ×3 supprimé** (model.ts, scripts/calibrate.ts, badges, réglages min_p_x3 / max_p_dd50 / min_rr, carte
   modèle). `model_weights` archivée. **Conservés** : `buildFeatureVector` et `signal_outcomes.features` (NOT NULL,
   lu par le backtest), narratif, rpc x3_snapshot_history (spark_6h).
4. **Presets Momentum, Strict, Jeune & fort supprimés** ; « Réveil » n'existe pas dans le dépôt (rien à retirer).
   Reste un seul preset d'alerte : `young_calm` ; `young_frenzy` reste comme témoin sans alerte.
   Constantes réutilisées par young_calm (dex, coût < 5 %, top 10 < 25 %, ×2 / ×0,7, `pairAgeHours`,
   `safetyRejection`, `passedPreviousScan`, `nextTickEntries`) déplacées dans young_calm / un module commun.
   track-fast, fast-track.ts, schedule_fast.sql, young-strong-field supprimés ; cron `raijin-fast` et
   `raijin-purge-fast-ticks` retirés ; `fast_watch`, `fast_ticks` archivées. `alert_settings.young_strong_enabled`
   archivé. Books `half_x2_rest_x3`, `all_x2`, `young_*` : positions archivées (plus d'ouverture ; les positions
   encore ouvertes sont annulées proprement par migration, solde inchangé, raison notée) ; `paper_open_position_as`
   n'accepte plus que `main`, `calm_all_x2`, `frenzy_all_x2`.
5. **Stratégies half_x2_rest_x3 et thirds_x2_x3_x4 supprimées** : seule `all_x2` reste (code, SQL planLegs, réglages
   `paper_default_strategy` / `auto_paper_parallel` archivés, écrans). Les positions existantes gardent leurs valeurs
   (CHECK inchangé pour l'historique), mais aucune nouvelle position ne peut les utiliser.
6. **Radar précoce supprimé** (scan-early, early*.ts, écran Radar, scanner-switch, radar-alerts-field, cron
   `raijin-early` ET `raijin-purge-early` — les tables archivées ne sont plus purgées). Tables `early_*` archivées.
   File d'étiquetage radar vidée : label-outcomes ne traite plus `early_outcomes`.
7. **Sources** : retirer Jupiter toptrending / toporganicscore / toptraded 1 h et 6 h et GeckoTerminal trending
   (gecko_volume déjà retiré). Garder les sources jeunes déjà en place (`gecko_trending_1h` filtré < 24 h,
   `gecko_pumpswap` < 24 h, `young_watch`) et DexScreener. Ajouter GeckoTerminal `new_pools` (Solana, paginé, pools
   < 24 h) et Jupiter `recent` (lite-api tokens v2 recent) comme demandé ; mesurer leur rendement réel par source
   (seen / kept / kept < 24 h dans scan_runs.source_counts). Objectif ≥ 40 % < 24 h parmi les gardés. Perte de
   l'exclusion des tags non-memecoin portée par les toplists Jupiter : la conserver via les tags de Jupiter recent
   si disponibles, sinon le signaler.
8. **Liquidité Jupiter** retirée de toute la plomberie (calculs déjà sans Jupiter) ; liquidité effective =
   médiane(DexScreener, GeckoTerminal) ; Jupiter seulement dans l'infobulle. `tokens.liquidity_jup_usd` archivée.
9. **Watchlist** : aucun écran n'existe ; retirer `loadWatchlistMints` du scan ; table archivée.
10. **Laboratoire** : grille réduite à `young_calm` et `young_frenzy` (modes détection et événement), sortie all_x2
    (TP ×2), SL −20 / −30 / −40 %, sans breakeven ni sortie temporelle, délai 0 ou 2 min = 6 variantes par preset.
    Presets exploratoires et autres presets retirés du code ; résultats anciens archivés. Le correctif du run du
    21/11 (doublons de clé primaire dans le lot d'upsert) est déjà déployé (c6d62b8) avec ses tests : vérifier qu'il
    reste couvert.

## Écrans finaux
Opportunités (jeunes < 24 h par défaut, option « Afficher les tokens anciens »), Alertes, Portefeuille,
Performance (Laboratoire inclus), Réglages.

## Mesures pour le rapport
Lignes supprimées (`git diff --stat`), crons restants, appels GeckoTerminal économisés par heure (radar, bougies de
zone, trending), part de tokens < 24 h avant (8 % le 21/11 matin ; 36 % après fix/young-sources) / après.
