import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { BENCH_ROUTES, type BenchEvent } from '@raijin/bench-contracts';
import { BenchApi, itemsOf } from '../../core/api/bench-api';
import { BenchEvents, type BenchEventSubscription } from '../../core/api/bench-events';
import { parseTokenRow, type TokenRow } from '@raijin/bench-web-logic';
import { DEFAULT_FILTERS, activeFilterCount, applyFilters, type OpportunityFilters } from '@raijin/bench-web-logic/opportunities';

const FRESH_WINDOW_MS = 30 * 60 * 1000; // only tokens refreshed in the last 30 min
const MAX_ROWS = 300;

@Injectable()
export class OpportunitiesStore {
  private readonly api = inject(BenchApi);
  private readonly events = inject(BenchEvents);
  private stream: BenchEventSubscription | null = null;

  private readonly _tokens = signal<TokenRow[]>([]);
  private readonly _loading = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _lastUpdate = signal<Date | null>(null);

  readonly filters = signal<OpportunityFilters>(DEFAULT_FILTERS);
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();
  readonly lastUpdate = this._lastUpdate.asReadonly();
  readonly tokens = this._tokens.asReadonly();
  readonly activeFilters = computed(() => activeFilterCount(this.filters()));
  /** Freshness of the data: most recent `updated_at` among loaded tokens, else last successful load. */
  readonly dataUpdatedAt = computed<Date | null>(() => {
    let latest = 0;
    for (const t of this._tokens()) {
      const ms = Date.parse(t.updated_at);
      if (Number.isFinite(ms) && ms > latest) latest = ms;
    }
    return latest > 0 ? new Date(latest) : this._lastUpdate();
  });
  readonly total = computed(() => this._tokens().length);
  readonly visible = computed(() => applyFilters(this._tokens(), this.filters()));
  /** « Afficher les tokens anciens » (page switch). */
  readonly showOld = computed(() => this.filters().showOld);

  setShowOld(showOld: boolean): void {
    this.filters.update((f) => ({ ...f, showOld }));
  }

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.stream?.close();
      this.stream = null;
    });
  }

  async load(): Promise<void> {
    if (this._loading()) return;
    this._loading.set(true);
    this._error.set(null);
    const since = new Date(Date.now() - FRESH_WINDOW_MS).toISOString();
    try {
      // Youngest pairs first (the list shows pairs < 24 h by default), sorted by the API.
      const body = await this.api.get(BENCH_ROUTES.tokens, { query: { since, limit: MAX_ROWS } });
      this._tokens.set(itemsOf(body).map(parseTokenRow).filter((t): t is TokenRow => t !== null));
      this._lastUpdate.set(new Date());
    } catch {
      this._error.set('Impossible de charger les opportunités. Réessaie dans un instant.');
    } finally {
      this._loading.set(false);
    }
  }

  /** Live updates (SSE `tokens`, ex-Realtime `tokens-live`). After a reconnection the list is reloaded (no replay). Idempotent. */
  listen(): void {
    if (this.stream) return;
    this.stream = this.events.connect(['tokens'], {
      onEvent: (event) => this.onEvent(event),
      onReconnect: () => void this.load(),
    });
  }

  private onEvent(event: BenchEvent): void {
    if (event.type === 'token.delete') {
      this._tokens.update((list) => list.filter((t) => t.mint !== event.mint));
    } else if (event.type === 'token.upsert') {
      const row = parseTokenRow(event.token);
      if (row) this.upsert(row);
    }
  }

  private upsert(row: TokenRow): void {
    this._tokens.update((list) => {
      const i = list.findIndex((t) => t.mint === row.mint);
      if (i === -1) return [row, ...list].slice(0, MAX_ROWS);
      const next = list.slice();
      next[i] = row;
      return next;
    });
    this._lastUpdate.set(new Date());
  }
}
