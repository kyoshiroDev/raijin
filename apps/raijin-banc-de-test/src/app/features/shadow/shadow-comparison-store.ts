import { Injectable, computed, inject, signal } from '@angular/core';
import { BENCH_ROUTES, evaluateShadowAcceptance, type ShadowComparison, type ShadowTable } from '@raijin/bench-contracts';
import { BenchApi, isNotFound } from '../../core/api/bench-api';
import { parseShadowComparison, snapshotRange, sortRows, summarizeByTable, windowRange, type ShadowWindow } from './shadow-comparison';

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
  private readonly _window = signal<ShadowWindow>('snapshot');
  private readonly _table = signal<ShadowTable | null>(null);

  readonly state = this._state.asReadonly();
  readonly data = this._data.asReadonly();
  readonly window = this._window.asReadonly();
  readonly table = this._table.asReadonly();
  readonly rows = computed(() => sortRows(this._data()?.rows ?? []));
  readonly summaries = computed(() => summarizeByTable(this._data()?.rows ?? []));
  /** Verdict de bascule (seuils officiels de `@raijin/bench-contracts`) ; seulement sans filtre de table. */
  readonly acceptance = computed(() => {
    const data = this._data();
    return data && this._table() === null ? evaluateShadowAcceptance(data) : null;
  });

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
    const choice = this._window();
    try {
      // « Instantané » : la fenêtre n'est connue qu'après une première réponse (7 derniers jours), puis on relit
      // exactement les jours de l'instantané.
      const known = this._data()?.snapshot_window ?? null;
      let range = choice === 'snapshot' ? (known ? snapshotRange(known) : windowRange(7, now)) : windowRange(choice, now);
      let data = await this.fetch(range);
      if (gen !== this.generation) return;
      if (choice === 'snapshot' && data.snapshot_window) {
        const exact = snapshotRange(data.snapshot_window);
        if (exact.from !== range.from || exact.to !== range.to) {
          range = exact;
          data = await this.fetch(range);
          if (gen !== this.generation) return;
        }
      }
      this._data.set(data);
      this._state.set('ready');
    } catch (error) {
      if (gen !== this.generation) return;
      this._state.set(isNotFound(error) ? 'unavailable' : 'error');
    }
  }

  private async fetch(range: { from: string; to: string }): Promise<ShadowComparison> {
    const body = await this.api.get(BENCH_ROUTES.shadowComparison, { query: { ...range, table: this._table() ?? undefined } });
    const data = parseShadowComparison(body);
    if (data === null) throw new Error('invalid');
    return data;
  }
}
