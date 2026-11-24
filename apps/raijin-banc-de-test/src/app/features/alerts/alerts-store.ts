import { Injectable, computed, inject, signal } from '@angular/core';
import { BENCH_ROUTES } from '@raijin/bench-contracts';
import { BenchApi, itemsOf } from '../../core/api/bench-api';
import { fetchTokenBriefs } from '../../core/api/token-briefs';
import { UserPreferences } from '../../core/preferences/user-preferences';
import { ALERT_FETCH_LIMIT, mergeAlerts, parseAlertLogRows, uniqueMints, type AlertItem, type AlertLogRow, SIMULATION_WINDOW_MS, simulateAlerts } from '@raijin/bench-web-logic/alerts';

/** The user's latest alerts and their 7-day simulation (`GET /api/alerts`, single and grouped alerts only). Provided by AlertsPage. */
@Injectable()
export class AlertsStore {
  private readonly api = inject(BenchApi);
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
      // Most recent first; archived radar ('early') alerts are not served by the API.
      const raw = itemsOf(await this.api.get(BENCH_ROUTES.alerts, { query: { limit: ALERT_FETCH_LIMIT } }));
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
      return await fetchTokenBriefs(this.api, mints);
    } catch {
      return [];
    }
  }
}
