import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { getReadyUrl, workspaceRoot } from '@nx/devkit';

// For CI, you may want to set BASE_URL to the deployed application.
// getReadyUrl moves the address to the port the dev server task reported.
const baseURL = process.env['BASE_URL'] || getReadyUrl('http://localhost:4200');

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// import 'dotenv/config';

/**
 * See https://playwright.dev/docs/test-configuration.
 *
 * Generated as a .mts file so Node forces ESM regardless of workspace
 * `type`. Playwright routes `.mts` through its ESM loader (dynamic import,
 * bypassing the pirates CJS-compile path), and Nx's native TS strip loads
 * `.mts` directly. Playwright's configLoader auto-discovers
 * `playwright.config.mts` via its extension list
 * (.ts/.js/.mts/.mjs/.cts/.cjs).
 */
export default defineConfig({
  ...nxE2EPreset(import.meta.dirname, { testDir: './src' }),
  // CI : 1 worker (preset Nx). En local : 3 workers au plus, pour que le serveur de dev et axe
  // ne saturent pas la machine (timeouts aléatoires constatés avec le défaut de 50 % des cœurs).
  workers: process.env['CI'] ? 1 : 3,
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    baseURL,
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },
  // Serveurs de dev, y compris en CI : la page /_design (référence visuelle testée en responsive et par axe)
  // n'existe qu'en développement (retirée des builds de production).
  // L'API NestJS réelle sert les parcours d'auth (auth.flow.spec.ts) et les écrans de compte connecté.
  // Préalable : `pnpm nx run api:dev-infra` (Postgres 5433, Redis 6380, Mailpit 1026/8026, projet `raijin-dev`)
  // et `pnpm nx run api-prisma:migrate-deploy`. Si l'API tourne déjà, elle est réutilisée : la lancer alors avec
  // les mêmes variables que ci-dessous (JWT_ACCESS_TTL=20s pour tester l'expiration réelle du JWT, limites hautes
  // pour éviter les 429 sur une suite qui crée des dizaines de comptes depuis la même IP).
  webServer: [
    {
      command: 'pnpm exec nx run api:serve',
      timeout: 180_000,
      url: 'http://localhost:3100/api/v1/health',
      reuseExistingServer: true,
      cwd: workspaceRoot,
      env: {
        JWT_ACCESS_TTL: process.env['JWT_ACCESS_TTL'] ?? '20s',
        RATE_LIMIT_AUTH_PER_MINUTE: process.env['RATE_LIMIT_AUTH_PER_MINUTE'] ?? '1000',
        RATE_LIMIT_PER_MINUTE: process.env['RATE_LIMIT_PER_MINUTE'] ?? '10000',
      },
    },
    {
      command: 'pnpm exec nx run web:serve',
      timeout: 180_000,
      url: getReadyUrl('http://localhost:4200'),
      reuseExistingServer: true,
      cwd: workspaceRoot,
    },
  ],
  // Chromium uniquement (CI GitHub Free) ; les largeurs responsives sont ajoutées par test-e2e.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
