/**
 * Configuration de la CLI Prisma (Prisma 7) pour la base du banc `raijin_bench`.
 * BENCH_DATABASE_URL vient uniquement de l'environnement (utilisateur `raijin_bench`, sans droit sur
 * `raijin`). La valeur de repli (factice, non secrète) pointe vers la base de dev `raijin_bench_dev` du
 * Postgres de docker-compose.dev.yml (port hôte 5433) et suffit à `prisma generate` (sans connexion).
 * BENCH_SHADOW_DATABASE_URL (facultatif) : base jetable pour `migrate dev` / `migrate diff --from-migrations`.
 */
import { defineConfig } from 'prisma/config';

const FALLBACK_DEV_URL =
  'postgresql://raijin:changeme-factice@localhost:5433/raijin_bench_dev?schema=public';
const shadowDatabaseUrl = process.env['BENCH_SHADOW_DATABASE_URL'];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env['BENCH_DATABASE_URL'] || FALLBACK_DEV_URL,
    ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
  },
});
