# api-wallet

Module Nest du scan de wallet en lecture seule (phase 5) : `POST /api/v1/wallet-scans` (Pro et essai
Pro uniquement), `GET /api/v1/wallet-scans/quota`. Aucune connexion de wallet, aucune signature :
l'utilisateur colle une adresse publique.

Il orchestre `@raijin/api-solana` (comptes de tokens, délégations, faits `light` par lot) et
`@raijin/shared-risk-engine` (verdict pur), réutilise le cache des analyses par mint, et ne persiste
aucune adresse de wallet (cache Redis court seulement). Contrats dans `@raijin/shared-contracts`
(`wallet/`). Voir `docs/ARCHITECTURE.md` §12.
