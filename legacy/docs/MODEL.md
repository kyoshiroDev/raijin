# Modèle « ×3 minimum »

Objectif : remplacer les poids intuitifs du score par des poids **mesurés** sur nos propres détections, avec une cible explicite : le token fait-il **×3 au moins dans les 7 jours** suivant sa première détection, et touche-t-il **−50 % avant** ?

> Honnêteté avant tout : la grande majorité des memecoins finissent à zéro. Le modèle **classe des probabilités** à partir du passé ; il ne prédit rien et ne constitue pas un conseil financier. Les drapeaux rouges restent affichés quelle que soit la probabilité.

Contrat partagé : `supabase/functions/_shared/x3-types.ts` (`FEATURE_NAMES`, `FeatureVector`, `OutcomeLabel`, `LogisticModel`, `ModelWeights`, `MIN_LABELLED_FOR_CALIBRATION = 150`).

| Module (pur, testé) | Rôle | Tests |
|---|---|---|
| `_shared/features.ts` | calcul des variables | `features_test.ts` |
| `_shared/outcomes.ts` | étiquetage à partir des bougies | `outcomes_test.ts` |
| `_shared/model.ts` | prédiction, validation des poids, politique « calibré », R/R | `model_test.ts` |
| `scripts/calibrate.ts` | entraînement hors ligne + SQL des poids | `scripts/calibrate_test.ts` |

Tests : `node --experimental-strip-types --no-warnings --test supabase/functions/_shared/*_test.ts scripts/calibrate_test.ts` (ou `deno test`).

---

## 1. Variables (features)

Toutes calculées **au moment de la première détection** par `buildFeatureVector(input)`. Inconnu → `null` (le modèle remplace `null` par la moyenne d'entraînement). Valeur non finie → `null`. Toute valeur non nulle est ensuite **bornée** (`FEATURE_CLAMPS`) pour qu'une donnée aberrante (API, token absurde) ne domine pas. Les logarithmes sont tous `ln(1 + x)` (x < 0 → `null`), y compris `log_mc` et `log_liq_eff` (écart négligeable avec `ln(x)` au-delà de 1 k$).

| Variable | Définition | Source | Unité | Bornes |
|---|---|---|---|---|
| `score` | score heuristique final | `finalScore` | 0–100 | 0–100 |
| `log_mc` | ln(1 + market cap) | DexScreener | ln $ | 0–30 |
| `log_liq_eff` | ln(1 + liquidité effective) | médiane DexScreener / GeckoTerminal | ln $ | 0–30 |
| `liq_mc_ratio` | liquidité effective / MC (MC > 0) | idem | fraction | 0–5 |
| `roundtrip_cost_pct` | coût d'aller-retour 0,1 SOL | Jupiter | % | 0–100 |
| `zone_in`, `zone_wait`, `zone_deep`, `zone_broken` | one-hot de `zone_status` (`none` → tous 0 ; inconnu → `null`) | Fib | 0/1 | |
| `zone_from_candles` | 1 si `zone_source = candles`, 0 si `approx` | Fib | 0/1 | |
| `change_1h`, `change_6h`, `change_24h` | variations de prix | DexScreener | % | −100 à 1000 |
| `buy_sell_ratio_1h` | (achats + 1) / (ventes + 1) | DexScreener | ratio | 0–20 |
| `log_age_h` | ln(1 + âge en heures) | `pairCreatedAt` | ln h | 0–12 |
| `holder_growth_1h`, `holder_growth_6h` | `holderGrowth()` (voir ci-dessous), sinon `holderGrowthFromJup()` | Jupiter `holderCount` (snapshots), sinon `stats1h` / `stats6h.holderChange` de l'audit Jupiter du scan (feat/calm-sl-test) | fraction (0,1 = +10 %) | −1 à 10 |
| `volume_accel` | `volumeAccel(vol1h, vol24h)` = vol1h / (vol24h / 24) ; `null` si vol24h ≤ 0 | DexScreener | ratio (1 = rythme moyen) | 0–50 |
| `migrated_recently` | `migratedAtDetection()` | historique `dexId` des snapshots, sinon dex + mint (`…pump`) + âge de la paire (feat/calm-sl-test) | 0/1 | |
| `narrative_rank` | rang par MC dans le groupe de narratif (1 = plus grosse MC) ; 0 sans groupe | `narrativeRanks()` sur les tokens du scan | rang | 0–1000 |
| `narrative_size` | nombre de tokens du groupe ; 0 sans groupe | idem | nombre | 0–1000 |
| `organic_score` | score organique | Jupiter | 0–100 | 0–100 |
| `log_avg_trade_usd` | ln(1 + `avgTradeSizeUsd(vol1h, txns1h)`) ; `null` si txns ≤ 0 | DexScreener | ln $ | 0–20 |
| `rug_insiders` | 1 si RugCheck signale des insiders | RugCheck | 0/1 | |
| `rug_creator_bad` | 1 si RugCheck signale l'historique du créateur | RugCheck | 0/1 | |
| `lp_locked_pct` | part de LP verrouillée/brûlée | RugCheck | % | 0–100 |
| `sol_change_24h` | variation 24 h du SOL (contexte marché) | marché | % | −100 à 1000 |
| `log_scan_volume_24h` | ln(1 + volume 24 h total des tokens scannés) | scan | ln $ | 0–40 |

### Features vides à la détection (corrigé par feat/calm-sl-test)
Cause : `signal_outcomes.features` est figé à la **première vue** d'un mint (absent de `tokens` avant le scan). À cet
instant le scan n'a aucun snapshot de ce mint (donc ni croissance des holders ni migration observée : 0 snapshot avant
la détection sur 1 529 lignes) et `enrich-tokens` ne l'a jamais traité (il ne lit que `tokens`, une minute plus tard),
donc ni aller-retour ni LP. Mesuré le 21/11 : `holder_growth_1h/6h`, `lp_locked_pct`, `migrated_recently`,
`roundtrip_cost_pct` vides sur 100 % des lignes, alors que `tokens.features` (recalculé à chaque scan) les avait.
Correctif pour les nouvelles détections, sans donnée future :
- croissance des holders : historique si présent, sinon `holderChange` (%) de l'audit Jupiter du scan (`stats1h` /
  `stats6h`, valeur instantanée ; pour un token plus jeune que la fenêtre, c'est la variation depuis la création) ;
- `migrated_recently` : `migratedAtDetection()` — dex courant ni PumpSwap ni Raydium → 0 ; pumpfun vu dans l'historique
  des 24 h → 1 ; PumpSwap + mint pump.fun (`…pump`) → paire < 24 h (le pool PumpSwap d'un mint pump.fun **est** le pool de
  migration) ; autre mint → 0 ; Raydium + mint pump.fun sans historique → inconnu ;
- aller-retour et LP : **sonde de détection** du scan (`_shared/detection-probe.ts`) pour les premières détections dont
  la paire a < 24 h : résumé RugCheck (≤ 4, en parallèle des audits) et aller-retour Jupiter 0,1 SOL (≤ 2, après les
  audits, même rythmeur). Valeurs mesurées pendant le scan de détection.
Rattrapage des lignes existantes : `supabase/sql/backfill_detection_features.sql` (à lancer après revue ; dry-run :
`backfill_detection_features_dryrun.sql`) — `migrated_recently` seulement (règle ci-dessus sur le dex, le mint et
`log_age_h` connus à la détection) ; aller-retour / LP seulement si un snapshot du scan de détection (ou antérieur) les
porte (0 ligne au 21/11) ; croissance des holders impossible (aucun snapshot antérieur, `holderChange` non stocké).

### Croissance des holders — `holderGrowth(now, history, windowH)`
`now.holders / ref.holders − 1`, où `ref` est le snapshot **antérieur** à `now` le plus proche de `now − windowH`, accepté seulement à **±30 %** de la fenêtre (1 h → entre 42 et 78 min ; 6 h → entre 4 h 12 et 7 h 48). Égalité de distance : le plus ancien. `null` si aucun snapshot ne convient ou si un nombre de holders est inconnu ou ≤ 0. Les horodatages acceptent epoch ms ou ISO.

### Migration — `migratedRecently(dexHistory, currentDexId, nowMs)`
Vrai si un snapshot avec `dexId === 'pumpfun'` existe dans `[now − 24 h, now]` **et** que la paire actuelle est `pumpswap` ou contient `raydium` (insensible à la casse).

### Narratifs — `narrativeOf(name, symbol)` et `NARRATIVE_RULES`
Le nom et le symbole sont des **données hostiles** : chacun est tronqué à 64 caractères (`NARRATIVE_MAX_INPUT`), normalisé NFKD (lettres pleine chasse → ASCII, accents séparés puis supprimés), découpé aux frontières camelCase et lettres/chiffres (`BabyDoge` → `baby doge`, `GTA6` → `gta 6`), mis en minuscules, puis coupé en mots sur tout ce qui n'est pas `[a-z0-9]`. Seules des expressions régulières **fixes** sont utilisées : le texte n'est jamais interprété comme un motif.

Deux types de règles :
- **mots entiers** (`words`) : un mot normalisé doit être exactement égal (mots courts ou ambigus : `ai` ne matche pas « rain », `cat` pas « catalyst », `elon` pas « melon ») ;
- **sous-chaînes** (`substrings`) : recherchées dans la concaténation des mots (mots longs et non ambigus : `babydoge`, `grandtheft`).

Ordre de priorité : la **première** règle qui matche l'emporte.

| Priorité | Narratif | Mots entiers | Sous-chaînes |
|---|---|---|---|
| 1 | GTA | gta, vi, vice, jason, lucia, wasted | leonida, bawsaq, rockstar, grandtheft |
| 2 | AI | ai, agi, gpt, llm, agent, agents | deepseek, neural, chatgpt, openai |
| 3 | POLITICS | trump, maga, elon, musk, biden, kamala, melania, barron | trump, donald |
| 4 | DOG | dog, dogs, inu, doge, shib, wif, puppy | doge, shiba, bonk |
| 5 | CAT | cat, cats, mew, kitty, meow | kitty, kitten, meow, popcat |
| 6 | FROG | frog, pepe | pepe, frog |

`narrativeRanks(tokens)` classe par MC décroissante dans chaque groupe (MC inconnue en dernier, égalité départagée par le mint), ignore les tokens sans narratif et les mints en double. Pour `buildFeatureVector`, `narrative: null` = calculé mais sans groupe (0 / 0), absent = inconnu (`null`).

---

## 2. Étiquetage — `labelOutcome(entryPrice, detectedAtMs, candles, nowMs)`

Entrée = prix à la première détection ; bougies GeckoTerminal `[tsSec, o, h, l, c, v]`.

- **Bougies retenues** : ouverture ≥ détection, < détection + 7 jours, ≤ maintenant. Une bougie ouverte avant la détection est exclue (son plus haut/bas peut précéder l'entrée). L'ordre d'entrée n'importe pas ; les bougies invalides (non finies, bas ≤ 0, haut < bas) sont ignorées. Les **trous** (pas de bougie = pas d'échange) ne posent pas de problème.
- `hit_x2` / `hit_x3` / `hit_x5` : un plus haut ≥ N × entrée (tolérance relative 1e−9 pour le flottant : 0,1 → 0,3 compte comme ×3).
- `max_multiple_7d` = plus haut max / entrée (0 sans bougie).
- `hours_to_x3` = ouverture de la première bougie ×3 − détection (heures, ≥ 0). Granularité de la bougie : peut être en avance d'au plus une période.
- `dd50_first` : un plus bas ≤ 0,5 × entrée **avant** la bougie du premier ×3, **ou dans cette même bougie**, ou à n'importe quel moment si ×3 n'arrive jamais. **Même bougie touchant ×3 et −50 %** : l'ordre intra-bougie est inconnu → choix **conservateur** : `dd50_first = true` (et `hit_x3 = true`). Un −50 % **après** le ×3 ne compte pas. `dd50_first` est **tranché au premier des deux événements**.
- `observed_hours` = min(maintenant − détection, 168), ≥ 0.
- **Statut** :
  - `final` quand ×3 est atteint (alors `dd50_first` est tranché aussi) — `hit_x5` et `max_multiple_7d` sont alors des **bornes basses** (ce qui a été observé jusque-là) ;
  - `final` quand 168 h se sont écoulées **et** qu'au moins une bougie a été vue ;
  - sinon `pending`. Un −50 % seul ne rend **pas** l'étiquette finale : `dd50_first = true` est acquis mais `hit_x3` peut encore basculer pendant les 7 jours ;
  - **aucune bougie** : reste `pending` même après 7 jours (absence de données ≠ absence de mouvement) ; c'est à `label-outcomes` de décider quand abandonner la ligne ;
  - prix d'entrée ≤ 0 ou non fini : toujours `pending` avec des valeurs vides — à exclure par l'appelant.

---

## 3. Prédiction — `_shared/model.ts`

- `predict(model, x)` : z = (x − moyenne) / écart-type, borné à ±8 ; `null` → moyenne (z = 0) ; écart-type 0 → variable ignorée ; sigmoïde ; résultat borné à [0,001 ; 0,999].
- `parseModelWeights(json)` : validation stricte sans zod du `payload` lu dans `public.model_weights` ; renvoie une copie propre (clés inconnues ignorées) ou `null` (NaN/Infini, longueurs différentes de `features`, nom de variable inconnu ou en double, écart-type négatif, cible inconnue ou en double, taux hors [0, 1], `trained_at` illisible, aucun modèle).
- `isCalibrated(w, nLabelled)` : voir la politique ci-dessous.
- `riskReward(entry, invalidation, tp1)` = (tp1 − entrée) / (entrée − invalidation) ; `null` sauf si tout est fini, > 0 et invalidation < entrée < tp1.

### Politique « non calibré »
Les probabilités ne sont présentées comme **calibrées** que si `isCalibrated()` est vrai :
1. des poids valides existent (`parseModelWeights` non nul) ;
2. au moins **150** étiquettes `final` (`MIN_LABELLED_FOR_CALIBRATION`) ;
3. les **deux** modèles (`p_x3_7d` et `p_dd50_first`) sont présents ;
4. AUC ×3 sur le jeu de test ≥ **0,55** (`MIN_AUC_X3`).

Sinon l'UI affiche « non calibré » : le score heuristique reste la référence et aucune probabilité n'est présentée comme mesurée.

---

## 4. Calibration (hors ligne, `scripts/calibrate.ts`)

Le script ne se connecte à aucune base et ne contient aucun identifiant : il lit un fichier JSON et écrit un fichier SQL.

1. **Exporter** les étiquettes finales :
   ```bash
   npx supabase db query --remote -o json \
     "select features, hit_x3, dd50_first, detected_at from public.signal_outcomes where status = 'final' order by detected_at" \
     > export.json
   ```
   (Tableau JSON, ou objet `{ rows: [...] }`. `features` peut être un objet ou une chaîne JSON ; booléens `true/false` ou `t/f`. Les lignes invalides ou non finales sont comptées et ignorées.)
2. **Lancer** :
   ```bash
   node --experimental-strip-types --no-warnings scripts/calibrate.ts export.json --out weights.sql
   # Deno : deno run --allow-read --allow-write scripts/calibrate.ts export.json --out weights.sql
   ```
   Méthode : découpage **temporel** (70 % les plus anciennes = entraînement, 30 % les plus récentes = test, jamais de mélange pour éviter de regarder le futur) ; standardisation sur l'entraînement (même transformation que `predict`) ; régression logistique **L2** (λ = 0,01 sur la log-loss moyenne, intercept non pénalisé) par descente de gradient complète (3000 itérations, pas 0,5, initialisation déterministe) ; un modèle pour `hit_x3` et un pour `dd50_first`. Les poids émis sont ceux entraînés sur les 70 % : les métriques affichées correspondent exactement aux poids.
3. **Relire le rapport** (stdout, en français) : AUC ×3 et AUC −50 % sur le test (Mann-Whitney, 0,5 = hasard), taux de base ×3 contre taux ×3 du **top 10 %** des prédictions (lift), importance des variables (|coef| standardisé, AUC univariée sur l'entraînement, couverture = part de valeurs connues). Méfiance si une variable à faible couverture domine, ou si l'AUC test est très inférieure à l'AUC univariée de `score` seule.
4. **Appliquer** : `weights.sql` contient `insert into public.model_weights (version, trained_at, payload, active) values (…)` avec `active = false` et, en commentaire, l'`update` d'activation à lancer après relecture. Option `--activate` : transaction qui désactive les poids actifs puis insère les nouveaux actifs. Exécuter le fichier dans l'éditeur SQL Supabase (ou via la CLI, après vérification de la syntaxe de la version installée).

**Refus** : sous 150 lignes finales, le script affiche le rapport mais **n'écrit pas** le SQL (code de sortie 1). Une AUC ×3 < 0,55 n'empêche pas l'écriture mais le rapport l'annonce, et l'app restera « non calibré ».
