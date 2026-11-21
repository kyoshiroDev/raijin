# Contrat — feat/strategy-lab

Objectif : trouver une stratégie rentable, frais compris, sans se tromper soi-même. Contrat partagé entre
scanner-quant (code pur `_shared`, scripts), supabase-engineer (migrations, Edge Functions, cron) et
angular-architect (front). Ne pas s'en écarter sans le signaler.

## Contraintes mesurées (à respecter dans la conception)
- Base Supabase : ~133 Mo aujourd'hui (offre gratuite ≈ 500 Mo). ~270 détections de scan par jour.
  1 224 bougies par détection (360 × 1 min + 864 × 5 min) en lignes individuelles ≈ 10 M lignes / 30 jours
  (> 1 Go) : **interdit**. Stockage compact obligatoire (voir §B1).
- GeckoTerminal gratuit : ~4–5 requêtes/min ; depuis l'IP des Edge Functions, 429 après ~6 appels par exécution
  (≈ 20–25 requêtes/heure au total, déjà presque entièrement consommées par l'étiquetage). La capture des bougies
  est donc « au mieux » côté hébergé, avec une file prioritaire ; le retard se rattrape avec un script local.
- Edge Functions : ~2 s de CPU par appel. Tout calcul lourd est découpé en tranches (worker appelé chaque minute).

## PARTIE A — stratégie `thirds_x2_x3_x4`
- 3 jambes 33 / 33 / 34 %, TP ×2, ×3, ×4 ; SL commun −30 % (sl_pct des réglages/preset).
- Échelle de stop : TP ×2 touché → stop des jambes restantes = prix de remplissage (breakeven) ;
  TP ×3 touché → stop de la jambe restante = remplissage × 2. Même ordre de traitement qu'aujourd'hui dans
  `step()` (même bougie/tick : stop d'abord, prudent).
- Ajout partout où les stratégies sont listées : `Strategy` (paper.ts), `planLegs` + son miroir SQL
  (`paper_open_position_as` / `paper_open_position`), checks SQL `strategy`, `paper_apply_v2` si l'échelle
  demande un nouveau type de déplacement de stop, front (libellé « Tiers ×2 / ×3 / ×4 »).
- Nouveau book `young_thirds_x2_x3_x4` (portefeuille virtuel séparé, 1,0 SOL). L'auto-paper « Jeune & fort »
  ouvre désormais 3 positions (young_all_x2, young_half_x2_rest_x3, young_thirds_x2_x3_x4), 0,1 SOL chacune,
  `entry_mode = 'next_tick'`.
- Tests : transitions de stop entrée → breakeven → ×2, sorties partielles, même tick TP+SL, recalage au fill.

## PARTIE B — Laboratoire de backtest

### B1. Stockage des bougies — table `ohlcv_candles` (compacte)
Une ligne par (fenêtre de détection, timeframe) au lieu d'une ligne par bougie :
```
ohlcv_candles(
  id bigint identity pk,
  mint text, pool text,                 -- base58 validés
  tf text check in ('1m','5m','15m'),
  ts_start timestamptz,                 -- ouverture de la 1re bougie
  step_s int,                           -- 60 / 300 / 900
  ts int[]   -- décalages en secondes depuis ts_start (les trous de GeckoTerminal sont conservés tels quels)
  o real[], h real[], l real[], c real[], v real[],   -- même longueur que ts
  source text, detected_at timestamptz, -- détection d'origine (signal_outcomes | preset_signals)
  fetched_at timestamptz,
  unique (mint, tf, ts_start)
)
```
+ vue `ohlcv_candles_flat(mint, pool, tf, ts, o, h, l, c, v)` (unnest, security_invoker) pour la lisibilité.
RLS : SELECT authenticated, écriture service_role ; anon rien. Purge > 30 jours (cron).
- Fenêtres : 1 min de la détection à +6 h (capturée à détection + 6 h, 1 requête aggregate=1 limit 360),
  5 min de la détection à +72 h (capturée à détection + 72 h, 1 requête aggregate=5 limit 864). Jamais re-téléchargée.
- Détections couvertes : `signal_outcomes` (scan) et `preset_signals`. Pas le radar (`early_outcomes`), faute de
  budget GeckoTerminal.
- Colonnes de file sur ces deux tables : `candles_1m_at`, `candles_5m_at` (prochaine capture due, null = faite
  ou inutile), `candles_attempts`.
- Ordre de priorité de la file label-outcomes : étiquettes preset_signals > bougies preset_signals >
  étiquettes scan > bougies scan > étiquettes radar. Même rythme et même gestion des 429 que la file actuelle
  (`label-queue.ts`).
- **Amorçage 15 min** : le cache local du rattrapage d'étiquettes contient les bougies 15 min (7 jours) de ~550
  détections déjà étiquetées. Elles sont importées en `tf = '15m'` (même table) par un script local, pour que le
  laboratoire ait des données tout de suite. Le moteur utilise toujours la résolution la plus fine disponible
  pour chaque instant et le rapport donne la part des détections avec 1 min / 5 min / seulement 15 min.
- Script local `scripts/candle-catchup.ts` (même modèle que `scripts/label-catchup.ts` : CLI Supabase,
  aucun secret lu ni affiché, rythme adaptatif, cache) pour capturer le retard 1 min / 5 min, et option
  `--seed-15m <dir>` pour l'amorçage.

### B2. Moteur pur `_shared/backtest.ts` (+ tests)
Rejoue une stratégie bougie par bougie sur un chemin fusionné (1 min puis 5 min puis 15 min).
- Entrée : clôture de la première bougie dont l'ouverture est ≥ détection + délai (0, 2 ou 5 min).
  Pas de bougie → pas de trade.
- Même bougie TP et SL → SL d'abord. SL exécuté à min(niveau du SL, clôture de la bougie). TP exécuté au niveau.
- Breakeven après TP1 (option) ; pour thirds avec breakeven, échelle complète (entrée puis ×2).
- Sortie temporelle (option 1 h / 6 h / 24 h) : tout ce qui reste est vendu à la clôture de la première bougie
  ≥ détection + durée. Fin des données sans sortie : vendu à la dernière clôture et marqué `open_at_end`.
- Frais : `entry_roundtrip_pct` de la détection (3 % si inconnu), appliqué une fois sur la mise (aller-retour),
  + 0,0002 SOL par transaction (1 achat + 1 par jambe vendue) ; rent rendu (net 0).
- Résultat par trade : rendement net en % de la mise et en SOL pour 0,1 SOL.

### B3. Grille (annoncée dans le rapport)
- presets (filtres sur les valeurs AU MOMENT DE LA DÉTECTION, `signal_outcomes.features` / `entry_*`) :
  `all` (Tous), `momentum` (critères Momentum, sécurité non vérifiable historiquement → ignorée, signalé),
  `young_24h` (Jeune & fort, âge < 24 h), `young_3h` (âge < 3 h), `mc_300k_1m` (MC 300 k$–1 M$ seule) ;
- sorties : `all_x2`, `half_x2_rest_x3`, `thirds_x2_x3_x4`, `all_x1_5` ;
- SL : 20, 30, 40, 50 % ; breakeven après TP1 : oui / non ; sortie temporelle : aucune, 1 h, 6 h, 24 h ;
  délai d'entrée : 0, 2, 5 min.
- Total annoncé : 5 × 4 × 4 × 2 × 4 × 3 = **1 920** variantes ; le breakeven n'a pas d'effet sur all_x2 et
  all_x1_5 → **1 440 distinctes**. Le rapport donne les deux nombres.
- Chaque détection est simulée une fois pour les 384 combinaisons de stratégie (sorties × SL × BE × temps ×
  délai) ; le preset est un filtre appliqué à l'agrégation.

### B4. Validation anti-hasard
- Séparation chronologique globale par `detected_at` : 70 % plus anciennes = apprentissage, 30 % plus récentes =
  test (même date de coupure pour tous les presets).
- « Retenue » : gain moyen net par trade > 0 en apprentissage ET en test, avec ≥ 30 trades en test.
- Bootstrap (1 000 rééchantillonnages, graine fixe pour la reproductibilité) de l'intervalle à 95 % du gain moyen
  par trade sur la partie TEST ; drapeau `ci_contains_zero`.
- « Robuste » : retenue ET intervalle excluant 0.
- Résultats séparés `narrative` ∈ all / gta / other (GTA = narratif 'GTA' à la détection, sinon tokens.narrative).
- Le rapport mentionne le risque de comparaisons multiples (1 440 variantes : quelques « robustes » par hasard sont
  attendues).

### B5. Métriques (par variante × preset × narratif × partie)
trades, win_rate, avg_win_pct, avg_loss_pct, avg_net_pct, avg_net_sol (0,1 SOL), profit_factor,
max_drawdown_sol (séquence chronologique, 0,1 SOL par trade), worst_losing_streak, ci_low, ci_high (test),
ci_contains_zero, open_at_end.

### B6. Tables, worker, écran
- `backtest_runs(id, status in ('queued','running','done','failed'), requested_by uuid null, trigger in
  ('nightly','manual'), params jsonb (grille), data_version jsonb (nb détections, résolutions, coupure
  train/test, max detected_at), n_detections, n_variants, n_distinct_variants, progress, error,
  created_at, started_at, finished_at)`.
- `backtest_trades(run_id, source, mint, detected_at, split, preset_flags, narrative, returns real[384])`
  (intermédiaire, conservé pour les 3 derniers runs).
- `backtest_results(run_id, preset, exit, sl_pct, breakeven, time_exit_h, delay_min, narrative, split,
  métriques…, retained boolean, robust boolean)`.
- RLS : SELECT authenticated sur les trois ; écritures service_role.
- RPC `backtest_request_run()` (authenticated, security definer, search_path '') : insère un run 'manual' sauf si
  un run est queued/running ou si le dernier a démarré il y a < 10 min (erreur française claire).
- Edge Function `backtest-run` (x-cron-secret, verify_jwt false), cron chaque minute : prend le run le plus ancien
  queued/running, simule une tranche de détections (budget CPU < 1,5 s), puis agrège (découpé par preset si besoin),
  puis status 'done'. Idempotent et reprenable.
- Cron nocturne (03:40) : insère un run 'nightly'.
- Écran « Laboratoire » dans Performance : dernier run (état, date, nb détections, nb variantes testées et
  distinctes, coupure), classement des variantes retenues (tri par gain moyen net en test), métriques apprentissage
  ET test côte à côte, badge « robuste », filtre narratif Tous / GTA / Hors GTA, bouton « Relancer le backtest »
  (désactivé pendant un run). Mention claire « backtest ≠ résultat futur ». Si aucune variante robuste : le dire.

## Interdits
Simulation uniquement : aucune clé privée, signature ou connexion de wallet. Textes de token = données hostiles.
