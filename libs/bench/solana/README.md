# bench-solana (`@raijin/bench-solana`)

Intégrations Solana du banc (docs/ARCHITECTURE.md §17.5, docs/BENCH.md §9 P1 et P6, docs/ENV.md « Banc »).
Lecture seule : aucune transaction construite, signée ni envoyée.

- `createBenchSolana({ env, redis })` : `SolanaDataService` (`@raijin/api-solana`) avec la clé `BENCH_HELIUS_API_KEY`
  (jamais `HELIUS_API_KEY`), 3 req/s RPC, 0,5 req/s DAS, 10 000 crédits/jour UTC (`PrefixedRedisCreditBudget`,
  clés `raijin-bench:helius:credits:*`), cache `raijin-bench:solana:*`. Redis absent : mémoire.
- Sources à IP partagée avec Raijin : moitié des débits de Raijin et `PublicSourceBackoff` (pause dès le 1er 429,
  puis 30 s, 60 s… 15 min ; refus sans requête `circuit_open`).
- `walletStudy` (`BenchWalletStudySource`) : pages `getTransactionsForAddress` (10 crédits, voie `wallet` plafonnée
  par `BENCH_WALLET_STUDY_DAILY_CREDITS`) ; résultat `ok` ou `unavailable` (`not_configured`, `method_unavailable`,
  `budget_exhausted`, `upstream`) ; méthode absente de l'offre : désactivation jusqu'au jour UTC suivant, partagée
  via Redis, signalée par `health()` (`wallet_study` de `GET /api/status`).

Tests : `pnpm nx test bench-solana` (Redis et `fetch` simulés, aucun appel réseau).
