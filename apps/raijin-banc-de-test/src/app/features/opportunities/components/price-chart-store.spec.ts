import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { MAX_POINTS, RANGE_MS } from './price-chart-data';
import { MARKER_LIMIT, PriceChartStore } from './price-chart-store';
import { CHART_MINT, mockBench, ok, snapshotRows, type QueryResult } from './price-chart-test-data';

function setup(responders: Parameters<typeof mockBench>[0] = {}) {
  const sb = mockBench(responders);
  TestBed.configureTestingModule({ providers: [PriceChartStore, ...sb.providers] });
  return { store: TestBed.inject(PriceChartStore), sb };
}

async function settle() {
  TestBed.tick();
  await TestBed.inject(ApplicationRef).whenStable();
}

describe('PriceChartStore', () => {
  it('reads the last 24 h of snapshots for the mint (GET /api/tokens/:mint/snapshots), abortable', async () => {
    const { store, sb } = setup({ token_snapshots: ok(snapshotRows(24)) });
    store.setMint(CHART_MINT);
    await settle();
    const [call] = sb.callsOf('token_snapshots');
    expect(call?.params).toEqual({ mint: CHART_MINT });
    expect(Math.abs(Date.parse(String(call?.query['since'])) - (Date.now() - RANGE_MS['24h']))).toBeLessThan(10_000);
    expect(call?.signal).toBeInstanceOf(AbortSignal);
  });

  it('never queries with an invalid mint', async () => {
    const { store, sb } = setup();
    store.setMint('<script>');
    await settle();
    expect(store.mint()).toBeNull();
    expect(sb.api.calls).toHaveLength(0);
    expect(store.points()).toEqual([]);
  });

  it('shows 6 h by default and re-slices the loaded 24 h on toggle, without a new query', async () => {
    const rows = snapshotRows(24);
    const { store, sb } = setup({ token_snapshots: ok(rows) });
    store.setMint(CHART_MINT);
    await settle();
    expect(store.range()).toBe('6h');
    const six = store.points();
    const lastRow = rows[rows.length - 1];
    expect(six.at(-1)).toEqual({ t: Date.parse(lastRow.captured_at), price: lastRow.price_usd });
    expect(six[six.length - 1].t - six[0].t).toBeLessThanOrEqual(RANGE_MS['6h']);
    expect(six.length).toBe(181);

    store.setRange('24h');
    const day = store.points();
    expect(day.length).toBe(MAX_POINTS);
    expect(day[day.length - 1].t - day[0].t).toBe(RANGE_MS['24h']);
    expect(day.at(-1)).toEqual(six.at(-1));
    expect(sb.callsOf('token_snapshots')).toHaveLength(1);
  });

  it('ignores an unknown range', () => {
    const { store } = setup();
    store.setRange('7d' as never);
    expect(store.range()).toBe('6h');
  });

  it('appends the live token price when newer than the last snapshot', async () => {
    const end = Date.now() - 5 * 60_000;
    const { store } = setup({ token_snapshots: ok(snapshotRows(1, end)) });
    store.setMint(CHART_MINT);
    await settle();
    const before = store.points().length;
    store.setLive(0.0009, new Date(end + 60_000).toISOString());
    expect(store.points()).toHaveLength(before + 1);
    expect(store.points().at(-1)?.price).toBe(0.0009);
  });

  it('reads the user alerts and paper positions on the mint for markers', async () => {
    const now = Date.now();
    const { store, sb } = setup({
      token_snapshots: ok(snapshotRows(2, now)),
      alert_log: ok([{ sent_at: new Date(now - 30 * 60_000).toISOString(), entry_price: 0.00041 }]),
      paper_positions: ok([
        {
          id: 'p1',
          book: 'main',
          mint: CHART_MINT,
          symbol: 'GTA6',
          strategy: 'all_x2',
          stake_sol: 0.1,
          source: 'manual',
          status: 'closed',
          entry_target_price: 0.0004,
          fill_price: 0.000408,
          created_at: new Date(now - 60 * 60_000).toISOString(),
          filled_at: new Date(now - 50 * 60_000).toISOString(),
          legs: [
            { id: 'l1', position_id: 'p1', size_pct: 100, tp_price: 0.0008, stop_price: 0.0003, status: 'sl_hit', exit_price: 0.00039, closed_at: new Date(now - 20 * 60_000).toISOString() },
          ],
        },
      ]),
    });
    store.setMint(CHART_MINT);
    await settle();
    expect(sb.callsOf('alert_log')[0]?.query).toMatchObject({ mint: CHART_MINT, limit: MARKER_LIMIT });
    expect(sb.callsOf('paper_positions')[0]?.query).toMatchObject({ mint: CHART_MINT, limit: MARKER_LIMIT });
    expect(store.markers().map((m) => m.kind)).toEqual(['fill', 'alert', 'exit']);
  });

  it('drops markers outside the drawn time span', async () => {
    const now = Date.now();
    const { store } = setup({
      token_snapshots: ok(snapshotRows(2, now)),
      alert_log: ok([{ sent_at: new Date(now - 10 * 3_600_000).toISOString(), entry_price: 0.00041 }]),
    });
    store.setMint(CHART_MINT);
    await settle();
    expect(store.markers()).toEqual([]);
  });

  it('treats absent marker routes as « no markers » without failing the chart', async () => {
    const missing: QueryResult = { data: null, error: { code: '42P01', message: 'relation does not exist' } };
    const { store } = setup({
      token_snapshots: ok(snapshotRows(1)),
      alert_log: () => Promise.resolve(missing),
      paper_positions: () => Promise.reject(new Error('network')),
    });
    store.setMint(CHART_MINT);
    await settle();
    expect(store.failed()).toBe(false);
    expect(store.points().length).toBeGreaterThan(4);
    expect(store.markers()).toEqual([]);
  });

  it('reports a failed history query', async () => {
    const { store } = setup({ token_snapshots: () => Promise.resolve({ data: null, error: { message: 'boom' } }) });
    store.setMint(CHART_MINT);
    await settle();
    expect(store.failed()).toBe(true);
    expect(store.loading()).toBe(false);
    expect(store.points()).toEqual([]);
  });
});
