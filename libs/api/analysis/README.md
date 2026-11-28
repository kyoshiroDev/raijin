# api-analysis

Module Nest de l'analyse de token (phase 3) : endpoint `/api/v1/analyses`, cache Redis 60 s par
mint avec déduplication des analyses concurrentes, persistance `TokenAnalysis`, quotas simples
(anonyme par `ipHash`, Gratuit 5/jour), page publique `/t/<mint>` (lecture de la dernière
analyse) et image Open Graph 1200×630.

Il orchestre `@raijin/api-solana` (collecte des faits) et `@raijin/shared-risk-engine` (verdict
pur) ; contrats dans `@raijin/shared-contracts` (`analysis/`). Voir `docs/ARCHITECTURE.md` §9.
