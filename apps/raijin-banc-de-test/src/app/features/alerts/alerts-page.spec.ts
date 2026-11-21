import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { UserPreferences } from '../../core/preferences/user-preferences';
import { SUPABASE } from '../../core/supabase/supabase-client';
import { ALERT_FETCH_LIMIT } from './alert-log';
import { AlertsPage } from './alerts-page';

const A = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const B = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

interface Result {
  data: unknown;
  error: unknown;
}

describe('AlertsPage', () => {
  async function setup(log: Result, tokens: Result = { data: [], error: null }) {
    const order = vi.fn();
    const kindFilter = vi.fn();
    const limit = vi.fn(async () => log);
    const inFilter = vi.fn(async () => tokens);
    const supabase = {
      from: (table: string) =>
        table === 'alert_log'
          ? {
              select: () => ({
                in: (...k: unknown[]) => (kindFilter(...k), { order: (...args: unknown[]) => (order(...args), { limit }) }),
              }),
            }
          : { select: () => ({ in: inFilter }) },
    };
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: SUPABASE, useValue: supabase }] });
    const fixture = TestBed.createComponent(AlertsPage);
    fixture.detectChanges();
    // Two chained queries (alert_log then tokens): let both promises settle.
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    fixture.detectChanges();
    return { el: fixture.nativeElement as HTMLElement, fixture, order, limit, inFilter, kindFilter };
  }

  it('keeps the empty state when there is no alert', async () => {
    const { el, inFilter } = await setup({ data: [], error: null });
    expect(el.textContent).toContain('Aucune alerte pour l’instant');
    expect(inFilter).not.toHaveBeenCalled();
  });

  it('lists the latest 50 alerts newest first, joined with tokens (symbol only), each linking to its token', async () => {
    const { el, order, limit, inFilter, kindFilter } = await setup(
      {
        data: [
          { id: 2, mint: B, sent_at: '2026-11-16T09:00:00Z', kind: 'grouped' },
          { id: 1, mint: A, sent_at: '2026-11-16T08:00:00Z', kind: 'single' },
        ],
        error: null,
      },
      { data: [{ mint: A, symbol: '<img src=x onerror=alert(1)>', score: 77 }], error: null },
    );
    expect(order).toHaveBeenCalledWith('sent_at', { ascending: false });
    expect(kindFilter).toHaveBeenCalledWith('kind', ['single', 'grouped']);
    expect(limit).toHaveBeenCalledWith(ALERT_FETCH_LIMIT); // the list shows 50, the 7-day summary needs the whole window
    expect(inFilter).toHaveBeenCalledWith('mint', [B, A]);
    const links = Array.from(el.querySelectorAll<HTMLAnchorElement>('app-alert-row a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`/token/${B}`, `/token/${A}`]);
    expect(links[0].textContent).toContain('Alerte groupée');
    expect(links[1].textContent).toContain('<img src=x onerror=alert(1)>');
    // The token's current score (77) is not shown any more: a row shows the alert outcome.
    expect(links[1].textContent).not.toContain('77');
    expect(links[1].querySelector('[aria-label^="Score"]')).toBeNull();
    expect(el.querySelector('img[src="x"]')).toBeNull();
  });

  it('still lists alerts when the token lookup fails', async () => {
    const { el } = await setup(
      { data: [{ id: 1, mint: A, sent_at: '2026-11-16T08:00:00Z', kind: 'single' }], error: null },
      { data: null, error: { message: 'boom' } },
    );
    expect(el.querySelectorAll('app-alert-row')).toHaveLength(1);
  });

  it('shows an error with a retry button', async () => {
    const { el } = await setup({ data: null, error: { message: 'boom' } });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Impossible de charger tes alertes');
  });

  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const single = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    mint: A,
    sent_at: ago(60),
    kind: 'single',
    entry_price: '2',
    target_price: '2.4',
    stop_price: '1.6',
    entry_roundtrip_pct: '2',
    stake_sol: '0.1',
    max_price: '2.2',
    min_price: '1.9',
    last_price: '2.1',
    last_price_at: ago(3),
    first_hit: null,
    tracking_until: new Date(Date.now() + 3_600_000).toISOString(),
    ...over,
  });

  it('shows the follow-up of a single alert with an accessible badge, and keeps grouped alerts compact', async () => {
    const { el } = await setup({
      data: [
        single(1, { first_hit: 'target', sent_at: ago(10) }),
        single(2, { first_hit: 'stop', sent_at: ago(20) }),
        single(3, { sent_at: ago(30) }),
        single(4, { sent_at: ago(40), tracking_until: ago(1) }),
        { id: 5, mint: B, sent_at: ago(50), kind: 'grouped' },
      ],
      error: null,
    });
    const rows = Array.from(el.querySelectorAll('app-alert-row'));
    expect(rows.map((r) => r.querySelector('[data-status]')?.textContent?.trim() ?? null)).toEqual([
      'Objectif touché',
      'Stop touché',
      'En cours',
      'Suivi terminé',
      null,
    ]);
    const first = rows[0].textContent ?? '';
    for (const text of ['Prix à l’alerte', '$2.000', 'Plus haut', '+10,0 %', 'Plus bas', '−5,0 %', 'Prix actuel', 'il y a 3 min', 'Objectif', '+20,0 %', 'Stop', '−20,0 %']) {
      expect(first).toContain(text);
    }
    expect(rows[0].querySelector('[data-outcome]')?.textContent?.trim()).toBe('$2.000 → plus haut $2.200 (×1,10) → actuel $2.100 (×1,05)');
    expect(rows[4].querySelector('dl')).toBeNull();
    expect(rows[4].querySelector('[data-outcome], [data-legacy]')).toBeNull();
    expect(rows[4].textContent).toContain('Alerte groupée');
  });

  it('summarises the last 7 days with the user stake and the disclaimer', async () => {
    const { el, fixture } = await setup({
      data: [
        single(1, { first_hit: 'target' }),
        single(2, { first_hit: 'stop' }),
        single(3, { last_price: '2.1' }),
        single(4, { first_hit: 'target', sent_at: ago(8 * 24 * 60) }), // outside the window
        { id: 5, mint: B, sent_at: ago(5), kind: 'grouped' },
      ],
      error: null,
    });
    // Default stake 0.05 SOL: the 2 % quote (0.1 SOL) scales to 1 % → (0.19 − 0.21 + 0.04) × 0.05 = +0.001 SOL.
    expect(el.querySelector('[data-summary-headline]')?.textContent?.trim()).toBe(
      '7 derniers jours : 4 alertes · 1 objectif · 1 stop · résultat simulé pour ma mise : +0,001 SOL (frais inclus)',
    );
    expect(el.textContent).toContain('Simulation, pas un conseil en investissement ; les prix sont échantillonnés toutes les 2 min.');

    // Stake from the user preferences (fees scale with it: 2 % → 20 % for 1 SOL).
    TestBed.inject(UserPreferences).setStake(1);
    fixture.detectChanges();
    expect(el.querySelector('[data-summary-headline]')?.textContent).toContain('résultat simulé pour ma mise : −0,55 SOL (frais inclus)');
    expect(el.querySelector('[data-summary-detail]')?.textContent).toContain('mise 1 SOL par alerte');
  });
});

