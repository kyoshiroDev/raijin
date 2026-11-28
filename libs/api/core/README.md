# api-core

Socle transverse de l'API Raijin : configuration (variables d'environnement validées par Zod), filtre d'erreurs {code, message}, Helmet, CORS, throttler, garde CSRF, cookies de session. Rempli par nestjs-api en phase 2 (voir docs/ARCHITECTURE.md §8).

Tags : `scope:api`. Commandes : `pnpm nx run-many -t lint typecheck test build -p api-core`.
