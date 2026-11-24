import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BENCH_ROUTES } from '@raijin/bench-contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBenchApi, FakeBenchEvents, apiError, list, provideFakeBench } from '../../core/api/bench-api.testing';
import { UserPreferences } from '../../core/preferences/user-preferences';
import type { TokenRow } from '../../shared/models/token';
import { OpportunitiesPage } from './opportunities-page';

const row = (mint: string, symbol: string, over: Partial<TokenRow> = {}): Partial<TokenRow> => ({
  mint,
  symbol,
  name: `${symbol} token`,
  pair_address: '',
  dex_id: 'raydium',
  market_cap: 1_000_000,
  pair_created_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), // < 24 h: listed by default
  liquidity_usd: 100_000, // ≥ 20 k$: not hidden by « Masquer les tokens risqués »
  flags: [],
  mint_authority_disabled: true,
  freeze_authority_disabled: true,
  updated_at: new Date().toISOString(),
  ...over,
});

// Youngest first: AAA (1 h) is listed before the hostile symbol (2 h).
const ROWS = [
  row('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'AAA', { pair_created_at: new Date(Date.now() - 3_600_000).toISOString() }),
  row('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', '<img src=x onerror=alert(1)>'),
];

describe('OpportunitiesPage', () => {
  let fixture: ComponentFixture<OpportunitiesPage>;
  let el: HTMLElement;
  /** Réponse de GET /api/tokens : `{ data, error }` (`error` = échec de l'API). */
  const limit = vi.fn();
  let api: FakeBenchApi;
  let events: FakeBenchEvents;

  beforeEach(async () => {
    limit.mockReset().mockResolvedValue({ data: ROWS, error: null });
    api = new FakeBenchApi().on('GET', BENCH_ROUTES.tokens, async () => {
      const r = (await limit()) as { data: unknown[]; error: unknown };
      if (r.error) throw apiError(500);
      return list(r.data);
    });
    events = new FakeBenchEvents();
    TestBed.configureTestingModule({ providers: [provideRouter([]), ...provideFakeBench(api, events)] });
    fixture = TestBed.createComponent(OpportunitiesPage);
    el = fixture.nativeElement;
    fixture.detectChanges();
    // API double: a few promise hops before the list is loaded.
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    fixture.detectChanges();
  });

  const filtersButton = () => el.querySelector<HTMLButtonElement>('app-filters-button button');
  const filterDialog = () => el.querySelectorAll('dialog')[0];
  const detailDialog = () => el.querySelectorAll('dialog')[1];
  const settle = async () => {
    fixture.detectChanges();
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    fixture.detectChanges();
  };

  it('shows the RAIJIN wordmark with the accent bolt in the h1', () => {
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('RAIJIN');
    expect(el.querySelector('h1 app-bolt-mark[data-tone="brand"]')).not.toBeNull();
  });

  it('shows the illustrated empty state, then card skeletons while reloading an empty list', async () => {
    limit.mockResolvedValue({ data: [], error: null });
    el.querySelector<HTMLButtonElement>('app-refresh-button button')?.click();
    await settle();
    await new Promise((resolve) => setTimeout(resolve));
    await settle();
    const empty = el.querySelector('[data-empty]');
    expect(empty?.querySelector('[data-empty-title]')?.textContent?.trim()).toBe("Aucun token ne passe tes filtres pour l'instant");
    expect(empty?.querySelector('app-bolt-mark[data-tone="dormant"]')).not.toBeNull();

    limit.mockReturnValue(new Promise(() => undefined));
    el.querySelector<HTMLButtonElement>('app-refresh-button button')?.click();
    fixture.detectChanges();
    const skeleton = el.querySelector('app-skeleton[data-skeleton="token-card"]');
    expect(skeleton?.getAttribute('role')).toBe('status');
    expect(skeleton?.querySelector('.sr-only')?.textContent?.trim()).toBe('Recherche des opportunités…');
    expect(el.querySelector('[data-empty]')).toBeNull();
  });

  it('lists the tokens with hostile symbols as text', () => {
    expect(el.querySelectorAll('app-token-card')).toHaveLength(2);
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(el.querySelector('img[src="x"]')).toBeNull();
  });

  it('opens the filter sheet, closes it with Escape and returns focus to « Filtres »', async () => {
    filtersButton()?.focus();
    filtersButton()?.click();
    await settle();
    expect(filterDialog().hasAttribute('open')).toBe(true);
    expect(filterDialog().querySelector('app-filter-bar')).not.toBeNull();
    expect(filterDialog().contains(document.activeElement)).toBe(true);

    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settle();
    expect(filterDialog().hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(filtersButton());
  });

  it('closes the filter sheet on a backdrop tap', async () => {
    filtersButton()?.focus();
    filtersButton()?.click();
    await settle();
    filterDialog().querySelector<HTMLElement>('[data-sheet-backdrop]')?.click();
    await settle();
    expect(filterDialog().hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(filtersButton());
  });

  it('shows a badge with the number of non-default filters', async () => {
    expect(el.querySelector('[data-filter-badge]')).toBeNull();
    expect(filtersButton()?.getAttribute('aria-label')).toBe('Filtres');

    filtersButton()?.click();
    await settle();
    const risky = Array.from(filterDialog().querySelectorAll('label')).find((l) => l.textContent?.includes('Masquer les tokens risqués'));
    risky?.querySelector('input')?.click();
    const all = Array.from(filterDialog().querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Toutes');
    all?.click();
    await settle();

    expect(el.querySelector('[data-filter-badge]')?.textContent?.trim()).toBe('2');
    expect(filtersButton()?.getAttribute('aria-label')).toBe('Filtres, 2 actifs');
  });

  it('opens the token detail when a card is tapped and closes it with Escape', async () => {
    const open = el.querySelector<HTMLButtonElement>('app-token-card button[data-open]');
    expect(open?.getAttribute('aria-label')).toBe('Voir le détail de AAA');
    open?.focus();
    open?.click();
    await settle();
    expect(detailDialog().hasAttribute('open')).toBe(true);
    expect(detailDialog().querySelector('app-token-detail')).not.toBeNull();
    expect(detailDialog().querySelector('h2')?.textContent?.trim()).toBe('AAA');

    detailDialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settle();
    expect(detailDialog().querySelector('app-token-detail')).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  it('has an « Actualiser » button that reloads and is disabled while loading', async () => {
    const refresh = el.querySelector<HTMLButtonElement>('app-refresh-button button');
    expect(refresh?.textContent).toContain('Actualiser');
    let resolve: (v: unknown) => void = () => undefined;
    limit.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    refresh?.click();
    fixture.detectChanges();
    expect(refresh?.disabled).toBe(true);
    expect(refresh?.getAttribute('aria-busy')).toBe('true');
    resolve({ data: ROWS, error: null });
    await settle();
    expect(refresh?.disabled).toBe(false);
    expect(limit).toHaveBeenCalledTimes(2);
  });

  it("passes the user's stake to the cards and the detail", async () => {
    const withQuote = ROWS.map((r) => ({ ...r, roundtrip_cost_pct: '2.4', roundtrip_fee_pct: 0.5 }));
    limit.mockResolvedValueOnce({ data: withQuote, error: null });
    await fixture.componentInstance['store'].load();
    TestBed.inject(UserPreferences).setStake(0.3);
    await settle();
    const lines = Array.from(el.querySelectorAll('app-token-card [data-roundtrip]')).map((p) => p.textContent ?? '');
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toContain('Coût aller-retour : 0,019 SOL (6,3 %)');

    el.querySelector<HTMLButtonElement>('app-token-card button[data-open]')?.click();
    await settle();
    expect(detailDialog().querySelector('[data-roundtrip-breakdown]')?.textContent).toContain('Coût aller-retour pour 0,3 SOL (estimé)');
  });

  it('shows the « Mis à jour » indicator in a polite live region', () => {
    const status = el.querySelector('app-updated-ago');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent?.trim()).toBe('Mis à jour à l’instant');
  });

  it('lists only pairs younger than 24 h by default, the older ones behind « Afficher les tokens anciens », youngest first', async () => {
    const old = row('So11111111111111111111111111111111111111112', 'OLD', { pair_created_at: new Date(Date.now() - 72 * 3_600_000).toISOString() });
    const newest = row('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'NEW', { pair_created_at: new Date(Date.now() - 600_000).toISOString() });
    limit.mockResolvedValue({ data: [...ROWS, old, newest], error: null });
    el.querySelector<HTMLButtonElement>('app-refresh-button button')?.click();
    await settle();
    const symbols = () => Array.from(el.querySelectorAll('app-token-card h2')).map((h) => h.textContent);
    expect(symbols()).not.toContain('OLD');
    expect(symbols()[0]).toBe('NEW');
    expect(el.querySelector('[data-count]')?.textContent).not.toContain('en zone');
    const toggle = el.querySelector<HTMLInputElement>('[data-show-old] input');
    expect(toggle?.checked).toBe(false);
    toggle?.click();
    await settle();
    expect(symbols()).toContain('OLD');
    expect(symbols().at(-1)).toBe('OLD');
    expect(el.querySelector('[data-filter-badge]')).toBeNull(); // the switch is not a sheet filter
  });

  it('reads GET /api/tokens (last 30 min, 300 rows) and follows the SSE « tokens » stream', async () => {
    const call = api.callsTo('GET', BENCH_ROUTES.tokens)[0];
    expect(call?.query['limit']).toBe(300);
    expect(Date.now() - Date.parse(String(call?.query['since']))).toBeGreaterThanOrEqual(30 * 60_000);
    expect(events.subscriptions.map((s) => s.topics)).toEqual([['tokens']]);

    events.emit({ type: 'token.delete', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });
    await settle();
    expect(el.querySelectorAll('app-token-card')).toHaveLength(1);

    events.reconnect();
    await settle();
    expect(api.callsTo('GET', BENCH_ROUTES.tokens)).toHaveLength(2);
    await settle();
    expect(el.querySelectorAll('app-token-card')).toHaveLength(2);
  });

  it('closes the stream when the page is destroyed', () => {
    fixture.destroy();
    expect(events.open).toBe(0);
  });
});
