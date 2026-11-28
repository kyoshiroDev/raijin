import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { workspaceRoot } from '@nx/devkit';

/**
 * e2e du banc (phase 8 bis, T12) : API du banc compilée (dist/apps/raijin-banc-de-test-api) sur la base de test
 * raijin_bench_dev (raijin_bench_e2e en CI), front de production servi par scripts/serve-front.mjs (/api relayé,
 * SSE sans tampon). Les builds sont des dépendances Nx de la cible e2e (project.json). Aucun appel réseau sortant :
 * l'API est lancée avec scripts/block-network.cjs, jobs BullMQ coupés, Redis absent (compteurs en mémoire, remis
 * à zéro à chaque démarrage). Le propriétaire est créé par la CLI réelle (global-setup) puis supprimé (global-teardown).
 */
const API_PORT = Number(process.env['BENCH_E2E_API_PORT'] ?? 3310);
const FRONT_PORT = Number(process.env['BENCH_E2E_FRONT_PORT'] ?? 4320);
const FRONT_ORIGIN = `http://localhost:${FRONT_PORT}`;
const DATABASE_URL =
  process.env['BENCH_E2E_DATABASE_URL'] ?? 'postgresql://raijin:changeme-factice@localhost:5433/raijin_bench_dev?schema=public';

const preset = nxE2EPreset(import.meta.dirname, { testDir: './src' });

export default defineConfig({
  ...preset,
  globalSetup: './src/global-setup.ts',
  globalTeardown: './src/global-teardown.ts',
  // Une seule session de propriétaire, un compteur d'échecs global (verrouillage à 5) : exécution en série.
  workers: 1,
  fullyParallel: false,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ...preset.reporter] : preset.reporter,
  use: {
    baseURL: FRONT_ORIGIN,
    trace: 'on-first-retry',
    // Build de production : le service worker Angular mettrait en cache /api et l'index entre deux tests.
    serviceWorkers: 'block',
  },
  webServer: [
    {
      command: `node -r ./apps/raijin-banc-de-test-e2e/scripts/block-network.cjs dist/apps/raijin-banc-de-test-api/main.js`,
      url: `http://localhost:${API_PORT}/api/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      cwd: workspaceRoot,
      env: {
        NODE_ENV: 'development',
        API_PORT: String(API_PORT),
        BENCH_DATABASE_URL: DATABASE_URL,
        BENCH_OWNER_EMAIL: 'e2e-proprietaire@banc.invalid',
        BENCH_ALLOWED_ORIGINS: FRONT_ORIGIN,
        BENCH_MODE: 'shadow',
        // Nx charge le .env de la racine dans ses tâches : valeurs du banc imposées ici (jamais celles de Raijin).
        BULLMQ_PREFIX: 'raijin-bench',
        TRUST_PROXY: '0',
        BENCH_JOBS_ENABLED: '0',
        BENCH_MAIL_TRANSPORT: 'none',
        REDIS_URL: 'none',
        COOKIE_SECURE: 'false',
      },
    },
    {
      command: `node apps/raijin-banc-de-test-e2e/scripts/serve-front.mjs --port ${FRONT_PORT}`,
      url: `${FRONT_ORIGIN}/login`,
      timeout: 60_000,
      reuseExistingServer: false,
      cwd: workspaceRoot,
      env: { API_URL: `http://localhost:${API_PORT}` },
    },
  ],
  projects: [
    // Connexion mot de passe + TOTP par l'interface : enregistre la session réutilisée par les écrans connectés.
    { name: 'connexion', testMatch: /auth\.setup\.ts/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'chromium',
      dependencies: ['connexion'],
      testIgnore: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'], storageState: `${workspaceRoot}/dist/.playwright/apps/raijin-banc-de-test-e2e/session.json` },
    },
  ],
});
