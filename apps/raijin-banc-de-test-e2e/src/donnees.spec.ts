import { expect, test } from '@playwright/test';
import { FIXTURE_TOKENS } from './support/bench';

/** Écrans connectés (session de auth.setup.ts) alimentés par les fixtures de global-setup (support/db.ts). */
test.describe('données du banc', () => {
  test('opportunités : jetons de fixture listés, fiche token ouverte', async ({ page }) => {
    await page.goto('/');
    for (const token of FIXTURE_TOKENS) await expect(page.getByText(token.symbol, { exact: true }).first()).toBeVisible();
    await expect(page.getByText('pas un conseil en investissement', { exact: false }).first()).toBeAttached();
    await page.goto(`/token/${FIXTURE_TOKENS[0].mint}`);
    await expect(page.getByText(FIXTURE_TOKENS[0].symbol).first()).toBeVisible();
  });

  test('/comparaison : verdict de bascule « hors tolérance » sur l’instantané de fixture (écart scan_runs 25 %)', async ({ page }) => {
    await page.goto('/comparaison');
    await expect(page.getByRole('heading', { name: 'Comparaison mode ombre' })).toBeVisible();
    await page.locator('[data-window="snapshot"]').click();
    const verdict = page.locator('[data-acceptance]');
    await expect(verdict).toHaveAttribute('data-status', 'fail');
    await expect(verdict.locator('[data-verdict]')).toHaveText(/Hors tolérance : bascule refusée/);
    await expect(verdict).toContainText('4 jour(s) UTC complet(s)');
    const scanRuns = verdict.locator('[data-acceptance-table="scan_runs"]');
    await expect(scanRuns).toBeVisible();
    await expect(scanRuns).toContainText('n réf. 160');
  });

  test('aucune réponse 5xx de l’API sur les écrans principaux', async ({ page }) => {
    const errors: string[] = [];
    page.on('response', (response) => {
      if (response.url().includes('/api/') && response.status() >= 500) errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });
    for (const path of ['/', '/alerts', '/portfolio', '/performance', '/performance/lab', '/justesse', '/comparaison', '/settings', '/account']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    }
    expect([...new Set(errors)]).toEqual([]);
  });

  test('SSE : flux text/event-stream ouvert par l’app, battement reçu avec la session', async ({ page }) => {
    const stream = page.waitForResponse((response) => response.url().includes('/api/events'));
    await page.goto('/');
    const response = await stream;
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/event-stream');

    const firstChunk = await page.evaluate(async () => {
      const controller = new AbortController();
      const answer = await fetch('/api/events?topics=tokens', { signal: controller.signal, credentials: 'same-origin' });
      const reader = answer.body?.getReader();
      let text = '';
      const decoder = new TextDecoder();
      while (reader && !text.includes('event: heartbeat')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      controller.abort();
      return { status: answer.status, type: answer.headers.get('content-type'), text };
    });
    expect(firstChunk.status).toBe(200);
    expect(firstChunk.type).toContain('text/event-stream');
    expect(firstChunk.text).toMatch(/^retry: \d+/);
    expect(firstChunk.text).toContain('event: heartbeat');
  });
});
