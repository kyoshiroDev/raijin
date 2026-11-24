import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BENCH_ROUTES, type ShadowComparison, type ShadowDayRow } from '@raijin/bench-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeBenchApi, apiError, provideFakeBench } from '../../core/api/bench-api.testing';
import { diffLevel, diffPct, formatDiff, parseShadowComparison, sortRows, summarizeByTable, windowRange } from './shadow-comparison';
import { SHADOW_MSG } from './shadow-comparison-store';
import { ShadowComparisonPage } from './shadow-comparison-page';

const A = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const B = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const day = (over: Partial<ShadowDayRow>): ShadowDayRow => ({
  table: 'tokens',
  day: '2026-11-23',
  vps_rows: 100,
  ref_rows: 100,
  diff_pct: 0,
  only_vps_count: 0,
  only_ref_count: 0,
  only_vps_sample: [],
  only_ref_sample: [],
  ...over,
});

const COMPARISON: ShadowComparison = {
  snapshot_at: '2026-11-24T06:00:00.000Z',
  from: '2026-11-18',
  to: '2026-11-24',
  rows: [
    day({ day: '2026-11-22', vps_rows: 90, ref_rows: 100, diff_pct: -10, only_vps_count: 1, only_ref_count: 2, only_vps_sample: [A], only_ref_sample: [B, A] }),
    day({ day: '2026-11-23' }),
    day({ table: 'scan_runs', day: '2026-11-23', vps_rows: 720, ref_rows: 718, diff_pct: 0.28, only_vps_count: null, only_ref_count: null }),
  ],
};

describe('shadow comparison (pure)', () => {
  it('computes the diff in percent of the reference, null when the reference is empty', () => {
    expect(diffPct(90, 100)).toBe(-10);
    expect(diffPct(5, 0)).toBeNull();
    expect(formatDiff(-10)).toBe('-10,0 %');
    expect(formatDiff(null)).toBe('—');
    expect(diffLevel(-10)).toBe('notice');
    expect(diffLevel(0.28)).toBe('ok');
    expect(diffLevel(null, 0)).toBe('none');
    expect(diffLevel(null, 3)).toBe('notice');
  });

  it('sums per table over the window, in contract order', () => {
    const [tokens, scans] = summarizeByTable(COMPARISON.rows);
    expect(tokens).toMatchObject({ table: 'tokens', days: 2, vpsRows: 190, refRows: 200, diffPct: -5, onlyVps: 1, onlyRef: 2, level: 'ok' });
    expect(scans).toMatchObject({ table: 'scan_runs', onlyVps: null, onlyRef: null });
    expect(sortRows(COMPARISON.rows).map((r) => `${r.table}:${r.day}`)).toEqual(['tokens:2026-11-23', 'tokens:2026-11-22', 'scan_runs:2026-11-23']);
  });

  it('builds the window (end included, UTC) and validates the body with the contract', () => {
    expect(windowRange(7, Date.parse('2026-11-24T10:00:00Z'))).toEqual({ from: '2026-11-18', to: '2026-11-24' });
    expect(parseShadowComparison(COMPARISON)).toEqual(COMPARISON);
    expect(parseShadowComparison({ ...COMPARISON, rows: [{ ...COMPARISON.rows[0], table: 'users' }] })).toBeNull();
  });
});

describe('ShadowComparisonPage', () => {
  afterEach(() => vi.useRealTimers());

  async function render(answer: () => unknown) {
    const api = new FakeBenchApi().on('GET', BENCH_ROUTES.shadowComparison, answer);
    TestBed.configureTestingModule({ providers: [provideRouter([]), ...provideFakeBench(api)] });
    const fixture = TestBed.createComponent(ShadowComparisonPage);
    const settle = async () => {
      fixture.detectChanges();
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
      fixture.detectChanges();
    };
    await settle();
    return { el: fixture.nativeElement as HTMLElement, api, settle };
  }

  it('reads the last 7 days, shows the snapshot, the totals per table and the days as cards and as a table', async () => {
    const { el, api } = await render(() => COMPARISON);
    const [call] = api.callsTo('GET', BENCH_ROUTES.shadowComparison);
    expect(Object.keys(call?.query ?? {}).filter((k) => call?.query[k] !== undefined)).toEqual(['from', 'to']);
    expect(el.querySelector('h1')?.textContent).toContain('Comparaison mode ombre');
    expect(el.querySelector('[data-snapshot]')?.textContent).toContain('24/11/2026');
    expect(el.querySelector('[data-summary="tokens"] [data-diff]')?.textContent).toContain('-5,0 %');
    // Cartes sous 768 px, tableau au-delà.
    expect(el.querySelector('[data-day-card]')?.closest('ul')?.classList).toContain('md:hidden');
    expect(el.querySelector('[data-day-table]')?.closest('div')?.classList).toContain('md:block');
    const notice = el.querySelector('[data-day-row="tokens:2026-11-22"] td:nth-of-type(4)');
    expect(notice?.textContent?.trim()).toBe('-10,0 %');
    expect(notice?.classList).toContain('text-warn');
    expect(el.querySelector('[data-day-card="tokens:2026-11-22"] [data-only-ref]')?.textContent).toContain(B);
  });

  it('filters by table and changes the window (new request each time)', async () => {
    const { el, api, settle } = await render(() => COMPARISON);
    const select = el.querySelector<HTMLSelectElement>('#shadow-table');
    if (!select) throw new Error('select');
    select.value = 'alert_log';
    select.dispatchEvent(new Event('change'));
    await settle();
    el.querySelector<HTMLButtonElement>('[data-window="31"]')?.click();
    await settle();
    const calls = api.callsTo('GET', BENCH_ROUTES.shadowComparison);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.query['table']).toBe('alert_log');
    const last = calls[2]?.query;
    expect((Date.parse(String(last?.['to'])) - Date.parse(String(last?.['from']))) / 86_400_000).toBe(30);
    expect(el.querySelector('[data-window="31"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('says when no snapshot was imported, when the route is missing, and on errors', async () => {
    const none = await render(() => ({ ...COMPARISON, snapshot_at: null, rows: [] }));
    expect(none.el.querySelector('[data-snapshot]')?.textContent).toContain('Aucun instantané importé');
    expect(none.el.querySelector('[data-empty]')).not.toBeNull();
    TestBed.resetTestingModule();
    const missing = await render(() => {
      throw apiError(404, 'NOT_FOUND');
    });
    expect(missing.el.querySelector('[data-unavailable]')?.textContent).toBe(SHADOW_MSG.unavailable);
    TestBed.resetTestingModule();
    const broken = await render(() => ({ rows: 'x' }));
    expect(broken.el.querySelector('[role="alert"]')?.textContent).toContain(SHADOW_MSG.loadFailed);
  });
});
