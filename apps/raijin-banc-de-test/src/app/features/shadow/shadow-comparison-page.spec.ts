import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BENCH_ROUTES, type ShadowComparison, type ShadowDayRow } from '@raijin/bench-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBenchApi, apiError, provideFakeBench } from '../../core/api/bench-api.testing';
import { SHADOW_ACCEPTANCE } from '@raijin/bench-contracts';
import { dayLevel, diffLevel, diffPct, formatDiff, parseShadowComparison, snapshotRange, sortRows, summarizeByTable, toleranceLabel, windowRange } from '@raijin/bench-web-logic/shadow';
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
  snapshot_window: { from: '2026-11-18T00:00:00.000Z', to: '2026-11-24T06:00:00.000Z' },
  from: '2026-11-18',
  to: '2026-11-24',
  rows: [
    day({ day: '2026-11-22', vps_rows: 85, ref_rows: 100, diff_pct: -15, only_vps_count: 1, only_ref_count: 2, only_vps_sample: [A], only_ref_sample: [B, A] }),
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
  });

  it('flags the gaps with the official per-table tolerances of bench-contracts (no local threshold)', () => {
    // tokens : ±5 % sur la fenêtre, ±10 % sur un jour ; scan_runs : ±2 % / ±5 %.
    expect(SHADOW_ACCEPTANCE.tables.tokens).toMatchObject({ maxWindowDiffPct: 5, maxDayDiffPct: 10 });
    expect(diffLevel('tokens', -10, 90, 100, 'day')).toBe('ok');
    expect(diffLevel('tokens', -10.5, 895, 1000, 'day')).toBe('notice');
    expect(diffLevel('tokens', -6, 94, 100, 'window')).toBe('notice');
    expect(diffLevel('scan_runs', -3, 97, 100, 'window')).toBe('notice');
    expect(diffLevel('scan_runs', -3, 97, 100, 'day')).toBe('ok');
    // Jour trop maigre (< 30 lignes de référence) : pas jugé isolément.
    expect(diffLevel('tokens', -50, 5, 10, 'day')).toBe('ok');
    expect(diffLevel('tokens', null, 0, 0, 'day')).toBe('none');
    expect(diffLevel('tokens', null, 3, 0, 'day')).toBe('notice');
    // Informatives en ombre (push et auto-paper coupés).
    expect(diffLevel('alert_log', -100, 0, 40, 'window')).toBe('info');
    expect(dayLevel(day({ day: '2026-11-22', vps_rows: 85, ref_rows: 100, diff_pct: -15 }))).toBe('notice');
    expect(toleranceLabel('tokens')).toBe('±5 % (jour ±10 %) · mints d’un seul côté ≤ 10 %');
    expect(toleranceLabel('paper_positions')).toBe('informative en ombre');
  });

  it('sums per table over the window, in contract order', () => {
    const [tokens, scans] = summarizeByTable(COMPARISON.rows);
    expect(tokens).toMatchObject({ table: 'tokens', days: 2, vpsRows: 185, refRows: 200, diffPct: -7.5, onlyVps: 1, onlyRef: 2, level: 'notice' });
    expect(summarizeByTable([day({ vps_rows: 96, ref_rows: 100, diff_pct: -4 })])[0]?.level).toBe('ok');
    expect(scans).toMatchObject({ table: 'scan_runs', onlyVps: null, onlyRef: null });
    expect(sortRows(COMPARISON.rows).map((r) => `${r.table}:${r.day}`)).toEqual(['tokens:2026-11-23', 'tokens:2026-11-22', 'scan_runs:2026-11-23']);
  });

  it('builds the window (end included, UTC) and validates the body with the contract', () => {
    expect(windowRange(7, Date.parse('2026-11-24T10:00:00Z'))).toEqual({ from: '2026-11-18', to: '2026-11-24' });
    expect(snapshotRange({ from: '2026-11-18T00:00:00Z', to: '2026-11-24T06:00:00Z' })).toEqual({ from: '2026-11-18', to: '2026-11-24' });
    expect(snapshotRange({ from: '2026-11-18T13:00:00Z', to: '2026-11-25T00:00:00Z' })).toEqual({ from: '2026-11-18', to: '2026-11-24' });
    expect(parseShadowComparison(COMPARISON)).toEqual(COMPARISON);
    expect(parseShadowComparison({ ...COMPARISON, rows: [{ ...COMPARISON.rows[0], table: 'users' }] })).toBeNull();
  });
});

describe('ShadowComparisonPage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T10:00:00Z'));
  });
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

  it('reads the snapshot window, shows the snapshot, the totals per table and the days as cards and as a table', async () => {
    const { el, api } = await render(() => COMPARISON);
    const [call] = api.callsTo('GET', BENCH_ROUTES.shadowComparison);
    expect(Object.keys(call?.query ?? {}).filter((k) => call?.query[k] !== undefined)).toEqual(['from', 'to']);
    expect(el.querySelector('h1')?.textContent).toContain('Comparaison mode ombre');
    expect(el.querySelector('[data-snapshot]')?.textContent).toContain('24/11/2026');
    expect(api.callsTo('GET', BENCH_ROUTES.shadowComparison)).toHaveLength(1);
    expect(call?.query).toMatchObject({ from: '2026-11-18', to: '2026-11-24' });
    expect(el.querySelector('[data-summary="tokens"] [data-diff]')?.textContent).toContain('-7,5 %');
    expect(el.querySelector('[data-summary="tokens"] [data-diff]')?.classList).toContain('text-warn');
    // Cartes sous 768 px, tableau au-delà.
    expect(el.querySelector('[data-day-card]')?.closest('ul')?.classList).toContain('md:hidden');
    expect(el.querySelector('[data-day-table]')?.closest('div')?.classList).toContain('md:block');
    const notice = el.querySelector('[data-day-row="tokens:2026-11-22"] td:nth-of-type(4)');
    expect(notice?.textContent?.trim()).toBe('-15,0 %');
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

  it('shows the official switch-over verdict, refetches the exact snapshot window, hides the verdict when filtered', async () => {
    const wide = { ...COMPARISON, from: '2026-11-10', snapshot_window: { from: '2026-11-10T00:00:00.000Z', to: '2026-11-24T06:00:00.000Z' } };
    const { el, api, settle } = await render(() => wide);
    const calls = api.callsTo('GET', BENCH_ROUTES.shadowComparison);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.query).toMatchObject({ from: '2026-11-10', to: '2026-11-24' });
    const verdict = el.querySelector('[data-acceptance]');
    // 14 jours complets : tokens hors tolérance, tables sans ligne « non concluantes ».
    expect(verdict?.getAttribute('data-status')).toBe('fail');
    expect(verdict?.textContent).toContain('14 jour(s) UTC complet(s)');
    expect(el.querySelector('[data-acceptance-table="tokens"]')?.textContent).toContain('Hors tolérance');
    expect(el.querySelector('[data-acceptance-table="tokens"]')?.textContent).toContain('écart -15 % sur un jour (max 10 %)');
    expect(el.querySelector('[data-acceptance-table="scan_runs"]')?.textContent).toContain('Conforme');
    expect(el.querySelector('[data-acceptance-table="token_snapshots"]')?.textContent).toContain('Non concluant');
    expect(el.querySelector('[data-acceptance-table="alert_log"]')?.textContent).toContain('Informative');
    const select = el.querySelector<HTMLSelectElement>('#shadow-table');
    if (!select) throw new Error('select');
    select.value = 'tokens';
    select.dispatchEvent(new Event('change'));
    await settle();
    expect(el.querySelector('[data-acceptance]')).toBeNull();
  });

  it('says when no snapshot was imported, when the route is missing, and on errors', async () => {
    const none = await render(() => ({ ...COMPARISON, snapshot_at: null, snapshot_window: null, rows: [] }));
    expect(none.el.querySelector('[data-acceptance]')?.getAttribute('data-status')).toBe('no_snapshot');
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
