import { Injectable, computed, inject, signal } from '@angular/core';
import type { PlanLimits, Watch, WatchStatus } from '@raijin/shared-contracts';
import { toClientError, type ClientError } from '../http/api-error';
import { WatchesApi } from './watches-api';

export type WatchesStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Résultat d'une action sur un suivi : le suivi à jour, ou l'erreur à afficher. */
export type WatchOutcome = { ok: true; watch: Watch | null } | { ok: false; error: ClientError };

/** Ordre d'affichage : actifs d'abord, puis du plus récent au plus ancien. */
function sortWatches(items: readonly Watch[]): Watch[] {
  return [...items].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/**
 * Store des suivis (signals), partagé par l'écran Suivis et le bouton « Suivre » de l'analyse.
 * Les limites viennent toujours de l'API (`PlanLimits`) : le front ne les calcule jamais, il les
 * affiche. Chargé seulement à la demande (aucune requête au démarrage).
 */
@Injectable({ providedIn: 'root' })
export class WatchesStore {
  private readonly api = inject(WatchesApi);
  private request: Promise<void> | null = null;

  private readonly currentItems = signal<readonly Watch[]>([]);
  private readonly currentLimits = signal<PlanLimits | null>(null);
  private readonly currentStatus = signal<WatchesStatus>('idle');
  private readonly currentError = signal<ClientError | null>(null);
  private readonly busyIds = signal<ReadonlySet<string>>(new Set());

  readonly items = this.currentItems.asReadonly();
  readonly limits = this.currentLimits.asReadonly();
  readonly status = this.currentStatus.asReadonly();
  readonly error = this.currentError.asReadonly();
  readonly busy = this.busyIds.asReadonly();
  readonly activeCount = computed(() => this.currentItems().filter((watch) => watch.status === 'active').length);
  readonly pausedCount = computed(() => this.currentItems().filter((watch) => watch.status === 'paused').length);
  /** Limite atteinte (création et reprise refusées par l'API). */
  readonly limitReached = computed(() => {
    const limits = this.currentLimits();
    return limits !== null && this.activeCount() >= limits.maxActiveWatches;
  });

  /** Charge la liste (une requête à la fois). `force` : bouton « Réessayer » ou retour sur l'écran. */
  load(force = false): Promise<void> {
    if (this.request) return this.request;
    if (!force && this.currentStatus() === 'ready') return Promise.resolve();
    if (this.currentStatus() !== 'ready') this.currentStatus.set('loading');
    this.request = this.api
      .list()
      .then(
        (response) => {
          this.currentItems.set(sortWatches(response.items));
          this.currentLimits.set(response.limits);
          this.currentError.set(null);
          this.currentStatus.set('ready');
        },
        (error: unknown) => {
          this.currentError.set(toClientError(error));
          // Liste déjà affichée : on la garde (l'écran signale l'échec par un toast).
          if (this.currentStatus() !== 'ready') this.currentStatus.set('error');
        },
      )
      .finally(() => (this.request = null));
    return this.request;
  }

  /** Suivi existant pour ce mint (liste chargée), sinon `undefined`. */
  findByMint(mint: string): Watch | undefined {
    return this.currentItems().find((watch) => watch.mint === mint);
  }

  isBusy(key: string): boolean {
    return this.busyIds().has(key);
  }

  /** Suit un mint analysé (idempotent côté API). */
  follow(mint: string): Promise<WatchOutcome> {
    return this.run(mint, async () => {
      const watch = await this.api.create(mint);
      this.upsert(watch);
      return watch;
    });
  }

  /** Pause ou reprise (reprise refusée au-delà de la limite : `WATCH_LIMIT_REACHED`). */
  setStatus(id: string, status: WatchStatus): Promise<WatchOutcome> {
    return this.run(id, async () => {
      const watch = await this.api.update(id, status);
      this.upsert(watch);
      return watch;
    });
  }

  /** Retire un suivi (un suivi déjà absent côté API est aussi retiré de la liste). */
  remove(id: string): Promise<WatchOutcome> {
    return this.run(id, async () => {
      try {
        await this.api.remove(id);
      } catch (error) {
        if (toClientError(error).code !== 'WATCH_NOT_FOUND') throw error;
      }
      this.currentItems.update((items) => items.filter((watch) => watch.id !== id));
      return null;
    });
  }

  /** Oublie tout (déconnexion). */
  reset(): void {
    this.currentItems.set([]);
    this.currentLimits.set(null);
    this.currentError.set(null);
    this.currentStatus.set('idle');
  }

  private upsert(watch: Watch): void {
    this.currentItems.update((items) => sortWatches([watch, ...items.filter((item) => item.id !== watch.id && item.mint !== watch.mint)]));
  }

  private async run(key: string, action: () => Promise<Watch | null>): Promise<WatchOutcome> {
    this.busyIds.update((set) => new Set(set).add(key));
    try {
      return { ok: true, watch: await action() };
    } catch (error) {
      return { ok: false, error: toClientError(error) };
    } finally {
      this.busyIds.update((set) => {
        const next = new Set(set);
        next.delete(key);
        return next;
      });
    }
  }
}
