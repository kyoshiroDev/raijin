import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { TokenRow } from '@raijin/bench-web-logic';
import { PriceChart } from './price-chart';
import { formatParisTime } from '@raijin/bench-web-logic/opportunities';
import {
  CHART_MINT,
  chartToken,
  mockBench,
  ok,
  snapshotRows,
  type QueryResult,
} from './price-chart-test-data';

const HOSTILE = '<img src=x onerror=alert(1)>';

async function render(token: TokenRow, responders: Parameters<typeof mockBench>[0]) {
  const sb = mockBench(responders);
  TestBed.configureTestingModule({ providers: sb.providers });
  const fixture = TestBed.createComponent(PriceChart);
  fixture.componentRef.setInput('token', token);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, sb };
}

async function refresh(fixture: ComponentFixture<PriceChart>) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

const surface = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-chart-surface]');

function key(el: HTMLElement, k: string) {
  surface(el)?.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
  );
}

describe('PriceChart', () => {
  it('shows a loading skeleton while the history loads', async () => {
    const sb = mockBench({ token_snapshots: () => new Promise<QueryResult>(() => undefined) });
    TestBed.configureTestingModule({ providers: sb.providers });
    const fixture = TestBed.createComponent(PriceChart);
    fixture.componentRef.setInput('token', chartToken());
    fixture.detectChanges();
    TestBed.tick();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-chart-skeleton]')?.getAttribute('role')).toBe('status');
    expect(el.textContent).toContain('Chargement du graphique');
    fixture.destroy();
  });

  it('aborts the queries when the detail closes', async () => {
    const sb = mockBench({ token_snapshots: () => new Promise<QueryResult>(() => undefined) });
    TestBed.configureTestingModule({ providers: sb.providers });
    const fixture = TestBed.createComponent(PriceChart);
    fixture.componentRef.setInput('token', chartToken());
    fixture.detectChanges();
    TestBed.tick();
    const signal = sb.callsOf('token_snapshots')[0]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal instanceof AbortSignal && signal.aborted).toBe(false);
    fixture.destroy();
    expect(signal instanceof AbortSignal && signal.aborted).toBe(true);
  });

  it('renders the chart with the current price label and an accessible summary (no zone band, no TP / stop lines)', async () => {
    // Fixed clock: the hour ticks of the 6 h window depend on the time of day.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T12:30:00Z'));
    try {
      const { el, sb } = await render(chartToken(), {
        token_snapshots: ok(snapshotRows(24, Date.now(), (i) => 0.00041 + (i % 10) * 0.000007)),
      });
      expect(sb.callsOf('token_snapshots').map((c) => c.params)).toEqual([{ mint: CHART_MINT }]);
      const chart = surface(el);
      expect(chart?.getAttribute('role')).toBe('img');
      expect(chart?.getAttribute('tabindex')).toBe('0');
      const label = chart?.getAttribute('aria-label') ?? '';
      expect(label).toMatch(/^Prix 6 h de GTA6 : de 0,00041 à 0,000473 \$, actuellement /);
      expect(label).not.toMatch(/stop|TP1|TP2|zone/i);
      expect(el.querySelector('[data-zone-band]')).toBeNull();
      expect(el.querySelectorAll('[data-level]')).toHaveLength(0);
      expect(Array.from(el.querySelectorAll('[data-label]')).map((l) => l.getAttribute('data-label'))).toEqual(['current']);
      expect(el.querySelector('[data-price-line]')?.getAttribute('d')).toMatch(/^M/);
      expect(el.querySelector('[data-current-dot]')).not.toBeNull();
      expect(el.querySelectorAll('[data-tick]').length).toBeGreaterThanOrEqual(3);
      const table = el.querySelector('[data-chart-table]');
      expect(table?.classList).toContain('sr-only');
      expect(table?.textContent).toContain('Plus bas');
      expect(table?.textContent).not.toContain('Stop (invalidation)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('switches between 6 h and 24 h', async () => {
    const { fixture, el } = await render(chartToken(), { token_snapshots: ok(snapshotRows(24)) });
    const six = el.querySelector<HTMLButtonElement>('[data-range="6h"]');
    const day = el.querySelector<HTMLButtonElement>('[data-range="24h"]');
    expect(six?.getAttribute('aria-pressed')).toBe('true');
    expect(day?.getAttribute('aria-pressed')).toBe('false');
    day?.click();
    await refresh(fixture);
    expect(day?.getAttribute('aria-pressed')).toBe('true');
    expect(surface(el)?.getAttribute('aria-label')).toMatch(/^Prix 24 h de GTA6/);
    expect(el.querySelector('caption')?.textContent).toContain('24 h');
  });

  it('draws alert and paper markers with a legend', async () => {
    const now = Date.now();
    const at = (min: number) => new Date(now - min * 60_000).toISOString();
    const { el } = await render(chartToken(), {
      token_snapshots: ok(snapshotRows(3, now)),
      alert_log: ok([{ sent_at: at(90), entry_price: 0.00041 }]),
      paper_positions: ok([
        {
          id: 'p1',
          book: 'main',
          mint: CHART_MINT,
          symbol: 'GTA6',
          strategy: 'all_x2',
          stake_sol: 0.1,
          source: 'auto_alert',
          status: 'closed',
          entry_target_price: 0.0004,
          fill_price: 0.000408,
          created_at: at(100),
          filled_at: at(80),
          legs: [
            {
              id: 'l1',
              position_id: 'p1',
              size_pct: 100,
              tp_price: 0.0008,
              stop_price: 0.0003,
              status: 'sl_hit',
              exit_price: 0.00039,
              closed_at: at(20),
            },
          ],
        },
      ]),
    });
    expect(
      Array.from(el.querySelectorAll('[data-marker]')).map((m) => m.getAttribute('data-marker')),
    ).toEqual(['alert', 'fill', 'exit']);
    const legend = el.querySelector('[data-chart-legend]')?.textContent ?? '';
    expect(legend).toContain('Alerte');
    expect(legend).toContain('Achat simulé');
    expect(legend).toContain('Sortie simulée');
    expect(el.querySelector('[data-chart-table]')?.textContent).toContain('Alerte reçue à');
  });

  it('shows no markers nor legend when the marker tables are unavailable', async () => {
    const missing = () => Promise.resolve<QueryResult>({ data: null, error: { code: 'PGRST204' } });
    const { el } = await render(chartToken(), {
      token_snapshots: ok(snapshotRows(2)),
      alert_log: missing,
      paper_positions: missing,
    });
    expect(surface(el)).not.toBeNull();
    expect(el.querySelectorAll('[data-marker]')).toHaveLength(0);
    expect(el.querySelector('[data-chart-legend]')).toBeNull();
  });

  it('scrubs with the keyboard: arrows move the crosshair, Escape hides it', async () => {
    const rows = snapshotRows(1);
    const { fixture, el } = await render(chartToken(), { token_snapshots: ok(rows) });
    expect(el.querySelector('[data-tooltip]')).toBeNull();

    key(el, 'ArrowLeft');
    await refresh(fixture);
    const last = rows[rows.length - 1];
    expect(el.querySelector('[data-crosshair]')).not.toBeNull();
    expect(el.querySelector('[data-tooltip]')?.textContent).toContain(
      formatParisTime(Date.parse(last!.captured_at)),
    );
    expect(el.querySelector('[data-scrub-live]')?.textContent).toContain(
      formatParisTime(Date.parse(last!.captured_at)),
    );

    key(el, 'ArrowLeft');
    await refresh(fixture);
    const prev = rows[rows.length - 2];
    expect(el.querySelector('[data-scrub-live]')?.textContent).toContain(
      formatParisTime(Date.parse(prev!.captured_at)),
    );

    key(el, 'Home');
    await refresh(fixture);
    expect(el.querySelector('[data-scrub-live]')?.textContent).toContain(
      formatParisTime(Date.parse(rows[0]!.captured_at)),
    );

    key(el, 'Escape');
    await refresh(fixture);
    expect(el.querySelector('[data-tooltip]')).toBeNull();
    expect(el.querySelector('[data-scrub-live]')?.textContent?.trim()).toBe('');
  });

  it('scrubs with a pointer (touch / drag)', async () => {
    const rows = snapshotRows(1);
    const { fixture, el } = await render(chartToken(), { token_snapshots: ok(rows) });
    const target = surface(el);
    if (!target) throw new Error('no chart');
    target.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 340,
      bottom: 200,
      width: 340,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const Ctor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    target.dispatchEvent(new Ctor('pointerdown', { clientX: 0, bubbles: true }));
    await refresh(fixture);
    expect(el.querySelector('[data-scrub-live]')?.textContent).toContain(
      formatParisTime(Date.parse(rows[0]!.captured_at)),
    );
  });

  it('shows « Pas assez d’historique » below 4 points', async () => {
    const { el } = await render(chartToken(), { token_snapshots: ok(snapshotRows(0.1).slice(-3)) });
    expect(el.querySelector('[data-chart-empty]')?.textContent).toContain('Pas assez d’historique');
    expect(surface(el)).toBeNull();
  });

  it('shows a generic message when the history cannot be read', async () => {
    const { el } = await render(chartToken(), {
      token_snapshots: () => Promise.resolve({ data: null, error: { message: 'raw db error' } }),
    });
    expect(el.querySelector('[data-chart-error]')?.textContent).toContain(
      'Historique indisponible',
    );
    expect(el.textContent).not.toContain('raw db error');
  });

  it('keeps a hostile symbol as plain attribute text', async () => {
    const { el } = await render(chartToken({ symbol: HOSTILE }), {
      token_snapshots: ok(snapshotRows(1)),
    });
    expect(surface(el)?.getAttribute('aria-label')).toContain(HOSTILE);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('[onerror]')).toBeNull();
  });
});
