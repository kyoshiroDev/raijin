import { TestBed } from '@angular/core/testing';
import { BENCH_ROUTES } from '@raijin/bench-contracts';
import { describe, expect, it, vi } from 'vitest';
import { FakeBenchApi, list, provideFakeBench } from '../../core/api/bench-api.testing';
import { PortfolioPage } from './portfolio-page';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const HOSTILE = '<img src=x onerror=alert(1)>';
const flush = () => new Promise((r) => setTimeout(r, 0));

const leg = (over: Record<string, unknown>) => ({ id: `l-${String(Math.random())}`, position_id: 'o1', size_pct: 100, tp_price: 2, stop_price: 0.7, status: 'open', ...over });

const row = (over: Record<string, unknown>) => ({
  id: 'o1',
  book: 'main',
  mint: MINT,
  symbol: 'GTA6',
  strategy: 'all_x2',
  stake_sol: 0.1,
  source: 'manual',
  status: 'open',
  entry_target_price: 1,
  fill_price: 1,
  sl_price: 0.7,
  sl_pct: 30,
  created_at: '2026-11-17T10:00:00Z',
  legs: [leg({})],
  ...over,
});

const closed = (id: string, pnl: number, legStatus: string, closedAt: string, over: Record<string, unknown> = {}) =>
  row({ id, status: 'closed', pnl_sol: pnl, fees_sol: 0.0004, closed_at: closedAt, legs: [leg({ position_id: id, status: legStatus })], ...over });

const wallet = (book: string, balance = 1) => ({ book, balance_sol: balance, initial_sol: 1, created_at: '2026-11-01T00:00:00Z', reset_at: null });

async function render(positions: unknown[], wallets: unknown[] = [wallet('main', 0.9)]) {
  /** Écritures (annulation, remise à zéro) : route et paramètres de chemin. */
  const writes = vi.fn((route: string, params: unknown) => ({ route, params }));
  const api = new FakeBenchApi()
    .on('GET', BENCH_ROUTES.paperPositions, () => list(positions))
    .on('GET', BENCH_ROUTES.paperWallets, () => list(wallets))
    .on('GET', BENCH_ROUTES.tokenBriefs, () => list([{ mint: MINT, symbol: 'GTA6', price_usd: 1.2 }]))
    .on('POST', BENCH_ROUTES.paperPositionCancel, (c) => writes(c.route, c.params))
    .on('POST', BENCH_ROUTES.paperWalletReset, (c) => writes(c.route, c.params));
  TestBed.configureTestingModule({ providers: provideFakeBench(api) });
  const fixture = TestBed.createComponent(PortfolioPage);
  fixture.detectChanges();
  await flush();
  await flush();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const click = async (selector: string) => {
    el.querySelector<HTMLButtonElement>(selector)?.click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
  };
  return { fixture, el, writes, click };
}

describe('PortfolioPage', () => {
  it('shows the permanent simulation banner and the book: balance, open positions value, total P&L in SOL and %', async () => {
    const { el } = await render([row({ id: 'o1' }), closed('c1', 0.05, 'tp_hit', '2026-11-16T10:00:00Z')]);
    expect(el.querySelector('[data-simulation-banner]')?.textContent).toContain('Simulation — aucun argent réel');
    expect(el.querySelector('[data-wallet="balance"]')?.textContent).toContain('0,9');
    expect(el.querySelector('[data-wallet="balance"]')?.textContent).toContain('Principal');
    expect(el.querySelector('[data-wallet="open-value"] dd')?.textContent?.trim()).toBe('0,118 SOL');
    const total = el.querySelector('[data-wallet="total-pnl"]')?.textContent ?? '';
    expect(total).toContain('+0,067 SOL');
    expect(total).toContain('+6,7 %');
    expect(el.querySelector('app-book-selector')).toBeNull();
    expect(el.querySelector('[data-book-comparison]')).toBeNull();
  });

  it('lists open positions with live P&L and leg badges; hostile symbols stay text; cancel only on pending', async () => {
    const { el, writes, click } = await render([row({ id: 'o1', symbol: HOSTILE }), row({ id: 'p1', status: 'pending', fill_price: null, legs: [] })]);
    const open = el.querySelector('[data-position="open"]');
    expect(open?.textContent).toContain(HOSTILE);
    expect(el.querySelector('img[src="x"]')).toBeNull();
    expect(open?.querySelector('[data-pnl]')?.textContent).toContain('+');
    expect(open?.querySelector('[data-leg-badge]')?.textContent?.trim()).toBe('ouverte');
    expect(open?.querySelector('[data-cancel-position]')).toBeNull();
    expect(el.querySelector('[data-position="pending"] [data-cancel-position]')?.classList).toContain('btn-ghost');
    await click('[data-position="pending"] [data-cancel-position]');
    expect(writes).toHaveBeenCalledWith(BENCH_ROUTES.paperPositionCancel, { id: 'p1' });
  });

  it('shows the legs of ½ ×2 + ½ ×3: TP touché on A, B open with its stop moved up to the fill price (breakeven)', async () => {
    const { el } = await render([
      row({
        id: 'o1',
        strategy: 'half_x2_rest_x3',
        legs: [
          leg({ id: 'a', size_pct: 50, tp_price: 2, status: 'tp_hit', exit_price: 1.96 }),
          leg({ id: 'b', size_pct: 50, tp_price: 3, stop_price: 1, status: 'open' }),
        ],
      }),
    ]);
    const legs = Array.from(el.querySelectorAll('[data-position="open"] [data-leg]'));
    expect(legs.map((l) => l.querySelector('[data-leg-badge]')?.textContent?.trim())).toEqual(['TP touché', 'ouverte']);
    expect(legs[0]!.textContent).toContain('Moitié A · ×2');
    expect(legs[1]!.textContent).toContain('Moitié B · ×3');
    expect(legs[1]!.querySelector('[data-leg-stop]')?.textContent).toContain('1,000\u00a0$');
    expect(legs[1]!.querySelector('[data-breakeven-moved]')?.textContent).toContain('remonté au prix d’achat');
  });

  it('shows the history with SL / breakeven badges and the stats per strategy, grey under 30 trades', async () => {
    const { el } = await render([
      closed('h1', 0.04, 'tp_hit', '2026-11-16T10:00:00Z'),
      closed('h2', -0.03, 'sl_hit', '2026-11-17T10:00:00Z'),
      closed('h3', 0.02, 'tp_hit', '2026-11-15T10:00:00Z', {
        strategy: 'half_x2_rest_x3',
        legs: [leg({ position_id: 'h3', size_pct: 50, status: 'tp_hit' }), leg({ position_id: 'h3', size_pct: 50, tp_price: 3, status: 'breakeven_hit' })],
      }),
      row({ id: 'h4', status: 'expired', closed_at: '2026-11-14T10:00:00Z', legs: [] }),
    ]);
    expect(Array.from(el.querySelectorAll('[data-history]')).map((li) => li.getAttribute('data-history'))).toEqual(['closed', 'closed', 'closed', 'expired']);
    expect(el.querySelector('[data-history]')?.textContent).toContain('SL');
    expect(el.querySelectorAll('[data-history]')[2]!.textContent).toContain('breakeven');
    expect(el.querySelector('[data-history] [data-history-pnl]')?.textContent?.trim()).toBe('−0,03 SOL');
    const cards = Array.from(el.querySelectorAll('app-strategy-stats-card')).map((c) => c.getAttribute('data-strategy-stats'));
    expect(cards).toEqual(['half_x2_rest_x3', 'all_x2']);
    const allX2 = el.querySelector('[data-strategy-stats="all_x2"]');
    const tp = allX2?.querySelector('[data-stat="tp"]');
    expect(tp?.querySelector('[data-insufficient]')?.textContent?.trim()).toBe('1 / 2');
    expect(tp?.querySelector('[data-insufficient]')?.classList).toContain('text-muted');
    expect(tp?.textContent).toContain('échantillon insuffisant');
    expect(allX2?.querySelector('[data-stat="drawdown"]')?.textContent).toContain('−0,03 SOL');
    expect(allX2?.querySelector('[data-stat="streak"]')?.textContent).toContain('1');
    const half = el.querySelector('[data-strategy-stats="half_x2_rest_x3"]');
    expect(half?.querySelector('[data-stat="tp"] [data-insufficient]')?.textContent?.trim()).toBe('1 / 2');
    expect(half?.querySelector('[data-legs-note]')?.textContent).toContain('dont 1 au breakeven');
  });

  it('shows the TP rate as a percentage from 30 trades', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      closed(`h${i}`, i < 12 ? 0.04 : -0.016, i < 12 ? 'tp_hit' : 'sl_hit', new Date(Date.UTC(2026, 10, 10, 0, i)).toISOString()),
    );
    const { el } = await render(many);
    const tp = el.querySelector('[data-strategy-stats="all_x2"] [data-stat="tp"]');
    expect(tp?.querySelector('[data-insufficient]')).toBeNull();
    expect(tp?.textContent).toContain('40,0 %');
  });

  it('draws the balance curve as an accessible inline SVG with a data table fallback', async () => {
    const { el } = await render([closed('h1', 0.2, 'tp_hit', '2026-11-16T10:00:00Z'), closed('h2', -0.3, 'sl_hit', '2026-11-17T10:00:00Z')], [wallet('main', 0.9)]);
    const svg = el.querySelector('[data-balance-curve] svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toBe('Courbe du solde : de 1 SOL à 0,9 SOL sur 2 trades clôturés, plus haut 1,2 SOL, plus bas 0,9 SOL.');
    expect(svg?.classList).toContain('text-bear');
    expect(svg?.querySelectorAll('path')).toHaveLength(2);
    const rows = el.querySelectorAll('[data-balance-curve] [data-curve-row]');
    expect(rows).toHaveLength(3);
    expect(rows[2]!.textContent).toContain('0,9 SOL');
  });

  it('shows the book selector and the side-by-side comparison when the test books exist', async () => {
    const { el, fixture, click } = await render(
      [closed('a1', -0.05, 'sl_hit', '2026-11-16T10:00:00Z', { book: 'frenzy_sl30' }), closed('b1', 0.1, 'tp_hit', '2026-11-16T10:00:00Z', { book: 'calm_sl30' })],
      [wallet('main'), wallet('calm_sl30', 1.1), wallet('calm_sl40', 1.02), wallet('frenzy_sl30', 0.95)],
    );
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('app-book-selector button'));
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Principal', 'Calme −30 %', 'Calme −40 %', 'Frénésie −30 %']);
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(buttons[0]!.className).toContain('min-h-11');
    await click('[data-book="frenzy_sl30"]');
    expect(el.querySelector('[data-book="frenzy_sl30"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('[data-wallet="balance"]')?.textContent).toContain('Frénésie SL −30 % (témoin)');
    expect(el.querySelector('[data-wallet="balance"]')?.textContent).toContain('0,95');
    expect(el.querySelector('[data-reset]')).not.toBeNull();
    fixture.detectChanges();
    const compare = el.querySelector('[data-book-comparison]');
    expect(compare?.querySelector('[data-compare="balance"]')?.textContent).toContain('1,1 SOL');
    expect(compare?.querySelector('[data-compare="balance"]')?.textContent).toContain('0,95 SOL');
    expect(compare?.querySelector('[data-compare="tp"] [data-insufficient]')?.textContent?.trim()).toBe('1 / 1');
    expect(compare?.textContent).toContain('échantillon insuffisant');
  });

  it('asks for confirmation in a sheet before resetting the selected book (never window.confirm)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const { el, writes, click } = await render([], [wallet('main'), wallet('calm_sl30'), wallet('calm_sl40'), wallet('frenzy_sl30')]);
    await click('[data-book="calm_sl40"]');
    await click('[data-reset]');
    expect(writes).not.toHaveBeenCalled();
    const sheet = el.querySelector('dialog[open] [data-reset-confirm]');
    expect(sheet?.getAttribute('data-reset-book')).toBe('calm_sl40');
    expect(sheet?.textContent).toContain('Calme SL −40 %');
    await click('[data-confirm-reset]');
    expect(writes).toHaveBeenCalledWith(BENCH_ROUTES.paperWalletReset, { book: 'calm_sl40' });
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('shows an archived book read-only: history visible, no reset button, no cancel button', async () => {
    const { el, click } = await render(
      [
        closed('z1', 0.1, 'tp_hit', '2026-11-16T10:00:00Z', { book: 'calm_all_x2' }),
        row({ id: 'z2', book: 'calm_all_x2', status: 'pending', fill_price: null, legs: [] }),
      ],
      [wallet('main'), wallet('calm_all_x2', 1.1), wallet('frenzy_all_x2', 1)],
    );
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('app-book-selector button')).map((b) => b.textContent?.trim());
    expect(buttons).toEqual(['Principal', 'Calme ×2 · archivé']);
    await click('[data-book="calm_all_x2"]');
    expect(el.querySelector('[data-wallet="balance"]')?.textContent).toContain('Calme ×2 (archivé)');
    expect(el.querySelector('[data-archived]')?.textContent).toContain('lecture seule');
    expect(el.querySelector('[data-reset]')).toBeNull();
    expect(el.querySelector('[data-cancel-position]')).toBeNull();
    expect(el.querySelector('app-history-list')?.textContent).not.toContain('Aucun');
    expect(el.querySelector('[data-test-books-compare]')).toBeNull();
  });

  it('shows a wallet skeleton (screen-reader label only) until the first load completes', () => {
    const never = () => new Promise(() => undefined);
    const api = new FakeBenchApi().on('GET', BENCH_ROUTES.paperPositions, never).on('GET', BENCH_ROUTES.paperWallets, never);
    TestBed.configureTestingModule({ providers: provideFakeBench(api) });
    const fixture = TestBed.createComponent(PortfolioPage);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const skeleton = el.querySelector('app-skeleton[data-skeleton="wallet"]');
    expect(skeleton?.getAttribute('role')).toBe('status');
    expect(skeleton?.getAttribute('aria-busy')).toBe('true');
    expect(skeleton?.querySelector('.sr-only')?.textContent?.trim()).toBe('Chargement du portefeuille virtuel…');
    expect(el.querySelector('app-wallet-card')).toBeNull();
  });

  it('shows the exit slippage on stops (planned stop vs executed price), « Aucun stop touché » without stops', async () => {
    const stopped = await render([
      closed('s1', -0.03, 'sl_hit', '2026-11-17T10:00:00Z', { legs: [leg({ position_id: 's1', status: 'sl_hit', stop_price: 0.7, exit_price: 0.63 })] }),
      closed('s2', -0.03, 'sl_hit', '2026-11-16T10:00:00Z', { legs: [leg({ position_id: 's2', status: 'sl_hit', stop_price: 0.7, exit_price: 0.686 })] }),
    ]);
    const card = stopped.el.querySelector('[data-stop-slippage]');
    expect(card?.textContent).toContain('stop prévu et le prix réellement exécuté');
    expect(card?.querySelector('[data-stat="n"] dd')?.textContent?.trim()).toBe('2');
    expect(card?.querySelector('[data-stat="avg"] dd')?.textContent?.trim()).toBe('−6,0 %');
    expect(card?.querySelector('[data-stat="worst"] dd')?.textContent?.trim()).toBe('−10,0 %');
    TestBed.resetTestingModule();
    const none = await render([closed('t1', 0.05, 'tp_hit', '2026-11-16T10:00:00Z')]);
    expect(none.el.querySelector('[data-stop-slippage] [data-no-stop]')?.textContent).toContain('Aucun stop touché');
    expect(none.el.querySelector('[data-stop-slippage] [data-stat]')).toBeNull();
  });

  it('lists the test books and shows the 3-book comparison (Frénésie flagged as a control)', async () => {
    const { el } = await render([], [wallet('main'), wallet('calm_sl30', 1.12), wallet('calm_sl40', 1.04), wallet('frenzy_sl30', 0.91)]);
    const cmp = el.querySelector('[data-test-books-compare]');
    expect(cmp?.querySelector('h2')?.textContent).toContain('Portefeuilles de test');
    expect(cmp?.textContent).toContain('aucune alerte');
    const heads = Array.from(cmp?.querySelectorAll('thead th') ?? []).map((th) => th.textContent?.trim());
    expect(heads.slice(1)).toEqual(['Calme −30 %', 'Calme −40 %', 'Frénésie −30 %']);
    expect(cmp?.querySelector('[data-compare="balance"]')?.textContent).toContain('1,12 SOL');
    expect(cmp?.querySelector('[data-compare="balance"]')?.textContent).toContain('1,04 SOL');
    expect(cmp?.textContent).not.toContain('Mêmes alertes');
    expect(el.querySelector('[data-calm-frenzy-compare]')).toBeNull();
    const slippageBooks = Array.from(el.querySelectorAll('[data-stop-slippage] [data-book]')).map((d) => d.getAttribute('data-book'));
    expect(slippageBooks).toEqual(['main', 'calm_sl30', 'calm_sl40', 'frenzy_sl30']);
  });
});

