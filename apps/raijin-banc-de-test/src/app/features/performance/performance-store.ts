import { Injectable, computed, inject, signal } from '@angular/core';
import { BENCH_ROUTES } from '@raijin/bench-contracts';
import { BenchApi, isNotFound, itemsOf } from '../../core/api/bench-api';
import { bookComparisonView, parseBookComparisonRows, type BookComparisonRow } from './book-comparison';
import { parseBreakdownRows, sourceView, type BreakdownRow } from './performance-breakdown';
import { comparisonView, isComparisonSegment, parsePresetRows, type PresetRow, type PresetSegment } from './preset-performance';

export const LOAD_ERROR = 'Impossible de charger les performances. Réessaie dans un instant.';
export const PRESET_LOAD_ERROR = 'Impossible de charger les résultats par profil. Réessaie dans un instant.';
export const BOOKS_LOAD_ERROR = 'Impossible de charger les portefeuilles de test. Réessaie dans un instant.';

/** State of the « Calme vs Frénésie » card, independent of the breakdown below it. */
export type PresetState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
/** State of the « Portefeuilles de test » card (same lifecycle, independent of the rest). */
export type BookCompareState = PresetState;

/**
 * Aggregated outcomes computed by the bench API (ex-RPC): `GET /api/performance/breakdown` (main scanner, per
 * dimension bucket), `GET /api/performance/presets` (« Calme vs Frénésie »: young_calm / young_frenzy) and
 * `GET /api/performance/books` (the three test books). Provided by PerformancePage. Read-only: nothing is written from
 * this screen. Each card fails or degrades on its own, never the breakdown. A 404 (route not deployed) reads as
 * « unavailable ».
 */
@Injectable()
export class PerformanceStore {
  private readonly api = inject(BenchApi);

  private readonly _rows = signal<BreakdownRow[]>([]);
  private readonly _loading = signal(false);
  private readonly _loaded = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _unavailable = signal(false);
  private readonly _presetRows = signal<PresetRow[]>([]);
  private readonly _presetState = signal<PresetState>('idle');
  private readonly _comparisonSegment = signal<PresetSegment>('all');
  private readonly _bookRows = signal<BookComparisonRow[]>([]);
  private readonly _bookState = signal<BookCompareState>('idle');

  readonly rows = this._rows.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly loaded = this._loaded.asReadonly();
  readonly error = this._error.asReadonly();
  /** The route is not deployed yet: the screen says so instead of an error. */
  readonly unavailable = this._unavailable.asReadonly();
  readonly presetRows = this._presetRows.asReadonly();
  readonly presetState = this._presetState.asReadonly();
  readonly comparisonSegment = this._comparisonSegment.asReadonly();
  /** « Calme vs Frénésie » (young_calm / young_frenzy rows of performance_by_preset). */
  readonly comparison = computed(() => comparisonView(this._presetRows(), this._comparisonSegment()));
  readonly bookRows = this._bookRows.asReadonly();
  readonly bookState = this._bookState.asReadonly();
  /** « Portefeuilles de test »: calm_sl30 / calm_sl40 / frenzy_sl30 side by side, with the progress to the target. */
  readonly bookComparison = computed(() => bookComparisonView(this._bookRows()));

  /** Main scanner only (the other sources were removed with Radar and the old presets). */
  readonly view = computed(() => sourceView(this._rows(), 'scan'));

  /** Shared segment of the « Calme vs Frénésie » card; an unknown segment is ignored. */
  selectComparisonSegment(segment: PresetSegment): void {
    if (isComparisonSegment(segment)) this._comparisonSegment.set(segment);
  }

  /** Re-reads the per-preset rows only (retry button of the card). */
  async loadPresets(): Promise<void> {
    if (this._presetState() === 'loading') return;
    this._presetState.set('loading');
    try {
      this._presetRows.set(parsePresetRows(itemsOf(await this.api.get(BENCH_ROUTES.performancePresets))));
      this._presetState.set('ready');
    } catch (error) {
      this._presetState.set(isNotFound(error) ? 'unavailable' : 'error');
    }
  }

  /** Re-reads the test-book rows only (retry button of the card). */
  async loadBooks(): Promise<void> {
    if (this._bookState() === 'loading') return;
    this._bookState.set('loading');
    try {
      this._bookRows.set(parseBookComparisonRows(itemsOf(await this.api.get(BENCH_ROUTES.performanceBooks))));
      this._bookState.set('ready');
    } catch (error) {
      this._bookState.set(isNotFound(error) ? 'unavailable' : 'error');
    }
  }

  async load(): Promise<void> {
    if (this._loading()) return;
    this._loading.set(true);
    this._error.set(null);
    void this.loadBooks();
    void this.loadPresets();
    try {
      this._rows.set(await this.loadBreakdown());
    } catch {
      this._error.set(LOAD_ERROR);
    } finally {
      this._loading.set(false);
      this._loaded.set(true);
    }
  }

  private async loadBreakdown(): Promise<BreakdownRow[]> {
    let body: unknown;
    try {
      body = await this.api.get(BENCH_ROUTES.performanceBreakdown);
    } catch (error) {
      if (isNotFound(error)) {
        this._unavailable.set(true);
        return [];
      }
      throw error;
    }
    this._unavailable.set(false);
    return parseBreakdownRows(itemsOf(body));
  }
}
