import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { getReadyUrl, workspaceRoot } from '@nx/devkit';

// For CI, you may want to set BASE_URL to the deployed application.
// getReadyUrl moves the address to the port the dev server task reported.
const baseURL = process.env['BASE_URL'] || getReadyUrl('http://localhost:4200');
/** Serveur du build de production (apps/web-e2e/scripts/serve-prod.mjs). */
const PROD_ORIGIN = process.env['PROD_ORIGIN'] ?? 'http://127.0.0.1:4310';
/**
 * Landing Astro de test (phase 6 bis : consentement, GA4, attribution) : build fait avec un identifiant GA4 factice et
 * `APP_URL` = l'app de test, servi par apps/web-e2e/scripts/serve-landing.mjs (support/landing.ts lit la même valeur).
 */
const LANDING_ORIGIN = process.env['LANDING_ORIGIN'] ?? 'http://localhost:4330';
const LANDING_GA4_ID = 'G-E2ETEST01';

const preset = nxE2EPreset(import.meta.dirname, { testDir: './src' });

/**
 * Lots de la CI (job `e2e` en matrice, docs/ARCHITECTURE.md §6) : `E2E_LOT` restreint la suite à un groupe
 * de fichiers, équilibré à la main sur la durée (un `--shard` seul coupe par nombre de tests, et les parcours,
 * dix fois plus lents qu'un test responsive, tomberaient presque tous dans le premier lot). `reste` prend tout
 * fichier non listé : un nouveau spec est exécuté sans retoucher la CI. Sans `E2E_LOT`, toute la suite.
 */
const E2E_LOTS: Readonly<Record<string, readonly string[]>> = {
  responsive: ['responsive.spec.ts'],
  visuel: ['a11y.spec.ts', 'screenshots.spec.ts'],
  parcours: ['analysis.flow.spec.ts', 'auth.flow.spec.ts', 'billing.flow.spec.ts'],
};

function lotFilter(lot: string | undefined): { testMatch?: string[]; testIgnore?: string[] } {
  if (!lot) return {};
  if (lot === 'reste') return { testIgnore: Object.values(E2E_LOTS).flat().map((file) => `**/${file}`) };
  const files = E2E_LOTS[lot];
  if (!files) throw new Error(`E2E_LOT inconnu : « ${lot} » (attendu : ${[...Object.keys(E2E_LOTS), 'reste'].join(', ')})`);
  return { testMatch: files.map((file) => `**/${file}`) };
}

/** `E2E_SHARD=i/n` : découpe le lot en n parts (équivalent de `--shard=i/n`, sans passer d'argument par Nx). */
function shardFromEnv(value: string | undefined): { current: number; total: number } | null {
  if (!value) return null;
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const current = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || current < 1 || current > total) throw new Error(`E2E_SHARD invalide : « ${value} » (attendu : i/n)`);
  return { current, total };
}

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
  ...preset,
  ...lotFilter(process.env['E2E_LOT']),
  shard: shardFromEnv(process.env['E2E_SHARD']),
  // CI : 1 worker par défaut (runner 2 vCPU qui fait tourner aussi l'API, le serveur de dev et le build servi ;
  // les parcours partagent l'état global de l'API : scénarios de fixtures, passes de jobs). En local : 3 workers
  // au plus, pour que le serveur de dev et axe ne saturent pas la machine. `E2E_WORKERS` force la valeur.
  workers: Number(process.env['E2E_WORKERS'] ?? (process.env['CI'] ? 1 : 3)),
  // CI : progression test par test (durées dans le journal du job), en plus du rapport HTML et du blob du preset
  // (le blob de chaque lot est fusionné par le job `e2e-rapport` en cas d'échec).
  reporter: process.env['CI'] ? [['list'], ...preset.reporter] : preset.reporter,
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
      // API compilée lancée sans watch, en mode fixtures (phase 3) : sources Solana rejouées depuis
      // libs/api/solana/src/fixtures, TRUST_PROXY=1 pour simuler une IP par test (X-Forwarded-For,
      // quota anonyme neuf), index.html du build web pour GET /share/t/:mint, origine du serveur de
      // production local autorisée (CORS/CSRF). Même commande à la main si l'API est lancée d'avance.
      command: 'pnpm exec nx run api:build && node dist/apps/api/main.js',
      timeout: 300_000,
      url: 'http://localhost:3100/api/v1/health',
      reuseExistingServer: true,
      cwd: workspaceRoot,
      env: {
        NODE_ENV: 'development',
        ANALYSIS_FIXTURES: '1',
        TRUST_PROXY: '1',
        CORS_ORIGINS: `${PROD_ORIGIN},http://localhost:4310`,
        WEB_INDEX_HTML_PATH: `${workspaceRoot}/dist/apps/web/browser/index.html`,
        JWT_ACCESS_TTL: process.env['JWT_ACCESS_TTL'] ?? '20s',
        RATE_LIMIT_AUTH_PER_MINUTE: process.env['RATE_LIMIT_AUTH_PER_MINUTE'] ?? '1000',
        RATE_LIMIT_PER_MINUTE: process.env['RATE_LIMIT_PER_MINUTE'] ?? '10000',
        // Phase 4 (watch.flow.spec.ts) : routes internes de test (`internal/jobs`, `internal/fixtures`,
        // `internal/push/outbox`, refusées en production), push simulé, e-mails d'alerte groupés après 1 s,
        // délai de grâce coupé, préfixe BullMQ dédié (distinct de celui d'api-e2e).
        JOBS_TEST_TRIGGER: '1',
        PUSH_PROVIDER: 'fake',
        ALERT_EMAIL_BATCH_DELAY_S: '1',
        ALERT_COOLDOWN_MINUTES: '0',
        BULLMQ_PREFIX: 'raijin-web-e2e',
        // Phase 6 (billing.flow.spec.ts, trial.flow.spec.ts) : paiement simulé (faux Checkout, faux portail,
        // webhooks signés localement ; défaut hors production, explicite ici pour ne pas dépendre d'un .env).
        BILLING_PROVIDER: 'fake',
        // Phase 6 bis (admin.flow.spec.ts, écrans admin des suites responsive et axe) : GA4 et Search Console
        // simulés (« Données simulées » ; refusé en production), comme api-e2e.
        ANALYTICS_PROVIDER: 'fake',
      },
    },
    {
      command: 'pnpm exec nx run web:serve',
      timeout: 180_000,
      url: getReadyUrl('http://localhost:4200'),
      reuseExistingServer: true,
      cwd: workspaceRoot,
    },
    {
      // Build de production servi « comme en production » (compression, /api relayée, /t/<mint> réécrit
      // vers GET /api/v1/share/t/:mint) : page publique servie par l'API, CSP comprise (analysis.flow.spec.ts).
      command: 'pnpm exec nx run web:build && node apps/web-e2e/scripts/serve-prod.mjs',
      timeout: 300_000,
      url: `${PROD_ORIGIN}/manifest.webmanifest`,
      reuseExistingServer: true,
      cwd: workspaceRoot,
    },
    {
      // Landing Astro (phase 6 bis) : build dans dist/apps/landing-e2e (jamais celui de production, sans GA4), avec un
      // identifiant GA4 factice (bannière de consentement rendue) et des liens vers l'app de test. Les requêtes vers
      // Google sont interceptées par les tests (support/landing.ts) : rien ne sort de la machine.
      command: `../../node_modules/.bin/astro build --outDir ../../dist/apps/landing-e2e && node ../web-e2e/scripts/serve-landing.mjs --port ${new URL(LANDING_ORIGIN).port}`,
      timeout: 180_000,
      url: `${LANDING_ORIGIN}/robots.txt`,
      reuseExistingServer: true,
      cwd: `${workspaceRoot}/apps/landing`,
      env: {
        GA4_MEASUREMENT_ID: LANDING_GA4_ID,
        APP_URL: baseURL,
      },
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
