# api-analytics

Accès en lecture seule à Google Analytics 4 (Data API) et à Search Console, sans SDK (docs/ARCHITECTURE.md §14.6).
Sans compte de service configuré : état `not_connected`. `ANALYTICS_PROVIDER=fake` sert des fixtures (dev, e2e).

Tests : `pnpm nx test api-analytics`.
