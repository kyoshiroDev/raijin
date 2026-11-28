# Contrat — feat/young-calm

Stratégie retenue : vente à ×2, stop −30 %. Objectif : mieux trier les jeunes tokens.
Constat (utilisateur, 201 détections < 24 h étiquetées sur bougies) :
- « frénésie » (change1h > 150 % ou ratio achats/ventes 1 h > 1,3) : 26 % de ×2 avant stop, ≈ −1 % par trade ;
- « calme » (ratio ≤ 1,3 et change1h entre 0 et 100 %) : 35–36 % de ×2 avant stop, ≈ +11 % par trade ;
  42 % sur les données depuis le 18/11.

Ratio achats/ventes 1 h = `(buys_1h + 1) / (sells_1h + 1)` — la définition de `features.buy_sell_ratio_1h` et de
`scoring.ts ratio()`, celle sur laquelle les chiffres ont été mesurés. buys/sells inconnus → ratio inconnu → rejet.

## 1. Preset d'alerte `young_calm` — « Jeune calme » (nouveau preset principal par défaut)
Toutes les conditions (inconnu → rejet, sauf mention) :
- paire < 24 h (`pair_created_at`) ; `dex_id = 'pumpswap'` ;
- 0 ≤ change1h ≤ 100 (%) ; 0,8 ≤ ratio ≤ 1,3 ;
- liquidité effective ≥ 30 000 $ (`liquidity_effective_usd`, sinon `liquidity_usd`, comme `effectiveLiquidity`) ;
- coût d'aller-retour < 5 % ;
- mint ET freeze authority désactivées ; top10 < 25 % ; `insiders_detected !== true` ; `creator_rug_history !== true` ;
- LP verrouillée **si connue** : `lp_locked_pct` null → accepté ; connu → doit être ≥ 90 % (LP pumpswap brûlée à la
  migration) — le rejeu rapporte combien de candidats ce seuil écarte.
- `alert_settings.alert_preset` accepte `'young_calm'` ; nouvelle valeur par défaut de la colonne ; les utilisateurs
  actuellement sur `'momentum'` (ancien défaut) passent à `'young_calm'` ; `'strict'` reste inchangé. Momentum reste
  sélectionnable.
- Pipeline d'alerte du flux principal (comme Momentum) : persistance 2 scans, dédup 12 h, plafonds 4/h – 30/j,
  plan de sortie ×2 / ×0,7. Le flux « Jeune & fort » (interrupteur séparé) est inchangé.

## 2. Preset témoin `young_frenzy` — « Jeune frénésie »
Mêmes conditions que `young_calm` (âge, dex, liquidité, coût, sécurité, LP) SAUF le momentum, remplacé par :
change1h > 150 **ou** ratio > 1,3. **Aucune alerte, jamais.** Auto-paper uniquement.

## 3. Auto-paper Calme / Frénésie (comparaison à conditions égales)
- Deux nouveaux books : `calm_all_x2` (« Calme ») et `frenzy_all_x2` (« Frénésie »), portefeuilles séparés 1,0 SOL.
- Stratégie unique `all_x2`, SL 30 %, 0,1 SOL, `entry_mode = 'next_tick'` (prix du scan suivant).
- Déclenchement : à chaque scan, pour chaque token qui satisfait le preset, pour chaque utilisateur avec
  `auto_paper = true` — **indépendamment des alertes** (ni plafonds, ni heures calmes, ni persistance), pour que les
  deux books soient comparables.
- Une seule position par (book, token), pour toujours (pas de réouverture). Le cooldown 12 h après stop existant
  s'applique aussi.
- Les alertes `young_calm` n'ouvrent plus les books parallèles Momentum pour ce preset (le book Calme suffit).
- `preset_signals` : presets `young_calm` et `young_frenzy` (première correspondance, étiquetage OHLCV inchangé).

## 4. Score des jeunes tokens (< 24 h)
- Pression acheteuse : au-delà d'un ratio de 1,3, plus aucun point supplémentaire (les points au ratio 1,3 sont le
  maximum pour un token < 24 h).
- change1h > 150 % : pénalité (nouvelle constante dans `PENALTIES`, ex. 10 points) pour les tokens < 24 h.
- Tokens ≥ 24 h ou âge inconnu : score inchangé.
- `docs/ARCHITECTURE.md` (§ Scoring) documente le changement avec les chiffres ci-dessus. Tests mis à jour.

## 5. Backtest
- 4 nouveaux presets : `young_calm` et `young_frenzy` en mode détection (valeurs à la détection :
  `signal_outcomes.features` change_1h / buy_sell_ratio_1h / log_age_h, `entry_*` ; sécurité non disponible
  historiquement → ignorée et signalée, comme v1), et `young_calm_ev` / `young_frenzy_ev` en mode événement
  (valeurs au moment du snapshot ; sécurité selon les règles lab-v2 ; ratio et liquidité effective doivent être
  connus au snapshot → nouvelles colonnes point-in-time `buys_1h`, `sells_1h`, `liquidity_effective_usd`,
  `lp_locked_pct` sur `token_snapshots`, écrites par scan-tokens dès le déploiement).
- Grille restreinte pour ces 4 presets : `all_x2` × SL {30, 40, 50} × pas de breakeven × pas de sortie temporelle ×
  délai {0, 2, 5} = 9 variantes par preset, **36** au total (annoncé séparément du reste de la grille).
- Mêmes règles anti-hasard (70/30 par preset, ≥ 30 trades en test, bootstrap, GTA / hors GTA).

## 6. Performance — carte « Calme vs Frénésie »
`performance_by_preset()` gagne les presets `young_calm` (books : calm_all_x2) et `young_frenzy`
(books : frenzy_all_x2). Carte comparative côte à côte : signaux étiquetés, ×2 avant stop, stop avant ×2 (taux +
effectifs, règle des 30 observations), trades virtuels, P&L virtuel réalisé en SOL, positions ouvertes, et
segments GTA / hors GTA.

## 7. Rapport
Nombre de candidats « Jeune calme » par jour sur les 48 dernières heures (rejeu à la détection avec les données
disponibles ; préciser ce qui manque historiquement, ex. sécurité / ratio dans les snapshots).

## Interdits
Simulation uniquement. Textes de token = données hostiles. Jamais de données futures dans le backtest.
