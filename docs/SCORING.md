# Scoring — moteur de verdict Raijin Shield

Moteur : `@raijin/shared-risk-engine` (`libs/shared/risk-engine`), version **1.0.0** (`RISK_ENGINE_VERSION`).
Entrée : `RiskFacts` v1 (`@raijin/shared-contracts`, `analysis/risk.ts`), produits par `collectFacts` de
`@raijin/api-solana`. Sortie : `RiskAssessment` (verdict, raisons, 9 contrôles dans l'ordre de `ANALYSIS_CHECK_IDS`).

Principes (PROMPT.md §4.1) :

- **Déterministe et pur** : mêmes faits → même sortie. Aucune I/O, aucune horloge : les âges sont calculés à partir de
  `facts.observedAt`. Pas de score opaque, pas d'« IA magique ».
- **Un seul contrôle critique suffit pour Danger** (mint actif, freeze actif, honeypot, LP retirée).
- **Signaux modérés → Prudence**, selon un poids configurable.
- **Sinon Sain**, toujours affiché avec le rappel « Aucun signal détecté ne veut pas dire sans risque »
  (`SAFE_VERDICT_REMINDER`) et la mention « pas un conseil en investissement » (`ANALYSIS_DISCLAIMER`).
- Lecture seule : le devis de vente est un **devis** Jupiter (`/quote`), jamais une transaction.

## 1. Verdict

Ordre d'évaluation (`decideVerdict`) :

| Étape | Condition | Verdict |
|---|---|---|
| V1 | Au moins une raison **critique** | **Danger** |
| V2 | Autorités mint/freeze inconnues (`mintAccount = null`, règle D1) | **Prudence** |
| V3 | `unavailableChecksBlockSafe` (3) contrôles indisponibles ou plus (règle D2) | **Prudence** |
| V4 | Somme des poids des signaux modérés ≥ `cautionScoreThreshold` (1) | **Prudence** |
| V5 | Sinon | **Sain** |

Statut d'un contrôle : `danger` s'il porte une raison critique, `warn` s'il porte un signal modéré, `ok` si ses données
sont présentes sans signal, `unavailable` (code `DATA_UNAVAILABLE`) si ses données manquent. Dans un contrôle, les raisons
critiques sont listées en premier ; la première raison donne la phrase affichée (`summarizeCheck`).

## 2. Règles par contrôle

Seuils par défaut (`DEFAULT_RISK_ENGINE_CONFIG`), tous modifiables via `createRiskEngine(config)`.

### 2.1 Autorité de mint — `mint_authority`

| Règle | Condition | Code | Statut | Critique |
|---|---|---|---|---|
| A1 | `mintAuthorityActive` (hors émetteur connu) | `MINT_AUTHORITY_ACTIVE` | danger | oui |
| A2 | `mintAuthorityActive` et mint dans `knownIssuerMints` | `MINT_AUTHORITY_ACTIVE` | warn | non |

Justification : une autorité de mint active permet de créer des tokens à volonté (dilution, vente massive). C'est le
premier critère critique de PROMPT.md. Les émetteurs régulés (USDC, USDT, PYUSD) gardent leur autorité de mint pour leur
activité normale d'émission : signal affiché, mais pas Danger.

### 2.2 Autorité de freeze — `freeze_authority`

| Règle | Condition | Code | Statut | Critique |
|---|---|---|---|---|
| F1 | `freezeAuthorityActive` (hors émetteur connu) | `FREEZE_AUTHORITY_ACTIVE` | danger | oui |
| F2 | `freezeAuthorityActive`, émetteur connu | `FREEZE_AUTHORITY_KNOWN_ISSUER` | warn (poids 0,5) | non |
| F3 | Extension Token-2022 `permanentDelegate` (hors émetteur connu) | `TOKEN2022_PERMANENT_DELEGATE` | danger | oui |
| F4 | `permanentDelegate`, émetteur connu | `TOKEN2022_PERMANENT_DELEGATE` | warn | non |

Justification : le freeze bloque les tokens dans le wallet du holder (piège classique). Le délégué permanent peut
transférer ou brûler les tokens de n'importe qui : c'est un pouvoir plus fort que le freeze, traité de la même façon.
Émetteurs connus (`KNOWN_ISSUER_MINTS`) : USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, USDT
`Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`, PYUSD `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` (freeze et délégué
exigés par leur réglementation, documentés publiquement). Poids 0,5 pour F2 seul ; avec A2 (poids 1), un stablecoin régulé
sort en **Prudence** : c'est voulu, l'émetteur peut effectivement geler des fonds.

### 2.3 Liquidité — `liquidity`

| Règle | Condition | Code | Statut | Critique |
|---|---|---|---|---|
| L1 | `lpRemoved = true` | `LIQUIDITY_REMOVED` | danger | oui |
| L2 | `usd < liquidityLowUsd` (10 000 USD) | `LIQUIDITY_LOW` | warn | non |
| L3 | `lpBurnedOrLockedPct < lpBurnedOrLockedMinPct` (50 %) **et** pool de moins de `lpLockCheckMaxPoolAgeDays` (30 j) ou d'âge inconnu | `LP_NOT_BURNED_OR_LOCKED` | warn | non |

L1 masque L2 et L3 (le pool est vide, le reste n'a plus de sens).

Collecte (`api-solana`) :

- `usd` = **médiane** des liquidités totales DexScreener (`token-pairs/v1`, 30 pools max) et GeckoTerminal (20 pools) ;
  une source sans valeur exploitable est écartée de la médiane ; aucun pool chez les deux → 0.
- `lpBurnedOrLockedPct` = RugCheck, marché principal (plus grosse liquidité) ; courbe de liaison pump.fun → 100 % (la
  liquidité appartient au programme, le créateur ne peut pas la retirer) ; rapport trop volumineux → valeur du résumé.
- `lpRemoved` = vrai si RugCheck déclare le token « rugged », ou si des pools existent mais que la liquidité médiane est
  sous `lpRemovedMaxUsd` (100 USD, configuration de `api-solana`).

Justification : la liquidité faible rend la revente coûteuse ; une LP non verrouillée peut être retirée d'un coup (rug).
L3 ne s'applique pas aux pools de plus de 30 jours : les pools concentrés (Orca Whirlpool, Meteora DLMM, Raydium CLMM)
n'ont pas de jeton LP à brûler, RugCheck les compte donc « non verrouillés » ; sur un pool ancien, ce critère signalait
à tort des tokens établis (constaté sur BONK : 22 % « verrouillé »).

### 2.4 Concentration — `holder_concentration`

| Règle | Condition | Code | Statut |
|---|---|---|---|
| H1 | `top10Pct > top10WarnPct` (30 %) | `TOP10_CONCENTRATION_HIGH` | warn |
| H2 | `maxSingleHolderPct > singleHolderWarnPct` (10 %) | `SINGLE_HOLDER_ABOVE_THRESHOLD` | warn |

Collecte : 20 plus gros comptes (`getTokenLargestAccounts`), propriétaires (`getMultipleAccounts`), puis programme de
chaque propriétaire. **Exclus** : coffres des marchés (RugCheck), adresses de pools (DexScreener, GeckoTerminal,
RugCheck), propriétaires appartenant à un programme AMM ou launchpad connu (Raydium, Orca, Meteora, pump.fun,
PumpSwap ; `KNOWN_AMM_PROGRAMS`), autorités de pools et adresse de brûlage (`KNOWN_EXCLUDED_OWNERS`). Parts agrégées par
propriétaire. Repli : top holders du rapport RugCheck (même règle d'exclusion). Les lockers de vesting ne sont **pas**
exclus (les tokens seront débloqués).

Justification : 10 % pour un seul wallet est le seuil de PROMPT.md ; 30 % pour le top 10 hors LP est un repère courant
des outils d'analyse de memecoins. Seuil strict (`>`) : exactement 10 % ne déclenche pas H2.

### 2.5 Revente possible — `sell_simulation`

| Règle | Condition | Code | Statut | Critique |
|---|---|---|---|---|
| S1 | `routeFound = false` | `SELL_NO_ROUTE` | danger | oui |
| S2 | `implicitTaxPct ≥ sellTaxCriticalPct` (50 %) | `SELL_TAX_HIGH` | danger | oui |
| S3 | `implicitTaxPct > sellTaxWarnPct` (10 %) | `SELL_TAX_HIGH` | warn | non |
| S4 | `priceImpactPct > priceImpactWarnPct` (5 %) | `SELL_PRICE_IMPACT_HIGH` | warn | non |
| S5 | Extension `nonTransferable` | `TOKEN2022_NON_TRANSFERABLE` | danger | oui |
| S6 | `transferFeeBps ≥ transferFeeCriticalBps` (5 000 = 50 %) | `TOKEN2022_TRANSFER_FEE` | danger | oui |
| S7 | `transferFeeBps > transferFeeWarnBps` (0) | `TOKEN2022_TRANSFER_FEE` | warn | non |
| S8 | Extension `transferHook` avec programme | `TOKEN2022_TRANSFER_HOOK` | warn | non |

S5 à S8 viennent du compte de mint : ils s'appliquent même si le devis est indisponible.

Collecte : devis Jupiter `GET /swap/v1/quote` (lite-api), token → USDC (USDC → SOL), montant ≈ `sellTestAmountUsd`
(100 USD) au prix médian DexScreener/GeckoTerminal (1 unité si aucun prix). `priceImpactPct` Jupiter est une fraction
(vérifié : 0,29 pour une vente de 100 000 USD de BONK) → × 100. Taxe implicite = `1 − reçu / (montant × (1 − impact))`,
bornée à [0, 100] ; non calculée sans prix de marché ou pour une sortie en SOL. Réponse Jupiter 400 `TOKEN_NOT_TRADABLE`,
`NO_ROUTES_FOUND`, `COULD_NOT_FIND_ANY_ROUTE` → `routeFound = false`. Frais Token-2022 : le plus élevé des deux barèmes
(`older`/`newer`), par prudence.

Justification : ne pas pouvoir revendre est le piège (honeypot) que l'utilisateur veut éviter ; une taxe de 50 % ou plus
équivaut à un honeypot. Un impact de plus de 5 % sur 100 USD signale un marché très mince.

### 2.6 Métadonnées modifiables — `metadata_mutable`

| Règle | Condition | Code | Statut |
|---|---|---|---|
| M1 | `mutable = true` | `METADATA_MUTABLE` | warn (poids 0,5) |

Collecte : Helius DAS `getAsset.mutable` ; sinon extension Token-2022 `tokenMetadata` (update authority présente) ; sinon
`tokenMeta.mutable` de RugCheck. Poids 0,5 : beaucoup de tokens sérieux gardent des métadonnées modifiables ; seul, ce
signal ne fait pas basculer en Prudence, mais il s'ajoute aux autres (usurpation de nom ou de logo possible).

### 2.7 Âge — `token_age`

| Règle | Condition | Code | Statut |
|---|---|---|---|
| T1 | Token plus jeune que `tokenVeryNewHours` (48 h) | `TOKEN_VERY_NEW` | warn |
| T2 | Pool principal plus jeune que `poolVeryNewHours` (24 h) | `POOL_VERY_NEW` | warn |

Une date future (horloge décalée ou donnée hostile) compte comme un âge nul. Collecte : plus ancienne signature du compte
de mint (3 pages de 1 000 au plus ; au-delà, date inconnue) ; pool principal = plus grosse liquidité DexScreener, sinon
GeckoTerminal. Justification : la grande majorité des rugs ont lieu dans les premières heures.

### 2.8 Historique du créateur — `creator_history`

| Règle | Condition | Code | Statut |
|---|---|---|---|
| C1 | `tokensDeadOrRugged ≥ creatorDeadTokensWarn` (2) | `CREATOR_MANY_DEAD_TOKENS` | warn |

Collecte : créateur et `creatorTokens` du rapport RugCheck complet (hors token analysé). Un token est compté « mort ou
rug » si sa capitalisation est sous `creatorDeadMarketCapUsd` (5 000 USD) **et** s'il a plus de `creatorDeadMinAgeHours`
(24 h), pour ne pas compter un lancement en cours. `CREATOR_PRIOR_RUGS` est **réservé** (v1 ne distingue pas un rug
d'un abandon).

### 2.9 Rapport RugCheck — `rugcheck`

| Règle | Condition | Code | Statut | Critique |
|---|---|---|---|---|
| R1 | `rugged = true` | `RUGCHECK_RUGGED` | danger | oui (équivaut à L1) |
| R2 | Au moins un risque de niveau `danger` | `RUGCHECK_DANGER` | warn | non |
| R3 | Sinon, au moins un risque `warn` | `RUGCHECK_WARN` | warn (poids 0,25) | non |

Source **complémentaire**, affichée comme telle : ses libellés (texte externe nettoyé, 80 caractères, 20 au plus) ne
sont jamais repris dans nos phrases. R2 et R3 restent modérés pour ne pas déléguer le verdict à un tiers ; R3 a un poids
faible car il recoupe souvent M1 (« Mutable metadata »).

## 3. Données manquantes

- **D1** : autorités inconnues (`mintAccount = null`) → jamais Sain. L'API vérifie `canIssueVerdict(facts)` et répond
  `UPSTREAM_UNAVAILABLE` plutôt que d'afficher un verdict incomplet sur deux des quatre critères critiques.
- **D2** : 3 contrôles indisponibles ou plus → jamais Sain (Prudence, phrase « Trop de contrôles n'ont pas pu être
  vérifiés pour conclure »).
- Un signal critique l'emporte toujours (Danger même avec des données manquantes).
- Un groupe de faits à `null` = source en panne, clé Helius absente ou profil `light` ; le contrôle passe en
  `unavailable` et le résultat est marqué `degraded`.

## 4. Pondération des signaux modérés

Poids par défaut 1, sauf `METADATA_MUTABLE` 0,5, `FREEZE_AUTHORITY_KNOWN_ISSUER` 0,5, `RUGCHECK_WARN` 0,25. Prudence dès
que la somme atteint 1. Un poids à 0 rend un signal purement informatif (le contrôle reste en `warn`).

## 5. Exemples (fixtures enregistrées le 22/11/2026)

| Token | Faits marquants | Verdict |
|---|---|---|
| BONK `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` | autorités révoquées, ~745 k USD de liquidité, impact 0,08 %, pool de 2022 | Sans clé Helius : concentration, métadonnées et créateur indisponibles → Prudence (D2) ; avec les 9 contrôles et ces valeurs → Sain |
| USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | mint + freeze actifs, émetteur régulé | Prudence (A2 + F2) |
| PYUSD `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | Token-2022, délégué permanent, frais 0 bps | Prudence (A2, F2, F4) |
| `BL7yQWfMeLesszudGL6TqnfWbieFMDTT1TFXzQWBazTi` | mint actif, aucun marché (Jupiter `TOKEN_NOT_TRADABLE`) | Danger (A1, S1) |
| `3Ss6A75uZG9cSRt4feyhcmJVGT38USeygDfwi1tBGQVa` | freeze actif, non échangeable | Danger (F1, S1) |
| `9rA3rJrcFJeQwWaLaHgJLi4LaF6wvRoae9ybwcYApump` | pump.fun de quelques minutes, ~1 700 USD de liquidité, créateur lanceur en série, RugCheck « Creator history of rugged tokens » | Prudence (L2, T1, T2, R2…) |
| Synthétique « LP retirée » | pool listé à 12 USD | Danger (L1) |

Les tests (`engine.spec.ts`, `describe.spec.ts`, `facts-collector.spec.ts`) rejouent ces scénarios ; couverture du
moteur imposée à 90 % (lignes, branches, fonctions, instructions).

## 6. Phrases

`REASON_SENTENCES` (une par code), `OK_SENTENCES` (une par contrôle sans signal) et `explainVerdict` : tutoiement, ton
factuel, aucune recommandation d'achat ou de vente, aucune promesse ; aucune donnée externe interpolée. `buildCheckMetrics`
fournit les valeurs chiffrées (USD, %, heures/jours, nombres, adresse du créateur) formatées côté front.

## 7. Limites connues

- **Courbe de liaison pump.fun** : Jupiter ne route pas toujours les tokens encore sur la courbe ; dans ce cas le devis
  est déclaré **indisponible** (et non honeypot), la revente passant par le programme pump.fun.
- **RPC public sans clé Helius** : `getTokenLargestAccounts` est refusé (429, constaté) → concentration via RugCheck si
  son rapport complet est disponible, sinon indisponible ; métadonnées d'un token SPL classique indisponibles (DAS requis).
- **Rapports RugCheck de plusieurs Mo** (tokens très actifs, 2,5 Mo pour BONK) : repli sur le résumé, sans créateur ni
  top holders ni drapeau « rugged ».
- **Taxe implicite** : estimée par écart au prix de marché DexScreener/GeckoTerminal, qui peut avoir quelques secondes de
  retard ; seuil d'alerte à 10 % pour absorber ce bruit.
- **Âge du token** inconnu pour les mints très actifs (plus de 3 000 signatures) : seul l'âge du pool est évalué.
- **LP « retirée »** déduite d'une liquidité résiduelle < 100 USD : un pool simplement abandonné est aussi signalé.
- **Historique du créateur** : dépend de RugCheck (créateur, capitalisations) ; `CREATOR_PRIOR_RUGS` non émis en v1.
- **Émetteurs connus** : liste fermée de 3 stablecoins ; tout autre token à freeze actif sort en Danger.
- Les seuils sont des points de départ : le banc (PROMPT.md §4.8) mesure précision et rappel et teste des variantes
  (`createRiskEngine({ version: '1.0.0-variante.a', … })`) avant toute modification, qui change la version du moteur.
