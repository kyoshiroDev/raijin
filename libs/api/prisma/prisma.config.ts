/**
 * Configuration de la CLI Prisma (Prisma 7) pour la base de l'API Raijin.
 * DATABASE_URL vient uniquement de l'environnement ; la valeur de repli (factice, non secrète)
 * pointe vers le Postgres local de docker-compose.dev.yml (port hôte 5433) et suffit à
 * `prisma generate` (qui ne se connecte pas), notamment en CI.
 */
import { defineConfig } from 'prisma/config';

const FALLBACK_DEV_URL = 'postgresql://raijin:changeme-factice@localhost:5433/raijin?schema=public';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node -r @swc-node/register prisma/seed.ts',
  },
  datasource: {
    url: process.env['DATABASE_URL'] || FALLBACK_DEV_URL,
  },
});
