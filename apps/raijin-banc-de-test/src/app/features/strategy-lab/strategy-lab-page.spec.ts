import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { SUPABASE } from '../../core/supabase/supabase-client';
import { backfillRows, candidateSummary, fakeSupabase, rpcByName, runRow, variantRows, type QueryCall, type QueryResult } from './lab-test-data';
import { StrategyLabPage } from './strategy-lab-page';

async function render(handler: (call: QueryCall) => Promise<QueryResult>, rpc?: (name: string) => Promise<QueryResult>) {
  const fake = fakeSupabase(handler, rpc);
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: SUPABASE, useValue: fake.supabase }] });
  const fixture = TestBed.createComponent(StrategyLabPage);
  fixture.detectChanges();
  const settle = async () => {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    fixture.detectChanges();
  };
  await settle();
  const el = fixture.nativeElement as HTMLElement;
  const click = async (selector: string) => {
    el.querySelector<HTMLButtonElement>(selector)?.click();
    fixture.detectChanges();
    await settle();
  };
  return { el, click, rpc: fake.rpc };
}

const tables =
  (latest: unknown, results: unknown[], done: unknown = latest) =>
  async (call: QueryCall): Promise<QueryResult> => {
    if (call.table === 'backtest_runs') return { data: [call.filters['status'] === 'done' ? done : latest].filter(Boolean), error: null };
    return { data: results, error: null };
  };

describe('StrategyLabPage', () => {
  it('shows the switch, the permanent disclaimer, the run facts and the ranked variants with train vs test', async () => {
    const { el } = await render(tables(runRow(), [...variantRows(), ...variantRows({ sl_pct: 20, delay_min: 0, robust: false, avg_net_pct: 20 })]));
    expect(el.querySelector('[data-perf-view="lab"]')?.getAttribute('aria-current')).toBe('page');
    expect(el.querySelector('[data-lab-disclaimer]')?.textContent).toContain('ne prédit pas le futur');
    expect(el.querySelector('[data-run-status]')?.textContent?.trim()).toBe('Terminé');
    expect(el.querySelector('[data-fact="detections"]')?.textContent).toContain('600');
    expect(el.querySelector('[data-fact="distinct"]')?.textContent?.replace(/\s/g, '')).toContain('1440');
    expect(el.querySelector('[data-resolutions]')?.textContent).toContain('20 %');
    const names = Array.from(el.querySelectorAll('[data-variant-name]')).map((n) => n.textContent?.replace(/\s+/g, ' ').trim());
    expect(names).toEqual([
      'Rang 1 : SL −20 % · entrée immédiate · Jeune calme (à la détection)',
      'Rang 2 : SL −30 % · entrée +2 min · Jeune calme (à la détection)',
    ]);
    const robust = el.querySelectorAll('app-variant-card[data-robust]');
    expect(robust).toHaveLength(1);
    expect(robust[0].querySelector('[data-robust-badge]')?.textContent?.trim()).toBe('Robuste');
    const net = robust[0].querySelectorAll('[data-metric="net"] td');
    expect(Array.from(net).map((td) => td.textContent?.trim())).toEqual(['+9,1 %', '+12,5 %']);
    expect(robust[0].querySelector('[data-ci]')?.textContent).toContain('[+2,1 % ; +22,4 %]');
    expect(el.querySelector('[data-no-robust]')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-request-run]')?.disabled).toBe(false);
  });

  it('filters by narrative and says when there is no robust variant', async () => {
    const { el, click } = await render(tables(runRow(), [...variantRows(), ...variantRows({ narrative: 'gta', robust: false })]));
    await click('[data-narrative="gta"]');
    expect(el.querySelectorAll('app-variant-card')).toHaveLength(1);
    expect(el.querySelector('[data-no-robust]')?.textContent).toContain('Aucune variante robuste pour l’instant');
    await click('[data-narrative="other"]');
    expect(el.querySelectorAll('app-variant-card')).toHaveLength(0);
    expect(el.querySelector('[data-no-robust] [data-empty-title]')?.textContent).toContain('Aucune variante robuste pour l’instant');
  });

  it('renders hostile-looking text only as text', async () => {
    const { el } = await render(tables(runRow(), [...variantRows(), { ...variantRows()[0], preset: '<img src=x onerror=alert(1)>' }]));
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelectorAll('app-variant-card')).toHaveLength(1);
  });

  it('disables « Relancer » while a run is in progress and shows its progress', async () => {
    const { el } = await render(tables(runRow({ id: 8, status: 'running', progress: 0.4 }), variantRows(), runRow()));
    expect(el.querySelector('[data-run-status]')?.textContent?.trim()).toBe('En cours');
    expect(el.querySelector('[data-run-progress]')?.textContent).toContain('40 %');
    const button = el.querySelector<HTMLButtonElement>('[data-request-run]');
    expect(button?.disabled).toBe(true);
    expect(button?.textContent?.trim()).toBe('Backtest en cours…');
    TestBed.resetTestingModule();
  });

  it('relaunches through the RPC and shows the French refusal', async () => {
    const { el, click, rpc } = await render(
      tables(runRow(), variantRows()),
      rpcByName({ backtest_request_run: async () => ({ data: null, error: { code: '23514', message: 'Un backtest est déjà en file d’attente.' } }) }),
    );
    await click('[data-request-run]');
    expect(rpc).toHaveBeenCalledWith('backtest_request_run');
    expect(el.querySelector('[data-lab-feedback]')?.textContent?.trim()).toBe('Un backtest est déjà en file d’attente.');
    expect(el.querySelector('[data-lab-feedback]')?.getAttribute('role')).toBe('alert');
  });

  it('says when the laboratory is not deployed yet, and when no backtest has finished', async () => {
    const missing = await render(async () => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } }));
    expect(missing.el.querySelector('[data-lab-unavailable]')).not.toBeNull();
    expect(missing.el.querySelector('[data-lab-disclaimer]')).not.toBeNull();
    TestBed.resetTestingModule();
    const empty = await render(tables(null, [], null));
    expect(empty.el.querySelector('[data-no-done-run]')?.textContent).toContain('Aucun backtest terminé');
    expect(empty.el.querySelector('app-narrative-filter')).toBeNull();
  });

  it('shows the nightly verdict at the top: a candidate with its figures, or « Aucune stratégie robuste »', async () => {
    const { el } = await render(tables(runRow({ summary: candidateSummary() }), variantRows()));
    const banner = el.querySelector('[data-lab-summary]');
    expect(banner?.getAttribute('data-verdict')).toBe('candidate');
    expect(banner?.compareDocumentPosition(el.querySelector('[data-lab-disclaimer]') as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(el.querySelector('[data-summary-title]')?.textContent?.trim()).toBe(
      'Stratégie candidate : SL −30 % · entrée +2 min · Jeune calme (à la détection)',
    );
    expect(el.querySelectorAll('[data-summary-detail]')).toHaveLength(2);
    expect(el.querySelector('[data-summary-meta]')?.textContent).toContain('140 événements');
    expect(el.querySelector('[data-summary-caveat]')).not.toBeNull();
    TestBed.resetTestingModule();
    const none = await render(tables(runRow({ summary: { verdict: 'none', run_at: '2026-11-19T03:10:00Z', n_detections: 600, n_events: 0 } }), []));
    expect(none.el.querySelector('[data-summary-title]')?.textContent?.trim()).toBe('Aucune stratégie robuste');
    expect(none.el.querySelector('[data-summary-caveat]')).toBeNull();
    TestBed.resetTestingModule();
    const legacy = await render(tables(runRow(), []));
    expect(legacy.el.querySelector('[data-lab-summary]')).toBeNull();
  });

  it('shows the events, the events waiting for candles and the event preset names', async () => {
    const run = runRow({ data_version: { ...(runRow()['data_version'] as object), events: 140, events_pending: 12 } });
    const { el } = await render(tables(run, variantRows({ preset: 'young_frenzy_ev' })));
    expect(el.querySelector('[data-fact="events"]')?.textContent).toContain('140');
    expect(el.querySelector('[data-pending-candles]')?.textContent).toContain('12 événements en attente de bougies');
    expect(el.querySelector('[data-variant-name]')?.textContent).toContain('Jeune frénésie (événement)');
    TestBed.resetTestingModule();
    const v1 = await render(tables(runRow(), []));
    expect(v1.el.querySelector('[data-fact="events"]')).toBeNull();
    expect(v1.el.querySelector('[data-pending-candles]')).toBeNull();
  });

  it('shows one accessible progress bar per catch-up category with throughput and ETA', async () => {
    const { el } = await render(tables(runRow(), []), rpcByName({ backfill_progress: async () => ({ data: backfillRows(), error: null }) }));
    const bars = Array.from(el.querySelectorAll('[data-backfill] [role="progressbar"]'));
    expect(bars).toHaveLength(3);
    const scan = el.querySelector('[data-backfill-category="scan_labels"] [role="progressbar"]');
    expect(scan?.getAttribute('aria-valuenow')).toBe('1000');
    expect(scan?.getAttribute('aria-valuemax')).toBe('1392');
    expect(scan?.getAttribute('aria-valuemin')).toBe('0');
    expect(scan?.getAttribute('aria-valuetext')?.replace(/\s/g, ' ')).toContain('392 dues');
    const labelId = scan?.getAttribute('aria-labelledby') ?? '';
    expect(el.querySelector(`#${labelId}`)?.textContent).toBe('Étiquettes scan');
    const summary = el.querySelector('[data-backfill-summary]')?.textContent ?? '';
    expect(summary).toContain('lignes/h');
    expect(summary).toContain('fin estimée');
    TestBed.resetTestingModule();
  });

  it('says the gauge is not available yet when the RPC is missing, even if the laboratory is not deployed', async () => {
    const { el } = await render(async () => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } }));
    expect(el.querySelector('[data-lab-unavailable]')).not.toBeNull();
    expect(el.querySelector('[data-backfill-unavailable]')?.textContent).toContain('pas encore disponible');
    expect(el.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('has no exploratory section any more, and ignores rows of removed presets or a removed candidate', async () => {
    const handler = async (call: QueryCall): Promise<QueryResult> => {
      if (call.table === 'backtest_runs') return { data: [runRow({ summary: candidateSummary({ candidate: { preset: 'young_3h_explo' } }) })], error: null };
      return { data: [...variantRows(), ...variantRows({ preset: 'momentum_explo', avg_net_pct: 80 }), ...variantRows({ preset: 'post_migration' })], error: null };
    };
    const { el } = await render(handler);
    expect(el.querySelector('[data-lab-summary]')).toBeNull();
    expect(el.querySelector('[data-exploratory-section], #lab-exploratory, [data-exploratory-badge]')).toBeNull();
    expect(el.querySelector('[aria-labelledby="lab-ranking"]')?.querySelectorAll('app-variant-card')).toHaveLength(1);
    expect(el.textContent).toContain('stop −20 / −30 / −40 %');
  });
});
