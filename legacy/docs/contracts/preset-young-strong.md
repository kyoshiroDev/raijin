# Contrat — feat/preset-young-strong

Branche `feat/preset-young-strong`. Contrat partagé entre scanner-quant (code pur `_shared`), supabase-engineer
(migrations, Edge Functions, cron) et angular-architect (front). Ne pas s'en écarter sans le signaler.

## Constat (issues étiquetées sur bougies, 471 détections suivies ≥ 12 h)
Vente à ×2 avec stop −30 % ≈ −5 % par trade en moyenne. Seul profil positif : MC 300 k$–1 M$ + pumpswap + zone
'wait' + âge < 7 j → 22 cas, 45 % ×2 avant stop, 41 % stop avant ×2, ≈ +29 % par trade. Tokens > 7 j : 4–6 % de ×2.

## 1. Preset `young_strong` — « Jeune & fort »
- Identifiant `'young_strong'`, libellé `Jeune & fort`.
- Prédicat (toutes les conditions, une valeur inconnue rejette) :
  - mint valide ; `dex_id = 'pumpswap'` ;
  - 300 000 ≤ market_cap ≤ 1 000 000 (USD, bornes incluses) ;
  - âge de la paire < 24 h, calculé depuis `tokens.pair_created_at` (inconnu → rejet). Variante à mesurer : < 3 h
    (`YOUNG_STRONG_VARIANT_MAX_AGE_H = 3`) — enregistrée (`pair_age_h`), PAS utilisée pour filtrer ;
  - `zone_status = 'wait'` uniquement ; `change_1h > 0` ;
  - mint ET freeze authority désactivées ; `top10_pct < 25` ; `insiders_detected !== true` ;
    `creator_rug_history !== true` ;
  - `roundtrip_cost_pct < 5` ; pas de drapeau « Structure cassée » (`FLAG_ZONE_BROKEN`).
- Flux d'alerte SUPPLÉMENTAIRE, indépendant du preset principal (`alert_settings.alert_preset` reste
  momentum | strict). Activé par `alert_settings.young_strong_enabled boolean not null default true`.
- Pas de persistance sur 2 scans (latence). Pas de score, pas de zone « in ».
- Déduplication : une seule alerte par (utilisateur, token) tant qu'une position virtuelle de ce token dans un book
  young_* est `pending` ou `open` ; si l'utilisateur n'a pas d'auto-paper, garde-fou de 12 h sur `alert_log`.
- Plan de sortie de l'alerte : cible = entrée × 2, stop = entrée × 0,7.
- Plafonds propres au flux : 4 / h et 30 / 24 h (comptés sur `alert_log.preset = 'young_strong'`), séparés de
  ceux du flux principal.
- `alert_log.preset text` (nullable, check in ('momentum','strict','young_strong')) : renseigné pour les nouvelles
  alertes.
- `preset_signals` : preset 'young_strong' ajouté au check ; nouvelles colonnes `narrative text` (narratif à la
  détection, ex. 'GTA', backfill depuis tokens.narrative) et `pair_age_h numeric` (âge de la paire à la détection).
  Étiquetage OHLCV inchangé (label-outcomes).

## 2. Auto-paper « Jeune & fort »
- Deux nouveaux books, portefeuilles virtuels séparés (1,0 SOL chacun comme les autres) :
  `young_all_x2` (stratégie all_x2) et `young_half_x2_rest_x3` (stratégie half_x2_rest_x3). Mise 0,1 SOL chacune,
  stop 30 %. Ouverts pour chaque alerte young_strong délivrée si `auto_paper = true`.
- Le cooldown 12 h après un stop (paper_open_position_as) s'applique aussi.
- Entrée réaliste : `paper_positions.entry_mode text not null default 'target' check in ('target','next_tick')`.
  `next_tick` = remplie au prix du PREMIER snapshot de scan (`token_snapshots`) capturé strictement APRÈS
  `created_at` (≈ 2 min), quel que soit le prix, × (1 + impact d'achat) ; legs recalés sur le prix de remplissage
  (même recalage que les presets actuels). Les ticks rapides (§3) ne remplissent JAMAIS une position pending.
- Les sorties (TP/SL) des positions OUVERTES des books young_* sont aussi évaluées sur les ticks rapides (§3),
  avec la même fonction pure `step()` et `paper_apply_v2` (concurrence optimiste déjà gérée par p_expected).
  Impact de vente sans devis Jupiter : `tokens.roundtrip_cost_pct / 2`, sinon le défaut de paper.ts.

## 3. Suivi rapide (fast tracking)
- Dès qu'un token passe le prédicat young_strong au scan : ligne dans `fast_watch` (mint PK, pair_address,
  preset, started_at, until = started_at + 2 h, plus les champs d'issue ci-dessous). Une seule fenêtre active par
  mint (pas de prolongation si déjà active). Plafond 30 paires suivies simultanément (1 requête DexScreener).
- Edge Function `track-fast` (verify_jwt = false, `x-cron-secret` en temps constant), cron chaque minute,
  2 passes espacées de 30 s dans le même appel (budget < 50 s). Endpoint :
  `https://api.dexscreener.com/latest/dex/pairs/solana/{pair1,pair2,…}` (≤ 30 paires, adresses validées base58).
  Réponse validée par zod, prix > 0 et fini.
- `fast_ticks(mint, pair_address, at timestamptz, price_usd, liquidity_usd)`, unique (mint, at), purge > 7 jours.
- Issue sur 2 h stockée dans `fast_watch` : `entry_price` (1er tick), `max_multiple`, `min_multiple`,
  `first_x2_at`, `first_sl30_at`, `x2_before_sl30`, `sl30_before_x2` (même tick → stop d'abord, prudent),
  `ticks int`, `last_tick_at`.
- RLS sur les deux tables, SELECT authenticated seulement, écritures service_role.

## 4. Performance — `performance_by_preset()`
RPC SECURITY INVOKER, `search_path = ''`, EXECUTE pour authenticated uniquement :
```
performance_by_preset() returns table(
  preset text,            -- 'momentum' | 'young_strong' | 'strict'
  segment text,           -- 'all' | 'gta' | 'other' | 'age_lt_3h' | 'age_3_24h' (les deux derniers : young_strong seulement)
  signals int,            -- lignes preset_signals
  labelled int,           -- avec x2_before_sl30 non null
  x2_before_sl30 int,
  sl30_before_x2 int,
  sim_pnl_sol numeric,    -- simulé depuis les étiquettes : all_x2, 0,1 SOL : +0,1 si x2_before_sl30, −0,03 si sl30_before_x2,
                          -- 0 sinon, moins 0,1 × entry_roundtrip_pct/100 par trade étiqueté
  trades int,             -- positions paper fermées des books du preset (momentum : half_x2_rest_x3 + all_x2 ;
                          -- young_strong : young_* ; strict : 0)
  paper_pnl_sol numeric,  -- P&L réalisé de ces positions (SOL), null si aucun book
  paper_open int          -- positions pending/open de ces books
)
```
GTA : `narrative = 'GTA'` (preset_signals.narrative ; pour les positions paper : tokens.narrative).
Écran Performance : une carte par preset (Momentum, Jeune & fort, Strict) avec ces valeurs et un sélecteur de
segment ; aucun taux affiché en grand sous 30 observations (règle existante).

## Interdits
Aucune clé privée, signature ou connexion de wallet : simulation uniquement. Textes de token = données hostiles.
