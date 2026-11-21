import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { SUPABASE } from '../../core/supabase/supabase-client';
import { parseBackfillProgress, type BackfillProgress } from './backfill';
import {
  LAB_MSG,
  LEGACY_RUN_COLUMNS,
  NARRATIVES,
  RESULT_COLUMNS,
  RESULT_FETCH_LIMIT,
  RUN_COLUMNS,
  isActiveRun,
  isMissingColumnError,
  isMissingRelationError,
  narrativeCounts,
  parseResultRows,
  parseRun,
  rankVariants,
  requestErrorMessage,
  type BacktestRun,
  type LabNarrative,
  type ResultRow,
} from './backtest';
import { parseSummary, summaryView } from './lab-summary';

/** While a run is queued or running, the screen re-reads the run (and its results once done) this often. */
export const LAB_POLL_MS = 20_000;
/** While rows are due in the server catch-up, the gauge is re-read this often. */
export const BACKFILL_POLL_MS = 60_000;

export type LabState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';

/** idle = not read yet; unavailable = rpc('backfill_progress') not deployed; error = no data could be read. */
export type BackfillState = 'idle' | 'ready' | 'unavailable' | 'error';

export interface LabFeedback {
  kind: 'ok' | 'error';
  text: string;
}

/**
 * Backtest laboratory (Performance › Laboratoire). Reads the latest backtest_runs row, the latest DONE run and its
 * retained backtest_results rows (SELECT authenticated; only the young_calm / young_frenzy presets parse). The only
 * write is rpc('backtest_request_run'), which re-checks everything server-side. Also reads the server catch-up gauge
 * (rpc('backfill_progress'), read only).
 * No Realtime: a poll runs only while a run is queued / running (20 s) and while catch-up rows are due (60 s, gauge
 * only), both cleared on destroy. Provided by StrategyLabPage.
 */
@Injectable()
export class StrategyLabStore {
  private readonly supabase = inject(SUPABASE);
  private timer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private inFlight: Promise<void> | null = null;
  private backfillTimer: ReturnType<typeof setInterval> | null = null;
  private backfillInFlight: Promise<void> | null = null;
  /** backtest_runs.summary is not readable yet (lab-v2 grant not deployed): select the legacy columns. */
  private legacyColumns = false;

  private readonly _state = signal<LabState>('idle');
  private readonly _latest = signal<BacktestRun | null>(null);
  private readonly _lastDone = signal<BacktestRun | null>(null);
  private readonly _rows = signal<ResultRow[]>([]);
  private readonly _truncated = signal(false);
  private readonly _narrative = signal<LabNarrative>('all');
  private readonly _requesting = signal(false);
  private readonly _feedback = signal<LabFeedback | null>(null);
  private readonly _refreshing = signal(false);
  private readonly _backfill = signal<BackfillProgress | null>(null);
  private readonly _backfillState = signal<BackfillState>('idle');

  readonly state = this._state.asReadonly();
  /** Most recent run, whatever its status. */
  readonly latest = this._latest.asReadonly();
  /** Most recent finished run (its results are shown). */
  readonly lastDone = this._lastDone.asReadonly();
  readonly rows = this._rows.asReadonly();
  /** The retained rows reached the fetch limit: the ranking may be incomplete. */
  readonly truncated = this._truncated.asReadonly();
  readonly narrative = this._narrative.asReadonly();
  readonly requesting = this._requesting.asReadonly();
  readonly feedback = this._feedback.asReadonly();
  readonly refreshing = this._refreshing.asReadonly();
  readonly backfill = this._backfill.asReadonly();
  readonly backfillState = this._backfillState.asReadonly();

  /** A run is queued or running: the « Relancer » button is disabled and the poll is on. */
  readonly running = computed(() => isActiveRun(this._latest()));
  readonly canRequest = computed(() => this._state() === 'ready' && !this.running() && !this._requesting());
  readonly variants = computed(() => rankVariants(this._rows(), this._narrative()));
  readonly counts = computed(() => narrativeCounts(this._rows()));
  readonly robustCount = computed(() => this.counts()[this._narrative()].robust);
  /** Nightly verdict of the last finished run (null for runs written before lab-v2). */
  readonly summary = computed(() => {
    const run = this._lastDone();
    const summary = parseSummary(run?.summaryRaw);
    return summary === null ? null : summaryView(summary, run);
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.stopPoll();
      this.stopBackfillPoll();
    });
  }

  selectNarrative(n: LabNarrative): void {
    if (NARRATIVES.some((x) => x.id === n)) this._narrative.set(n);
  }

  async load(): Promise<void> {
    if (this._state() === 'loading') return;
    this._state.set('loading');
    await this.refresh();
  }

  /**
   * Re-reads runs, results and the catch-up gauge (refresh button and poll). Keeps the current data on failure of a
   * background refresh.
   */
  refresh(): Promise<void> {
    if (this.inFlight === null) {
      this._refreshing.set(true);
      this.inFlight = this.doRefresh().finally(() => {
        this.inFlight = null;
        this._refreshing.set(false);
      });
    }
    return this.inFlight;
  }

  private async doRefresh(): Promise<void> {
    await Promise.all([this.refreshRuns(), this.refreshBackfill()]);
    this.syncPoll();
  }

  private async refreshRuns(): Promise<void> {
    const background = this._state() === 'ready';
    try {
      const latest = await this.readRun(false);
      const lastDone = latest?.status === 'done' ? latest : await this.readRun(true);
      const sameRun = lastDone !== null && lastDone.id === this._lastDone()?.id && this._rows().length > 0;
      if (lastDone !== null && !sameRun) await this.readResults(lastDone.id);
      if (lastDone === null) {
        this._rows.set([]);
        this._truncated.set(false);
      }
      this._latest.set(latest);
      this._lastDone.set(lastDone);
      this._state.set('ready');
    } catch (error) {
      if (isMissingRelationError(error)) this._state.set('unavailable');
      else if (!background) this._state.set('error');
    }
  }

  /** Re-reads the catch-up gauge only (its own 60 s poll). Never touches the laboratory state. */
  refreshBackfill(): Promise<void> {
    this.backfillInFlight ??= this.readBackfill().finally(() => {
      this.backfillInFlight = null;
      this.syncBackfillPoll();
    });
    return this.backfillInFlight;
  }

  private async readBackfill(): Promise<void> {
    try {
      const { data, error } = await this.supabase.rpc('backfill_progress');
      if (error) throw error;
      const progress = parseBackfillProgress(data);
      if (progress === null) {
        if (this._backfill() === null) this._backfillState.set('unavailable');
        return;
      }
      this._backfill.set(progress);
      this._backfillState.set('ready');
    } catch (error) {
      if (isMissingRelationError(error)) {
        this._backfill.set(null);
        this._backfillState.set('unavailable');
      } else if (this._backfill() === null) {
        this._backfillState.set('error');
      }
    }
  }

  /** Asks the server for a manual run (refused there while one is queued / running or started < 10 min ago). */
  async requestRun(): Promise<void> {
    if (!this.canRequest()) return;
    this._requesting.set(true);
    this._feedback.set(null);
    try {
      const { error } = await this.supabase.rpc('backtest_request_run');
      if (error) {
        this._feedback.set({ kind: 'error', text: requestErrorMessage(error) });
      } else {
        this._feedback.set({ kind: 'ok', text: LAB_MSG.requested });
      }
    } catch {
      this._feedback.set({ kind: 'error', text: LAB_MSG.requestFailed });
    } finally {
      this._requesting.set(false);
    }
    await this.refresh();
  }

  private async readRun(doneOnly: boolean): Promise<BacktestRun | null> {
    let query = this.supabase.from('backtest_runs').select(this.legacyColumns ? LEGACY_RUN_COLUMNS : RUN_COLUMNS);
    if (doneOnly) query = query.eq('status', 'done');
    const { data, error } = await query.order('created_at', { ascending: false }).limit(1);
    if (error && !this.legacyColumns && isMissingColumnError(error)) {
      this.legacyColumns = true;
      return this.readRun(doneOnly);
    }
    if (error) throw error;
    return parseRun(data);
  }

  private async readResults(runId: string): Promise<void> {
    const { data, error } = await this.supabase
      .from('backtest_results')
      .select(RESULT_COLUMNS)
      .eq('run_id', runId)
      .eq('retained', true)
      .limit(RESULT_FETCH_LIMIT);
    if (error) throw error;
    this._rows.set(parseResultRows(data));
    this._truncated.set(Array.isArray(data) && data.length >= RESULT_FETCH_LIMIT);
  }

  private syncPoll(): void {
    if (this.running() && !this.destroyed) {
      this.timer ??= setInterval(() => void this.refresh(), LAB_POLL_MS);
    } else {
      this.stopPoll();
    }
  }

  private stopPoll(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private syncBackfillPoll(): void {
    const due = this._backfillState() === 'ready' && (this._backfill()?.dueNow ?? 0) > 0;
    if (due && !this.destroyed) {
      this.backfillTimer ??= setInterval(() => void this.refreshBackfill(), BACKFILL_POLL_MS);
    } else {
      this.stopBackfillPoll();
    }
  }

  private stopBackfillPoll(): void {
    if (this.backfillTimer !== null) clearInterval(this.backfillTimer);
    this.backfillTimer = null;
  }
}
