import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { SUPABASE } from '../../core/supabase/supabase-client';
import { PerformancePage } from './performance-page';
import { bookRow, breakdownRow, presetRow } from './performance-test-data';

interface Result {
  data: unknown;
  error: unknown;
}

const small = (over: Record<string, unknown>) =>
  breakdownRow({ n: 12, n_final: 4, x2: 3, x3: 1, x2_before_sl30: 2, sl30_before_x2: 6, dd50_first: 1, ...over });

describe('PerformancePage', () => {
  async function setup(breakdown: Result, presets: Result = { data: [], error: null }, books: Result = { data: [], error: null }) {
    const rpc = vi.fn(async (name: string) => (name === 'performance_by_preset' ? presets : name === 'paper_book_comparison' ? books : breakdown));
    const from = vi.fn();
    const supabase = { rpc, from };
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: SUPABASE, useValue: supabase }] });
    const fixture = TestBed.createComponent(PerformancePage);
    fixture.detectChanges();
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return { el, fixture, rpc, from };
  }

  it('loads the breakdown of the main scanner only: no source selector, no model card, no model read', async () => {
    const { el, rpc, from } = await setup({ data: [breakdownRow(), small({ source: 'radar' })], error: null });
    expect(rpc).toHaveBeenCalledWith('performance_breakdown');
    expect(from).not.toHaveBeenCalled();
    expect(el.querySelectorAll('[data-source]')).toHaveLength(0);
    expect(el.querySelector('app-source-selector, app-model-card, [data-model-card]')).toBeNull();
    expect(el.querySelector('[data-source-hint]')?.textContent).toContain('scanner principal');
    expect(el.querySelector('[data-overview] h3')?.textContent).toContain('Scan');
    expect(el.querySelector('[data-overview] [data-sample]')?.textContent?.trim()).toBe('n = 40');
  });

  it('n ≥ 30: shows the four rates in large type with hits / n and the sample size', async () => {
    const { el } = await setup({ data: [breakdownRow()], error: null });
    const overview = el.querySelector('[data-overview]');
    expect(overview?.querySelector('[data-sample]')?.textContent?.trim()).toBe('n = 40');
    const x2 = overview?.querySelector('[data-rate="x2"] [data-rate-value]');
    expect(x2?.textContent?.trim()).toBe('30,0 %');
    expect(x2?.classList).toContain('text-2xl');
    expect(overview?.querySelector('[data-rate="x2"]')?.textContent).toContain('12 / 40');
    expect(overview?.querySelector('[data-rate="x2_before_sl30"] [data-rate-value]')?.textContent?.trim()).toBe('25,0 %');
    expect(overview?.querySelector('[data-rate="sl30_before_x2"] [data-rate-value]')?.classList).toContain('text-bear');
    expect(overview?.querySelector('[data-rate="x3"] [data-rate-value]')?.textContent?.trim()).toBe('15,0 %');
    expect(overview?.querySelector('[data-stat="median"]')?.textContent).toContain('×1,45');
  });

  it('n < 30: never a large number — small, muted, « n = 12, échantillon trop petit »', async () => {
    const { el } = await setup({ data: [small({})], error: null });
    const overview = el.querySelector('[data-overview]');
    expect(overview?.querySelector('[data-sample]')?.textContent?.trim()).toBe('n = 12, échantillon trop petit');
    expect(overview?.querySelector('[data-rate-value]')).toBeNull();
    expect(overview?.querySelector('.text-2xl')).toBeNull();
    const cell = overview?.querySelector('[data-rate="x2"] [data-small-sample]');
    expect(cell?.classList).toContain('text-muted');
    expect(cell?.classList).toContain('text-xs');
    expect(cell?.textContent).toContain('25,0 %');
    expect(cell?.textContent).toContain('3 / 12');
  });

  it('lists every dimension with sorted, labelled buckets and their sample sizes', async () => {
    const { el } = await setup({
      data: [
        breakdownRow(),
        breakdownRow({ dimension: 'mc', bucket: '>1M' }),
        small({ dimension: 'mc', bucket: '<50k' }),
        breakdownRow({ dimension: 'dex', bucket: 'pumpswap' }),
        small({ dimension: 'zone', bucket: 'wait' }), // removed dimension: ignored
        small({ dimension: 'liq', bucket: '>=50k' }),
      ],
      error: null,
    });
    const dims = Array.from(el.querySelectorAll('app-bucket-list')).map((d) => d.getAttribute('data-dimension'));
    expect(dims).toEqual(['dex', 'mc', 'liq']);
    const mc = el.querySelector('[data-dimension="mc"]');
    expect(Array.from(mc?.querySelectorAll('[data-bucket]') ?? []).map((b) => b.getAttribute('data-bucket'))).toEqual(['<50k', '>1M']);
    const lt50 = mc?.querySelector('[data-bucket="<50k"]');
    expect(lt50?.textContent).toContain('< 50 k$');
    expect(lt50?.querySelector('[data-sample]')?.textContent?.trim()).toBe('n = 12, échantillon trop petit');
    expect(lt50?.querySelector('[data-rate-value]')).toBeNull();
    const gt1m = mc?.querySelector('[data-bucket=">1M"]');
    expect(gt1m?.querySelector('[data-rate="x2"] [data-rate-value]')?.classList).toContain('text-sm');
    expect(gt1m?.querySelector('.text-2xl')).toBeNull();
    expect(el.querySelector('[data-dimension="dex"]')?.textContent).toContain('PumpSwap');
    expect(el.querySelector('[data-dimension="zone"]')).toBeNull();
    expect(el.querySelector('[data-dimension="liq"]')?.textContent).toContain('≥ 50 k$');
  });

  it('says when the scanner has no labelled signal yet', async () => {
    const { el } = await setup({ data: [small({ source: 'preset:momentum' })], error: null });
    expect(el.querySelector('[data-empty-source]')?.textContent).toContain('Aucun signal étiqueté');
    expect(el.querySelector('app-bucket-list')).toBeNull();
  });

  it('says the rates come from 15-minute OHLCV candles and are a decision aid, not advice', async () => {
    const { el } = await setup({ data: [breakdownRow()], error: null });
    const text = el.querySelector('[data-disclaimer]')?.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(text).toContain('bougies OHLCV de 15 minutes');
    expect(text).toContain('aide à la décision, pas un conseil en investissement');
  });

  it('keeps hostile bucket names as text', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { el } = await setup({ data: [breakdownRow(), breakdownRow({ dimension: 'dex', bucket: hostile })], error: null });
    expect(el.querySelector('[data-dimension="dex"]')?.textContent).toContain(hostile);
    expect(el.querySelector('img[src="x"]')).toBeNull();
  });

  it('shows an error with a retry button', async () => {
    const { el } = await setup({ data: null, error: { message: 'boom' } });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Impossible de charger les performances');
    expect(el.querySelector('[role="alert"] button')?.textContent).toContain('Réessayer');
  });

  it('degrades gracefully while the RPC is not deployed', async () => {
    const { el } = await setup({ data: null, error: { code: 'PGRST202', message: 'not found' } });
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.querySelector('[data-unavailable]')?.textContent).toContain('pas encore disponibles');
  });

  describe('« Calme vs Frénésie »', () => {
    const ROWS = [
      presetRow({ preset: 'young_calm', trades: 7, paper_pnl_sol: 0.21, paper_open: 2 }),
      presetRow({ preset: 'young_frenzy', signals: 30, labelled: 25, x2_before_sl30: 6, sl30_before_x2: 15, trades: 4, paper_pnl_sol: -0.05, paper_open: 1 }),
      presetRow({ preset: 'momentum' }),
      presetRow({ preset: 'young_strong', segment: 'age_lt_3h' }),
    ];

    it('shows only the « Calme vs Frénésie » card (no Momentum / Jeune & fort / Strict cards) above the breakdown', async () => {
      const { el, fixture, rpc } = await setup({ data: [breakdownRow()], error: null }, { data: ROWS, error: null });
      expect(rpc).toHaveBeenCalledWith('performance_by_preset');
      expect(el.querySelectorAll('[data-preset-card]')).toHaveLength(0);
      const card = el.querySelector('[data-calm-frenzy-card]') as HTMLElement;
      expect(card).not.toBeNull();
      const overview = el.querySelector('[data-overview]') as HTMLElement;
      expect(card.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(card.querySelector('h3')?.textContent).toContain('Calme vs Frénésie');
      expect(Array.from(card.querySelectorAll('thead th')).slice(1).map((th) => th.textContent?.trim())).toEqual(['Calme', 'Frénésie']);
      const cells = (key: string) => Array.from(card.querySelectorAll(`[data-compare="${key}"] td`)).map((td) => td.textContent?.replace(/\s+/g, ' ').trim());
      expect(cells('x2_before_sl30')).toEqual(['30,0 % 12 / 40', '6 / 25 24,0 %']);
      expect(card.querySelectorAll('[data-compare="x2_before_sl30"] td[data-insufficient]')).toHaveLength(1);
      expect(cells('trades')).toEqual(['7', '4']);
      expect(cells('paper_pnl')).toEqual(['+0,21 SOL', '−0,05 SOL']);
      expect(cells('paper_open')).toEqual(['2', '1']);
      expect(card.textContent).toContain('profil témoin');
      expect(card.textContent).toContain('aucune alerte');
      expect(Array.from(card.querySelectorAll('[data-segment]')).map((b) => b.textContent?.trim())).toEqual(['Tous', 'GTA', 'Hors GTA']);
      card.querySelector<HTMLButtonElement>('[data-segment="gta"]')?.click();
      fixture.detectChanges();
      expect(card.querySelector('[data-segment="gta"]')?.getAttribute('aria-pressed')).toBe('true');
      expect(card.querySelector('[data-empty-comparison]')?.textContent).toContain('Aucun signal');
    });

    it('says so when the preset RPC is not deployed, and the breakdown still shows', async () => {
      const { el } = await setup({ data: [breakdownRow()], error: null }, { data: null, error: { code: 'PGRST202', message: 'not found' } });
      expect(el.querySelector('[data-presets-unavailable]')?.textContent).toContain('pas encore disponibles');
      expect(el.querySelector('[data-calm-frenzy-card]')).toBeNull();
      expect(el.querySelector('[data-overview]')).not.toBeNull();
      expect(el.querySelector('[role="alert"]')).toBeNull();
    });

    it('shows its own error with a retry that calls the preset RPC again', async () => {
      const { el, rpc, fixture } = await setup({ data: [breakdownRow()], error: null }, { data: null, error: { message: 'boom' } });
      const box = el.querySelector('[data-presets-error]') as HTMLElement;
      expect(box.textContent).toContain('Impossible de charger les résultats par profil');
      expect(el.querySelector('[data-overview]')).not.toBeNull();
      box.querySelector<HTMLButtonElement>('button')?.click();
      await fixture.whenStable();
      expect(rpc.mock.calls.filter(([name]) => name === 'performance_by_preset')).toHaveLength(2);
    });
  });

  describe('« Portefeuilles de test »', () => {
    const BOOKS = [
      bookRow({ book: 'calm_sl30', trades: 12, tp_hits: 5, sl_hits: 7 }),
      bookRow({ book: 'calm_sl40', trades: 34, tp_hits: 17, sl_hits: 15, pnl_sol: 0.2, max_drawdown_sol: 0, worst_losing_streak: 0, open_positions: 1 }),
      bookRow({ book: 'frenzy_sl30', trades: 50, tp_hits: 10, sl_hits: 40, pnl_sol: -0.3 }),
    ];

    it('shows the 3-book comparison first, rates in clear only from 30 trades, Frénésie flagged as a control', async () => {
      const { el, rpc } = await setup({ data: [breakdownRow()], error: null }, { data: [], error: null }, { data: BOOKS, error: null });
      expect(rpc).toHaveBeenCalledWith('paper_book_comparison');
      const card = el.querySelector('[data-test-books-card]') as HTMLElement;
      expect(card).not.toBeNull();
      const presets = el.querySelector('[data-preset-section]') as HTMLElement;
      expect(card.compareDocumentPosition(presets) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const heads = Array.from(card.querySelectorAll('thead th')).slice(1).map((th) => th.textContent?.replace(/\s+/g, ' ').trim());
      expect(heads).toEqual(['Calme −30 %', 'Calme −40 %', 'Frénésie −30 % témoin']);
      const cells = (key: string) => Array.from(card.querySelectorAll(`[data-compare="${key}"] td`)).map((td) => td.textContent?.replace(/\s+/g, ' ').trim());
      expect(cells('trades')).toEqual(['12', '34', '50']);
      expect(cells('tp')).toEqual(['5 / 12', '50,0 % 17 / 34', '20,0 % 10 / 50']);
      expect(cells('sl')).toEqual(['7 / 12', '44,1 % 15 / 34', '80,0 % 40 / 50']);
      expect(card.querySelectorAll('[data-compare="tp"] td[data-insufficient]')).toHaveLength(1);
      expect(cells('pnl')).toEqual(['+0,034 SOL', '+0,2 SOL', '−0,3 SOL']);
      expect(cells('drawdown')).toEqual(['−0,12 SOL', 'aucune', '−0,12 SOL']);
      expect(cells('streak')).toEqual(['3 d’affilée', 'aucune', '3 d’affilée']);
      expect(cells('open')).toEqual(['2', '1', '2']);
      expect(card.textContent).toContain('aucune alerte');
      expect(card.textContent).toContain('pas un conseil en investissement');
    });

    it('shows an accessible progress bar per book towards 50 trades', async () => {
      const { el } = await setup({ data: [breakdownRow()], error: null }, { data: [], error: null }, { data: BOOKS, error: null });
      const card = el.querySelector('[data-test-books-card]') as HTMLElement;
      expect(card.querySelector('h3')?.textContent).toContain('Progression vers 50 trades par portefeuille');
      const bars = Array.from(card.querySelectorAll('[role="progressbar"]'));
      expect(bars).toHaveLength(3);
      expect(bars.map((b) => [b.getAttribute('aria-valuenow'), b.getAttribute('aria-valuemax'), b.getAttribute('aria-valuetext')])).toEqual([
        ['12', '50', '12 trades sur 50'],
        ['34', '50', '34 trades sur 50'],
        ['50', '50', '50 trades sur 50'],
      ]);
      expect(bars[0].getAttribute('aria-valuemin')).toBe('0');
      const label = el.querySelector(`#${bars[2].getAttribute('aria-labelledby') ?? 'missing'}`);
      expect(label?.textContent?.trim()).toBe('Frénésie SL −30 % (témoin)');
      expect((bars[0].firstElementChild as HTMLElement).style.width).toBe('24%');
      expect(card.querySelector('[data-progress="frenzy_sl30"] [data-progress-text]')?.textContent).toContain('objectif atteint');
    });

    it('shows an empty card (progress at 0) when no book has a row yet', async () => {
      const { el } = await setup({ data: [breakdownRow()], error: null });
      expect(el.querySelector('[data-test-books-empty]')?.textContent).toContain('Aucun trade simulé');
      expect(el.querySelectorAll('[data-test-books-card] [role="progressbar"][aria-valuenow="0"]')).toHaveLength(3);
    });

    it('says so when the RPC is not deployed, and shows its own error with a retry otherwise', async () => {
      const missing = await setup({ data: [breakdownRow()], error: null }, { data: [], error: null }, { data: null, error: { code: 'PGRST202', message: 'x' } });
      expect(missing.el.querySelector('[data-test-books-unavailable]')?.textContent).toContain('pas encore disponible');
      expect(missing.el.querySelector('[data-overview]')).not.toBeNull();
      TestBed.resetTestingModule();
      const { el, rpc, fixture } = await setup({ data: [breakdownRow()], error: null }, { data: [], error: null }, { data: null, error: { message: 'boom' } });
      const box = el.querySelector('[data-test-books-error]') as HTMLElement;
      expect(box.textContent).toContain('Impossible de charger les portefeuilles de test');
      expect(el.querySelector('[data-overview]')).not.toBeNull();
      box.querySelector<HTMLButtonElement>('button')?.click();
      await fixture.whenStable();
      expect(rpc.mock.calls.filter(([name]) => name === 'paper_book_comparison')).toHaveLength(2);
    });
  });
});
