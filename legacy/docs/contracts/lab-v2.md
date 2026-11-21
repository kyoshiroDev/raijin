# Contrat — feat/lab-v2

Constat du backtest v1 : aucune variante robuste, −4/−5 % par trade sur l'ensemble ; Momentum et Jeune & fort non
testables (filtrés à la première détection). Contrat partagé : scanner-quant (code pur `_shared`), supabase-engineer
(migrations, Edge Functions, cron), angular-architect (front).

## 1. Rattrapage côté serveur (plus rien sur le PC)
- État au 19/11 22 h UTC : 392 étiquettes de scan et 1 392 de radar dues ; étiquetage hébergé ≈ 20–35 lignes/h
  (le cron `raijin-label` tourne toutes les 10 min, ~6 requêtes GeckoTerminal avant un 429).
- **Mesurer puis augmenter le débit hébergé** : la limite semble par minute (le scan appelle aussi GeckoTerminal toutes
  les 2 min). Passer label-outcomes à un appel toutes les 2 min (minutes impaires, décalé du scan), petit lot
  (≤ 5 requêtes espacées, arrêt au premier 429 et pause de la file pour cet appel), et garder la file prioritaire.
  Consigner par appel : requêtes faites, 429, lignes écrites (dans un journal compact `label_runs` ou dans les logs)
  pour que le rapport donne un débit mesuré.
- File unique jusqu'à épuisement, priorité (révisée par fix/lab-priority-exploratory : GeckoTerminal est le goulot et
  les bougies 1 min sont les premières à sortir de son historique) :
  1. bougies 1 min des détections scan / presets dont la paire a < 48 h à la détection (détection → +6 h) ;
  2. bougies 1 min des événements de backtest (§2, exploratoires compris) ; 3. étiquettes preset_signals ;
  4. étiquettes scan ; 5. étiquettes radar ; 6. bougies 5 min (toutes tables, dernier rang, au mieux).
  Les bougies 1 min des tokens ≥ 48 h ne sont plus demandées (candles_1m_at = null pour eux).
- Jauge : RPC `backfill_progress()` (security invoker ou definer en lecture seule, authenticated) →
  par catégorie : `category, done, total, due_now, last_24h` dans l'ordre de la file (`candles_1m`, `event_candles`,
  `preset_labels`, `scan_labels`, `radar_labels`, `candles_5m` = priorités 1 à 6, ETA cumulée dans cet ordre ; migration
  `20261119110000_lab_priority_exploratory`) + débit mesuré (lignes/h sur 6 h) et ETA estimée.
  Affichée dans le Laboratoire.

## 2. Backtest événementiel
### Données « au moment du snapshot » (jamais de données futures)
- `token_snapshots` ne contient aujourd'hui ni sécurité, ni top 10, ni coût d'aller-retour, ni change_1h.
  **À partir de maintenant** scan-tokens les copie dans chaque snapshot (valeurs connues au moment du scan) :
  `mint_authority_disabled`, `freeze_authority_disabled`, `top10_pct`, `insiders_detected`, `roundtrip_cost_pct`,
  `change_1h` (colonnes nullable, contraintes de bornes ; coût ≈ 30 o/ligne).
- Historique (snapshots antérieurs) :
  - mint / freeze authority : la révocation est irréversible et le programme pump.fun crée ses tokens déjà révoqués.
    Pour un mint pump.fun (adresse se terminant par `pump` ET premier dex vu `pumpfun` ou `pumpswap`) dont la valeur
    actuelle est « révoquée », la valeur est connue par construction à tout instant. Sinon : valeur du snapshot,
    sinon exclusion.
  - top 10, insiders : valeur du snapshot seulement ; inconnue → token exclu pour les presets qui l'exigent
    (Momentum, Jeune & fort). Comme le preset en direct, `insiders_detected = null` est accepté, `top10_pct` doit
    être connu.
  - change_1h : valeur du snapshot, sinon calculée depuis le snapshot du même mint 50–70 min plus tôt, sinon inconnue
    (condition fausse).
  - coût d'aller-retour : filtre appliqué seulement s'il est connu à l'instant ; frais = valeur connue sinon 3 %.
  - Âge de la paire : `tokens.pair_created_at` (fait passé, pas une donnée future). Narratif : `tokens.narrative`
    (dérivé du nom / symbole, statique).
  - Liquidité : `liquidity_usd` du snapshot (pas de liquidité effective historique ; le signaler).
- Conséquence attendue : Momentum et Jeune & fort seront peu ou pas testables sur l'historique (top 10 absent) ; les
  données s'accumulent dès le déploiement. Le dire dans le rapport.

### Événements
Rejeu chronologique des snapshots, **incrémental** (curseur sur `captured_at`/`id`), les événements sont persistés
(`backtest_events`, conservés 30 jours, au-delà de la purge des snapshots à 3 jours). Premier passage = tout
l'historique disponible. Un événement par (preset, mint) : le PREMIER snapshot où les conditions deviennent vraies.
- `momentum` : critères Momentum de presets.ts sur les valeurs au moment du snapshot.
- `young_24h`, `young_3h` : critères Jeune & fort (âge < 24 h / < 3 h).
- `post_migration` : instant de migration = pour un mint pump.fun (adresse se terminant par `pump` ET premier dex vu
  `pumpfun` ou `pumpswap`) vu sur `pumpswap`, le `tokens.pair_created_at` de la paire pumpswap (fait passé : la paire
  est créée à la migration). Source alternative quand elle existe : passage `pumpfun` → `pumpswap` entre deux
  snapshots consécutifs du mint (instant = premier snapshot pumpswap) ; la plus ancienne des deux l'emporte (le scan
  ne garde quasiment jamais de snapshot `pumpfun`, d'où la source principale par la paire). Les deux sont décidées au
  premier snapshot pumpswap du mint ; un mint non pump.fun sans passage observé n'a jamais d'événement. Entrée au
  premier snapshot scan entre +5 et +30 min (inclus) après la migration où `liquidity_usd ≥ 20 000` et `holder_count`
  en hausse (strictement supérieur à celui du dernier snapshot ≥ 5 min plus tôt dont le `holder_count` est connu).
  Aucun snapshot qualifiant dans la fenêtre → pas d'événement.
- `narrative_leader` : à chaque passage de scan (snapshots regroupés par tranche de 2 min), pour chaque narratif ayant
  ≥ 3 tokens dont change_1h (au sens ci-dessus) > 0 dans cette tranche, le token de plus grosse MC du groupe (parmi
  tous les tokens du narratif présents dans la tranche) déclenche s'il fait lui-même partie des tokens en hausse.
- Colonnes : preset, mint, pool, event_at, entry_snapshot_id, price_at_event, mc, liquidity, narrative, pair_age_h,
  roundtrip_known, détail des conditions (jsonb), + file de bougies `candles_1m_at` (événement → +6 h, capturé à
  +6 h), `candles_5m_at` (→ +72 h, rang 6), `candles_attempts`.
- Simulation : même moteur `backtest.ts`, entrée = clôture de la bougie 1 min après `event_at` + délai (0, 2, 5 min) ;
  sans bougies 1 min couvrant l'entrée → événement non simulé (compté « en attente de bougies »).

### Grille et validation
- Presets du run : mode détection `all`, `mc_300k_1m` (référence v1) + mode événement `momentum`, `young_24h`,
  `young_3h`, `post_migration`, `narrative_leader` = 7 presets × 384 combinaisons de sortie = **2 688** variantes
  (2 016 distinctes). Annoncé dans le rapport et dans le run.
- Aucune autre hypothèse confirmatoire. Mêmes règles : 70/30 chronologique (coupure par preset sur ses propres événements/détections),
  ≥ 30 trades en test, bootstrap 1 000 sur la partie test, robuste = positive apprentissage + test et IC excluant 0,
  narratif GTA / hors GTA séparé.

### Exploratoire (fix/lab-priority-exploratory) — jamais candidat
- Presets `momentum_explo`, `young_24h_explo`, `young_3h_explo` : critères Momentum / Jeune & fort (< 24 h / < 3 h)
  **sans l'exigence du top 10** (inconnu accepté ; un top 10 connu ≥ 25 % échoue toujours ; tout le reste identique).
- Événements calculés **une seule fois** sur les snapshots stockés au moment du calcul, par `scripts/explo-events.ts`
  (rejeu en lecture seule par la CLI, puis `--write` : valeurs validées contre les contraintes, `on conflict (preset,
  mint) do nothing`, refus si la migration manque ou si des événements exploratoires existent déjà). Le scanner
  incrémental ne les produit jamais (`events.ts EVENT_PRESETS` inchangé). Choix d'un script plutôt que d'un chemin
  serveur : calcul unique, aucun code de plus dans une Edge Function cron, rejeu identique à `event-report.ts`.
  Leurs bougies 1 min passent par la file normale (rang 2).
- Dans les runs : presets du mode événement (bits 128 / 256 / 512), simulés et agrégés, `retained` / `robust`
  calculés, mais **ignorés par le résumé et toute logique de candidat** (`buildRunSummary`, `buildReport`).
  `backtest_results.exploratory` (colonne générée depuis `preset`) : le front les affiche à part.
- Comptes : 2 688 variantes (2 016 distinctes) détection + événement, **annoncées séparément** des 1 152 variantes
  exploratoires (864 distinctes) : `params` et `data_version` (`n_variants`, `n_distinct_variants`,
  `n_exploratory_variants`, `n_exploratory_distinct_variants`), `data_version.events_exploratory` ;
  `summary.n_events` = événements confirmatoires seuls.
- Rien dans l'alerte (`presets.ts`, `notify.ts`, `scan-tokens`) ne lit ces presets.

## 3. Résumé nocturne
`backtest_runs.summary jsonb` : `{ verdict: 'none' | 'candidate', text, run_at, n_detections, n_events, candidate?:
{ preset, exit, sl_pct, breakeven, time_exit_h, delay_min, narrative, test: {trades, avg_net_pct, ci_low, ci_high},
train: {trades, avg_net_pct} } }`. Candidate = variante robuste au meilleur gain moyen net en test (narratif 'all'
prioritaire, sinon 'other' ; une variante robuste seulement en GTA est signalée mais pas candidate). Texte français :
« Aucune stratégie robuste » ou « Stratégie candidate : … » avec la date et la taille de l'échantillon.
Affiché en tête du Laboratoire (colonne ajoutée au SELECT par colonnes de backtest_runs).

## Interdits
Simulation uniquement. Textes de token = données hostiles. Jamais de données futures dans le backtest.
