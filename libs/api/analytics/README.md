# api-analytics

Accès Google de l'espace admin (PROMPT.md §4.7, docs/ARCHITECTURE.md §14.6), sans SDK Google.

- **Compte de service** (`GOOGLE_SERVICE_ACCOUNT_JSON`, brut ou base64) : JWT RS256 signé avec `node:crypto`, échangé
  sur `https://oauth2.googleapis.com/token`, jeton gardé en mémoire ; portées `analytics.readonly` et
  `webmasters.readonly` uniquement.
- **GA4 Data API** : `POST https://analyticsdata.googleapis.com/v1beta/properties/{id}:batchRunReports` (2 lots de 5
  rapports au plus) → `AdminTrafficData`.
- **Search Console** : `POST https://searchconsole.googleapis.com/webmasters/v3/sites/{site}/searchAnalytics/query`
  (`dataState: final`, 5 requêtes) → `AdminSeoData` (fenêtre alignée sur le dernier jour publié, décalage affiché).
- **Cache Redis** `analytics:v1:<service>:<sha256>` 1 h (`ANALYTICS_CACHE_TTL_S`), erreurs 5 min ; entrées revalidées
  par les contrats à la lecture.
- **États** : `not_connected` sans compte ou sans propriété (jamais de 5xx), `error` (`auth_failed`,
  `permission_denied`, `quota_exceeded`, `unavailable`) ; journaux : service + code seulement.
- **Simulation** `ANALYTICS_PROVIDER=fake` (dev, e2e ; refusée en production) : `src/testing/fixtures/fake-reports.ts`,
  données déterministes marquées `simulated: true`.
- `RedisUsageCounterStore` : stockage Redis des compteurs d'appels des sources Solana (port `UsageCounterStore` de
  `api-solana`), branché dans `api-analysis`.

Tests : `pnpm nx test api-analytics`.
