import { Injectable, computed, inject, signal } from '@angular/core';
import { BENCH_ROUTES, type ShadowComparison, type ShadowTable } from '@raijin/bench-contracts';
import { BenchApi, isNotFound } from '../../core/api/bench-api';
import { parseShadowComparison, sortRows, summarizeByTable, windowRange, type ShadowWindow } from './shadow-comparison';

export const SHADOW_MSG = {
  loadFailed: 'Impossible de charger la comparaison. Réessaie dans un instant.',
  unavailable: 'La comparaison n’est pas encore disponible sur l’API du banc.',
} as const;

export type ShadowState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';

/** Comparaison VPS / `shadow_ref` (`GET /api/shadow/comparison?from=&to=&table=`), lecture seule. Fournie par la page. */
@Injectable()
export class ShadowComparisonStore {
  private readonly api = inject(BenchApi);
  private generation = 0;

  private readonly _state = signal<ShadowState>('idle');
  private readonly _data = signal<ShadowComparison | null>(null);
  private readonly _window = signal<ShadowWindow>(7);
  private readonly _table = signal<ShadowTable | null>(null);

  readonly state = this._state.asReadonly();
  readonly data = this._data.asReadonly();
  readonly window = this._window.asReadonly();
  readonly table = this._table.asReadonly();
  readonly rows = computed(() => sortRows(this._data()?.rows ?? []));
  readonly summaries = computed(() => summarizeByTable(this._data()?.rows ?? []));

  selectWindow(days: ShadowWindow): void {
    if (days === this._window()) return;
    this._window.set(days);
    void this.load();
  }

  selectTable(table: ShadowTable | null): void {
    if (table === this._table()) return;
    this._table.set(table);
    void this.load();
  }

  async load(now = Date.now()): Promise<void> {
    const gen = ++this.generation;
    this._state.set('loading');
    const { from, to } = windowRange(this._window(), now);
    try {
      const body = await this.api.get(BENCH_ROUTES.shadowComparison, { query: { from, to, table: this._table() ?? undefined } });
      if (gen !== this.generation) return;
      const data = parseShadowComparison(body);
      if (data === null) throw new Error('invalid');
      this._data.set(data);
      this._state.set('ready');
    } catch (error) {
      if (gen !== this.generation) return;
      this._state.set(isNotFound(error) ? 'unavailable' : 'error');
    }
  }
}
