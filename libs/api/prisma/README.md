# api-prisma

Client Prisma (PostgreSQL 17) et schéma de données de l'API Raijin. Schéma : `libs/api/prisma/prisma/schema.prisma` ; client généré dans `src/generated/` (ignoré par Git) par la cible `prisma-generate`. Rempli par nestjs-api en phase 2 (voir docs/ARCHITECTURE.md §8).

Tags : `scope:api`. Commandes : `pnpm nx run-many -t lint typecheck test build -p api-prisma`.
