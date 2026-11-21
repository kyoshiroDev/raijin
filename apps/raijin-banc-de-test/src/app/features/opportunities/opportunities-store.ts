import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { SUPABASE } from '../../core/supabase/supabase-client';
import { TOKEN_COLUMNS, parseTokenRow, type TokenRow } from '../../shared/models/token';
import { DEFAULT_FILTERS, activeFilterCount, applyFilters, type OpportunityFilters } from './opportunity-filters';

const FRESH_WINDOW_MS = 30 * 60 * 1000; // only tokens refreshed in the last 30 min
const MAX_ROWS = 300;

@Injectable()
export class OpportunitiesStore {
  private readonly supabase = inject(SUPABASE);
  private channel: RealtimeChannel | null = null;

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
      if (this.channel) void this.supabase.removeChannel(this.channel);
    });
  }

  async load(): Promise<void> {
    if (this._loading()) return;
    this._loading.set(true);
    this._error.set(null);
    const since = new Date(Date.now() - FRESH_WINDOW_MS).toISOString();
    try {
      const { data, error } = await this.supabase
        .from('tokens')
        .select(TOKEN_COLUMNS)
        .gte('updated_at', since)
        // Youngest pairs first (the list shows pairs < 24 h by default); the score column is archived.
        .order('pair_created_at', { ascending: false, nullsFirst: false })
        .limit(MAX_ROWS);
      if (error) throw error;
      this._tokens.set((data as unknown[]).map(parseTokenRow).filter((t): t is TokenRow => t !== null));
      this._lastUpdate.set(new Date());
    } catch {
      this._error.set('Impossible de charger les opportunités. Réessaie dans un instant.');
    } finally {
      this._loading.set(false);
    }
  }

  listen(): void {
    if (this.channel) return;
    this.channel = this.supabase
      .channel('tokens-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tokens' }, (payload) => {
        if (payload.eventType === 'DELETE') {
          const old = payload.old as Partial<TokenRow>;
          this._tokens.update((list) => list.filter((t) => t.mint !== old.mint));
        } else {
          const row = parseTokenRow(payload.new);
          if (row) this.upsert(row);
        }
      })
      .subscribe();
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
