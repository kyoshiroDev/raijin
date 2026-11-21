import { Injectable, computed, inject, signal } from '@angular/core';
import { UserPreferences } from '../../core/preferences/user-preferences';
import { SUPABASE } from '../../core/supabase/supabase-client';
import {
  ALERT_FETCH_LIMIT,
  ALERT_LOG_COLUMNS,
  ALERT_TOKEN_COLUMNS,
  mergeAlerts,
  parseAlertLogRows,
  uniqueMints,
  type AlertItem,
  type AlertLogRow,
} from './alert-log';
import { SIMULATION_WINDOW_MS, simulateAlerts } from './alert-simulation';

/** The user's latest alerts and their 7-day simulation (alert_log is owner-readable only, RLS). Provided by AlertsPage. */
@Injectable()
export class AlertsStore {
  private readonly supabase = inject(SUPABASE);
  private readonly preferences = inject(UserPreferences);

  private readonly _rows = signal<AlertLogRow[]>([]);
  private readonly _items = signal<AlertItem[]>([]);
  private readonly _now = signal(Date.now());
  private readonly _truncated = signal(false);
  private readonly _loading = signal(false);
  private readonly _loaded = signal(false);
  private readonly _error = signal<string | null>(null);

  readonly items = this._items.asReadonly();
  /** Reference time of the last load (« il y a X min », end of tracking, 7-day window). */
  readonly now = this._now.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly loaded = this._loaded.asReadonly();
  readonly error = this._error.asReadonly();
  readonly empty = computed(() => this._loaded() && !this._error() && this._items().length === 0);
  readonly summary = computed(() => simulateAlerts(this._rows(), { now: this._now(), stakeSol: this.preferences.stakeSol() }));
  /** The fetch limit was reached while the oldest fetched alert is still inside the window. */
  readonly truncated = this._truncated.asReadonly();

  async load(): Promise<void> {
    if (this._loading()) return;
    this._loading.set(true);
    this._error.set(null);
    try {
      const { data, error } = await this.supabase
        .from('alert_log')
        .select(ALERT_LOG_COLUMNS)
        .in('kind', ['single', 'grouped']) // archived radar ('early') alerts are not shown: don't let them eat the limit
        .order('sent_at', { ascending: false })
        .limit(ALERT_FETCH_LIMIT);
      if (error) throw error;
      const raw: unknown[] = Array.isArray(data) ? data : [];
      const rows = parseAlertLogRows(raw);
      const now = Date.now();
      const oldest = rows.at(-1);
      this._now.set(now);
      this._rows.set(rows);
      this._truncated.set(raw.length >= ALERT_FETCH_LIMIT && oldest !== undefined && now - Date.parse(oldest.sent_at) < SIMULATION_WINDOW_MS);
      this._items.set(mergeAlerts(rows, await this.loadTokens(rows)));
    } catch {
      this._error.set('Impossible de charger tes alertes. Réessaie dans un instant.');
    } finally {
      this._loading.set(false);
      this._loaded.set(true);
    }
  }

  /** Symbol of the alerted tokens (not their current score). Optional: on failure the list shows the mints only. */
  private async loadTokens(rows: readonly AlertLogRow[]): Promise<unknown[]> {
    const mints = uniqueMints(rows);
    if (mints.length === 0) return [];
    try {
      const { data, error } = await this.supabase.from('tokens').select(ALERT_TOKEN_COLUMNS).in('mint', mints);
      return !error && Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }
}
