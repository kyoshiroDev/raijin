import { Injectable, computed, inject, signal } from '@angular/core';
import type { Alert } from '@raijin/shared-contracts';
import { toClientError, type ClientError } from '../http/api-error';
import { AlertsApi, DEFAULT_ALERT_FILTERS, type AlertFilters } from './alerts-api';
import { UnreadAlerts } from './unread-alerts';

export type AlertsStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Taille de page de l'historique. */
export const ALERTS_PAGE_SIZE = 20;

/**
 * Historique des alertes (écran Alertes) : pagination par curseur (« Charger plus »), filtres,
 * marquage lu / non lu. Fourni au niveau de l'écran. Le total de non lues renvoyé par l'API met
 * à jour le badge de navigation (`UnreadAlerts`).
 */
@Injectable()
export class AlertsStore {
  private readonly api = inject(AlertsApi);
  private readonly unread = inject(UnreadAlerts);
  private sequence = 0;

  private readonly currentItems = signal<readonly Alert[]>([]);
  private readonly currentFilters = signal<AlertFilters>(DEFAULT_ALERT_FILTERS);
  private readonly currentStatus = signal<AlertsStatus>('idle');
  private readonly currentError = signal<ClientError | null>(null);
  private readonly cursor = signal<string | null>(null);
  private readonly loadingMoreState = signal(false);
  private readonly loadMoreError = signal<ClientError | null>(null);

  readonly items = this.currentItems.asReadonly();
  readonly filters = this.currentFilters.asReadonly();
  readonly status = this.currentStatus.asReadonly();
  readonly error = this.currentError.asReadonly();
  readonly loadingMore = this.loadingMoreState.asReadonly();
  readonly moreError = this.loadMoreError.asReadonly();
  readonly hasMore = computed(() => this.cursor() !== null);
  readonly unreadCount = this.unread.count;
  /** Nombre de filtres actifs (pastille du bouton « Filtres »). */
  readonly activeFilterCount = computed(() => {
    const filters = this.currentFilters();
    return (filters.status !== 'all' ? 1 : 0) + (filters.types.length > 0 ? 1 : 0) + (filters.mint ? 1 : 0);
  });

  /** Première page avec les filtres donnés (remplace la liste). */
  async load(filters: AlertFilters = this.currentFilters()): Promise<void> {
    const id = ++this.sequence;
    this.currentFilters.set(filters);
    this.currentStatus.set('loading');
    this.loadMoreError.set(null);
    try {
      const page = await this.api.list(filters, null, ALERTS_PAGE_SIZE);
      if (id !== this.sequence) return;
      this.currentItems.set(page.items);
      this.cursor.set(page.nextCursor);
      this.unread.set(page.unread);
      this.currentError.set(null);
      this.currentStatus.set('ready');
    } catch (error) {
      if (id !== this.sequence) return;
      this.currentError.set(toClientError(error));
      this.currentStatus.set('error');
    }
  }

  /** Page suivante (« Charger plus »). Un échec garde la liste et propose de réessayer. */
  async loadMore(): Promise<void> {
    const cursor = this.cursor();
    if (!cursor || this.loadingMoreState()) return;
    const id = this.sequence;
    this.loadingMoreState.set(true);
    this.loadMoreError.set(null);
    try {
      const page = await this.api.list(this.currentFilters(), cursor, ALERTS_PAGE_SIZE);
      if (id !== this.sequence) return;
      const known = new Set(this.currentItems().map((alert) => alert.id));
      this.currentItems.update((items) => [...items, ...page.items.filter((alert) => !known.has(alert.id))]);
      this.cursor.set(page.nextCursor);
      this.unread.set(page.unread);
    } catch (error) {
      if (id === this.sequence) this.loadMoreError.set(toClientError(error));
    } finally {
      if (id === this.sequence) this.loadingMoreState.set(false);
    }
  }

  /**
   * Marque des alertes lues ou non lues (mise à jour optimiste, annulée si l'API refuse). Avec un
   * filtre lu / non lu, l'alerte reste affichée jusqu'au prochain chargement (le focus ne saute pas).
   */
  async markRead(ids: readonly string[], read: boolean): Promise<ClientError | null> {
    if (ids.length === 0) return null;
    const previous = this.currentItems();
    const now = new Date().toISOString();
    const targets = new Set(ids);
    this.currentItems.update((items) =>
      items.map((alert) => (targets.has(alert.id) ? { ...alert, readAt: read ? (alert.readAt ?? now) : null } : alert)),
    );
    try {
      const { unread } = await this.api.markRead({ ids: [...ids], read });
      this.unread.set(unread);
      return null;
    } catch (error) {
      this.currentItems.set(previous);
      return toClientError(error);
    }
  }

  /** « Tout marquer comme lu » (toutes les alertes du compte, pas seulement la page affichée). */
  async markAllRead(): Promise<ClientError | null> {
    const previous = this.currentItems();
    const now = new Date().toISOString();
    this.currentItems.update((items) => items.map((alert) => (alert.readAt ? alert : { ...alert, readAt: now })));
    try {
      const { unread } = await this.api.markRead({ all: true, read: true });
      this.unread.set(unread);
      return null;
    } catch (error) {
      this.currentItems.set(previous);
      return toClientError(error);
    }
  }
}
