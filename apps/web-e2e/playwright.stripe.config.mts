import { defineConfig, devices } from '@playwright/test';

/**
 * Paiement Stripe en mode test réel (src/stripe-live-test.spec.ts), lancé à la main :
 *   STRIPE_E2E=1 BASE_URL=http://localhost:4200 ./node_modules/.bin/playwright test -c apps/web-e2e/playwright.stripe.config.mts
 * Aucun serveur démarré ici : API (BILLING_PROVIDER=stripe, clés sk_test), app servie sur BASE_URL et
 * `stripe listen --forward-to http://localhost:3100/api/v1/billing/webhook` tournent déjà.
 */
export default defineConfig({
  testDir: './src',
  testMatch: ['**/stripe-live-test.spec.ts'],
  outputDir: '../../dist/.playwright/apps/web-e2e/stripe-test-output',
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env['BASE_URL'] ?? 'http://localhost:4200',
    locale: 'fr-FR',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
