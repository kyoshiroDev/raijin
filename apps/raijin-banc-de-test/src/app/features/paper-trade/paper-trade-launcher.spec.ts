import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BENCH_ROUTES } from '@raijin/bench-contracts';
import { describe, expect, it, vi } from 'vitest';
import { FakeBenchApi, apiError, list, provideFakeBench } from '../../core/api/bench-api.testing';
import { UserPreferences } from '../../core/preferences/user-preferences';
import { PaperTradeLauncher } from './paper-trade-launcher';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(opts: { price?: number | null; openError?: string } = {}) {
  /** Corps de POST /api/paper/positions ; `openError` simule un refus avec ce message. */
  const rpc = vi.fn((body: unknown) => {
    if (opts.openError) throw apiError(422, 'PAPER_REJECTED', opts.openError);
    return { id: 'pos-1', body };
  });
  const api = new FakeBenchApi()
    .on('GET', BENCH_ROUTES.paperWallets, list([{ book: 'main', balance_sol: 1, initial_sol: 1 }]))
    .on('GET', BENCH_ROUTES.paperPositions, list([]))
    .on('POST', BENCH_ROUTES.paperPositions, (c) => rpc(c.body));
  const from = () => api.calls.filter((c) => c.method === 'GET');
  TestBed.configureTestingModule({ providers: [provideRouter([]), ...provideFakeBench(api)] });
  TestBed.inject(UserPreferences).setPaperSlPct(25);
  const fixture = TestBed.createComponent(PaperTradeLauncher);
  fixture.componentRef.setInput('mint', MINT);
  fixture.componentRef.setInput('symbol', 'GTA6');
  fixture.componentRef.setInput('currentPrice', opts.price === undefined ? 0.0002 : opts.price);
  fixture.componentRef.setInput('stake', 0.05);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const open = async () => {
    el.querySelector<HTMLButtonElement>('[data-paper-trade-button]')?.click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
  };
  return { fixture, el, open, rpc, from };
}

describe('PaperTradeLauncher', () => {
  it('reads nothing from the API until the sheet is opened', () => {
    const { rpc, from, el } = setup();
    expect(el.querySelector('[data-paper-trade-button]')?.textContent).toContain('Paper trade');
    expect(rpc).not.toHaveBeenCalled();
    expect(from()).toHaveLength(0);
  });

  it('opens the sheet with the simulation banner, the balance, « tout à ×2 », the default stop and the stake', async () => {
    const { el, open, from } = setup();
    await open();
    expect(from().map((c) => c.route)).toContain(BENCH_ROUTES.paperWallets);
    expect(el.querySelector('[data-simulation-banner]')?.textContent).toContain('Simulation — aucun argent réel');
    expect(el.querySelector('[data-balance]')?.textContent).toContain('1 SOL');
    expect(el.querySelector('[data-strategy="all_x2"]')).not.toBeNull();
    expect(el.querySelector<HTMLInputElement>('[data-field="slPct"]')?.value).toBe('25');
    expect(el.querySelector('[data-entry]')?.textContent).toContain('Entrée au prix actuel ($0.0002000)');
    expect(el.querySelector<HTMLInputElement>('[data-field="stake"]')?.value).toBe('0,05');
  });

  it('always enters at the current price (market entry, no zone entry)', async () => {
    const { el, open, fixture, rpc } = setup({ price: 0.0001 });
    await open();
    el.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await flush();
    fixture.detectChanges();
    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ entry_price: 0.0001, custom_tp_price: null, custom_sl_price: null }));
  });

  it('validates through the API and confirms', async () => {
    const { el, open, fixture, rpc } = setup();
    await open();
    el.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await flush();
    fixture.detectChanges();
    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ mint: MINT, strategy: 'all_x2', sl_pct: 25, book: 'main' }));
    expect(el.querySelector('[data-paper-done]')?.textContent).toContain('Paper trade enregistré');
    expect(el.querySelector('a[href="/portfolio"]')).not.toBeNull();
  });

  it('shows « Solde virtuel insuffisant » on a balance rejection', async () => {
    const { el, open, fixture } = setup({ openError: 'Solde virtuel insuffisant.' });
    await open();
    el.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await flush();
    fixture.detectChanges();
    expect(el.querySelector('[data-submit-error]')?.textContent?.trim()).toBe('Solde virtuel insuffisant');
  });

  it('is disabled when no price is known', () => {
    const { el } = setup({ price: null });
    expect(el.querySelector<HTMLButtonElement>('[data-paper-trade-button]')?.disabled).toBe(true);
    expect(el.textContent).toContain('paper trade indisponible');
  });
});
