# api-solana (`@raijin/api-solana`)

Intégrations de données Solana en **lecture seule** (`scope:solana`, `type:data-access`), partagées par l'API Raijin
et le banc de test. Aucune transaction n'est construite, signée ni envoyée : Jupiter est appelé pour un **devis** de vente.

## Utilisation

```ts
const { config, heliusApiKey } = loadSolanaDataConfig(process.env);
const solana = new SolanaDataService({ config, heliusApiKey, cache, creditBudget, logger });
const { mint } = await solana.resolveToken(address);            // lien de paire DexScreener → mint
const collected = await solana.collectFacts(mint, { profile: 'full' }); // 'light' pour le scan de wallet
// collected.facts (RiskFacts v1) → evaluateRisk(...) de @raijin/shared-risk-engine
```

Nest : `ApiSolanaModule.forRoot(options)` / `forRootAsync({ inject, useFactory })` exportent `SolanaDataService`
(une instance par processus : files de débit et disjoncteurs partagés). Ports à fournir par l'hôte : `CacheStore`
(Redis), `CreditBudget` (compteur journalier Redis), `SolanaLogger` ; replis mémoire par défaut.

`collectFacts` ne lève que `TokenNotFoundError` (mint inexistant ou compte qui n'est pas un mint) ou
`TokenUnanalyzableError` (`TOKEN_UNANALYZABLE` : réponse de plus de 2 Mo ; sans lire le compte on ne peut pas savoir à
coût nul si c'est un mint Token-2022 volumineux ou un autre compte, les deux donnent cette erreur) ; toute panne de
source donne un groupe de faits `null` (contrôle « indisponible »), `degraded: true` et un statut par source. Seule
`UpstreamError` (lecture du mint impossible) peut aussi remonter.

### Suivis (phase 4, voie de crédits `watch`)

```ts
const authorities = await solana.collectAuthoritiesBatch(mints);      // lots de 100, 1 crédit ; ok | not_found | unanalyzable | unavailable
const pools = await solana.collectPoolsBatch(mints, { [mint]: snapshot.pool?.address }); // DexScreener, lots de 30
const holders = await solana.collectHolders(mint, { supply, excludeAddresses: [poolAddress] }); // top 20, null si indisponible
const full = await solana.collectFacts(mint, { profile: 'full', lane: 'watch' });
// → mergeWatchSnapshot / detectWatchEvents de @raijin/shared-risk-engine (docs/SCORING.md §8)
```

Aucune de ces fonctions ne lève : une panne donne un groupe `null` (jamais de fausse alerte). `CreditBudget.tryConsume(
credits, lane)` est appelé à **chaque tentative** (rejeux compris) ; `MemoryCreditBudget(global, clock, { watch })`
applique le plafond de voie (`WATCH_DAILY_CREDIT_BUDGET`, 12 000 par défaut), compté aussi dans le global. Une réponse
`too_large` n'ouvre pas le disjoncteur (propriété du compte, pas une panne).

## Sources et limites (vérifiées le 22/11/2026)

| Source | Routes | Limite retenue (configurable) | Doc |
|---|---|---|---|
| Helius RPC | `getAccountInfo`, `getTokenLargestAccounts`, `getMultipleAccounts`, `getSignaturesForAddress` | 7 req/s (Free : 10 partagés avec le banc), 1 crédit | https://www.helius.dev/docs/billing/rate-limits |
| Helius DAS | `getAsset` | 1,5 req/s (Free : 2), 10 crédits | https://www.helius.dev/docs/billing/credits |
| RPC public | mêmes méthodes RPC (sans clé) | 1 req/s ; `getTokenLargestAccounts` refusé (429) | https://solana.com/docs/references/clusters |
| DexScreener | `token-pairs/v1/solana/{mint}`, `latest/dex/pairs/solana/{pairs}`, `tokens/v1/solana/{mints}` (≤ 30, une paire principale par token, réserves `liquidity.base/quote`) | 4 req/s (doc : 300/min) | https://docs.dexscreener.com/api/reference |
| GeckoTerminal | `networks/solana/tokens/{mint}/pools` | 10/min | https://www.geckoterminal.com/dex-api |
| Jupiter | `lite-api.jup.ag/swap/v1/quote` | 0,5 req/s (sans clé : 30/min) | https://developers.jup.ag/docs/api-rate-limit |
| RugCheck | `tokens/{mint}/report` (repli `report/summary` au-delà de 2 Mo) | 1 req/s (non documentée) | https://api.rugcheck.xyz/swagger/index.html |

Chaque source passe par une `UpstreamGate` (seau à jetons, file FIFO bornée, 2 tentatives avec backoff + gigue,
`Retry-After` ≤ 2 s, disjoncteur 5 échecs → 30 s), un délai par appel (3 s, Jupiter 4 s), `redirect: 'error'`, 2 Mo
max, `content-type` JSON exigé, et une validation Zod élément par élément (données hostiles). Échéance globale 8 s.

## Sécurité

- L'URL Helius (qui contient la clé) est construite au moment de l'appel ; journaux limités à source, méthode,
  statut, latence ; erreurs réemballées en `UpstreamError(source, kind)` **sans `cause`** (`key-leak.spec.ts`).
- Textes externes (nom, symbole, libellés RugCheck) nettoyés par `sanitizeUntrustedText` dès la collecte ; liens de
  sources construits par Raijin (`sourceRef`) et validés par la liste blanche du contrat ; URI de métadonnées jamais suivies.

## Fixtures et tests

`src/fixtures/<source>/<scénario>.json` (`{ recordedAt, source, request, status, body }`, ni URL ni en-tête), rejouées
par `src/lib/testing/fixture-fetch.ts` : **aucun appel réseau en test**. Enregistrement manuel :
`pnpm nx run api-solana:record-fixtures [-- bonk usdc …] [--source=dexscreener]` (lit `HELIUS_API_KEY` dans
l'environnement du processus sans l'afficher). Fixtures `synthetic: true` : construites d'après la doc officielle
(Helius DAS, sans clé à l'enregistrement) ou dérivées d'un enregistrement réel (LP retirée, frais Token-2022, 500).
Couverture imposée : 80 % (lignes, branches, fonctions, instructions).

Séquences (transitions des suivis) : `src/fixtures/<source>/<scénario>.step<N>[.<détail>].json`, exclues de
`loadAllFixtures`, rejouées par `createFixtureSequence(scénario)` (`advance()`, `goTo(n)` ; à l'étape N, la fixture de
l'étape la plus récente ≤ N qui connaît la requête, sinon les fixtures de base). Scénarios synthétiques :
`watch-lp-removed` (swap puis retrait de 75 %), `watch-mint-reactivated` (mint puis freeze réactivés ; verdict Prudence →
Danger par `collectFacts`), `watch-holder-sold` (holder de 10 % qui cède 40 %).
