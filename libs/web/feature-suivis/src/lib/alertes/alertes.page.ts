import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChildren,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { Router } from '@angular/router';
import { ALERT_TYPES, type AlertReadFilter, type AlertType } from '@raijin/shared-contracts';
import { isSolanaAddress } from '@raijin/shared-util';
import { AlertsStore, AuthStore, DEFAULT_ALERT_FILTERS, WatchesStore, type AlertFilters } from '@raijin/web-data-access';
import { RjBottomSheet, RjButton, RjEmptyState, RjErrorState, RjIcon, RjSkeleton, RjToastService } from '@raijin/web-ui';
import { tokenLabel } from '../shared/format';
import { RjAlertFilters, type TokenOption } from './alert-filters';
import { RjAlertItem } from './alert-item';

/** Valeurs de `?statut=` (URL en français, partageable). */
const STATUS_PARAMS: Readonly<Record<string, AlertReadFilter>> = { 'non-lues': 'unread', lues: 'read' };
const STATUS_TO_PARAM: Readonly<Record<AlertReadFilter, string | null>> = { all: null, unread: 'non-lues', read: 'lues' };

/** Filtres lus dans l'URL (valeurs inconnues ignorées). */
export function filtersFromQuery(statut: string | undefined, type: string | undefined, mint: string | undefined): AlertFilters {
  const known = new Set<string>(ALERT_TYPES);
  const requested = new Set((type ?? '').split(',').filter((part) => known.has(part)));
  return {
    status: (statut && Object.hasOwn(STATUS_PARAMS, statut) ? STATUS_PARAMS[statut] : undefined) ?? 'all',
    types: ALERT_TYPES.filter((item): item is AlertType => requested.has(item)),
    mint: mint && isSolanaAddress(mint) ? mint : null,
  };
}

/** Paramètres d'URL des filtres (`null` retire le paramètre). */
export function queryFromFilters(filters: AlertFilters): Record<string, string | null> {
  return {
    statut: STATUS_TO_PARAM[filters.status],
    type: filters.types.length > 0 ? filters.types.join(',') : null,
    mint: filters.mint,
    alerte: null,
  };
}

const CLOCK_MS = 60_000;

/**
 * Écran « Alertes » : historique paginé par curseur (« Charger plus »), filtres (état, type, token)
 * dans une bottom sheet sous 1024 px et un panneau latéral au-delà, lu / non lu, « Tout marquer
 * comme lu ». Les filtres vivent dans l'URL (`?statut=non-lues&type=…&mint=…`) ; `?alerte=<id>`
 * (clic sur une notification) met l'alerte en évidence et la marque lue.
 * Textes factuels, sans urgence. Skeleton, état vide (Rai bravo), erreur (Rai alerte).
 */
@Component({
  selector: 'rj-alertes-page',
  imports: [RjAlertFilters, RjAlertItem, RjBottomSheet, RjButton, RjEmptyState, RjErrorState, RjIcon, RjSkeleton],
  providers: [AlertsStore],
  template: `
    <div class="flex flex-col gap-6 md:gap-8">
      <header class="flex flex-col gap-1">
        <h1 class="font-display text-h2 text-ink md:text-h1">Alertes</h1>
        <p class="text-body text-ink-muted">{{ subtitle() }}</p>
      </header>

      <div class="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start lg:gap-8">
        <section class="flex min-w-0 flex-col gap-4" aria-labelledby="rj-alert-list-title">
          <h2 id="rj-alert-list-title" class="sr-only">Historique des alertes</h2>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-body-sm text-ink-muted" role="status" data-unread-count>{{ unreadText() }}</p>
            <div class="flex flex-wrap gap-2">
              <button type="button" rjButton="secondary" icon="filter" class="lg:hidden" [attr.aria-haspopup]="'dialog'" (click)="filtersOpen.set(true)">
                Filtres{{ store.activeFilterCount() > 0 ? ' (' + store.activeFilterCount() + ')' : '' }}
              </button>
              <button type="button" rjButton="ghost" icon="checkAll" class="md:-mr-4" [disabled]="store.unreadCount() === 0" [loading]="markingAll()" (click)="markAllRead()">
                Tout marquer comme lu
              </button>
            </div>
          </div>

          @switch (store.status()) {
            @case ('error') {
              <rj-error-state
                title="Raijin n’a pas pu charger tes alertes"
                [description]="store.error()?.message ?? ''"
                [retrying]="store.status() === 'loading'"
                (retry)="reload()"
              />
            }
            @case ('ready') {
              @if (store.items().length === 0) {
                @if (store.activeFilterCount() > 0) {
                  <rj-empty-state title="Aucune alerte avec ces filtres" description="Élargis ta recherche : Raijin garde l’historique des alertes de tes suivis.">
                    <button type="button" rjButton="secondary" icon="retry" (click)="resetFilters()">Réinitialiser les filtres</button>
                  </rj-empty-state>
                } @else {
                  <rj-empty-state
                    title="Aucune alerte pour l’instant"
                    description="Raijin n’a détecté aucun signal de risque sur tes suivis. Il continue de les revérifier et te prévient si quelque chose change."
                  />
                }
              } @else {
                <ul class="flex flex-col gap-3" aria-label="Alertes">
                  @for (alert of store.items(); track alert.id) {
                    <li>
                      <rj-alert-item [alert]="alert" [now]="now()" [highlighted]="alert.id === highlighted()" (toggleRead)="toggleRead(alert.id, $event)" />
                    </li>
                  }
                </ul>
                <div class="flex flex-col items-center gap-2 pt-2">
                  @if (store.hasMore()) {
                    <button type="button" rjButton="secondary" icon="chevronDown" [loading]="store.loadingMore()" (click)="store.loadMore()">Charger plus</button>
                    @if (store.moreError(); as error) {
                      <p class="flex items-center gap-1.5 text-body-sm text-danger" role="alert">
                        <rj-icon name="circleAlert" [size]="16" />{{ error.message }}
                      </p>
                    }
                  } @else {
                    <p class="text-body-sm text-ink-muted" data-end>{{ endText() }}</p>
                  }
                </div>
              }
            }
            @default {
              <ul class="flex flex-col gap-3" aria-busy="true" aria-label="Chargement des alertes">
                @for (row of skeletonRows; track row) {
                  <li class="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 md:p-6">
                    <div class="flex items-center gap-3"><rj-skeleton class="h-7 w-24" /><rj-skeleton class="h-5 w-40" /></div>
                    <rj-skeleton class="h-4 w-full" />
                    <rj-skeleton class="h-4 w-3/5" />
                    <rj-skeleton class="h-4 w-48" />
                  </li>
                }
              </ul>
            }
          }
        </section>

        @if (desktop()) {
          <aside class="sticky top-20 hidden flex-col gap-4 rounded-lg border border-line bg-surface p-6 lg:flex" aria-labelledby="rj-filters-title">
            <div class="flex items-center justify-between gap-2">
              <h2 id="rj-filters-title" class="font-display text-h3 text-ink">Filtres</h2>
              @if (store.activeFilterCount() > 0) {
                <button type="button" rjButton="ghost" class="-my-2 -mr-4" (click)="resetFilters()">Réinitialiser</button>
              }
            </div>
            <rj-alert-filters [filters]="store.filters()" [tokens]="tokens()" (filtersChange)="applyFilters($event)" />
          </aside>
        }
      </div>
    </div>

    <rj-bottom-sheet [(open)]="filtersOpen" title="Filtres" description="Les alertes s’affichent dès que tu changes un filtre.">
      <rj-alert-filters class="pb-2" [filters]="store.filters()" [tokens]="tokens()" (filtersChange)="applyFilters($event)" />
      <button rjSheetFooter type="button" rjButton="ghost" [disabled]="store.activeFilterCount() === 0" (click)="resetFilters()">Réinitialiser</button>
      <button rjSheetFooter type="button" rjButton="primary" (click)="filtersOpen.set(false)">{{ resultsLabel() }}</button>
    </rj-bottom-sheet>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertesPage {
  protected readonly store = inject(AlertsStore);
  private readonly watches = inject(WatchesStore);
  private readonly router = inject(Router);
  private readonly toasts = inject(RjToastService);
  private readonly injector = inject(Injector);
  private readonly items = viewChildren(RjAlertItem);

  /** Paramètres d'URL (liaison des entrées du routeur). */
  readonly statut = input<string>();
  readonly type = input<string>();
  readonly mint = input<string>();
  readonly alerte = input<string>();

  protected readonly skeletonRows = [1, 2, 3, 4];
  protected readonly filtersOpen = signal(false);
  protected readonly markingAll = signal(false);
  protected readonly highlighted = signal<string | null>(null);
  protected readonly now = signal(Date.now());
  /** Panneau de filtres créé seulement au-delà de 1024 px (un seul jeu de champs dans la page). */
  protected readonly desktop = signal(false);

  protected readonly subtitle = computed(() => {
    const days = this.watches.limits()?.alertHistoryDays;
    const base = 'Ce que Raijin a détecté sur les tokens que tu suis.';
    return days ? `${base} Historique des ${days} derniers jours.` : base;
  });
  protected readonly unreadText = computed(() => {
    const count = this.store.unreadCount();
    if (count === 0) return 'Tout est lu.';
    return count > 1 ? `${count} alertes non lues` : '1 alerte non lue';
  });
  protected readonly endText = computed(() => {
    const days = this.watches.limits()?.alertHistoryDays;
    return days ? `Tu as tout vu sur les ${days} derniers jours.` : 'Tu as tout vu.';
  });
  protected readonly resultsLabel = computed(() => {
    if (this.store.status() !== 'ready') return 'Voir les alertes';
    const count = this.store.items().length;
    if (count === 0) return 'Aucune alerte';
    return `Voir ${count}${this.store.hasMore() ? '+' : ''} alerte${count > 1 ? 's' : ''}`;
  });
  protected readonly tokens = computed<TokenOption[]>(() => {
    const options = this.watches.items().map((watch) => ({ mint: watch.mint, label: tokenLabel(watch.token, watch.mint) }));
    const current = this.store.filters().mint;
    if (current && !options.some((option) => option.mint === current)) options.push({ mint: current, label: tokenLabel(null, current) });
    return options;
  });

  constructor() {
    // Liste des tokens du filtre et profondeur d'historique : les suivis exigent un e-mail confirmé.
    if (inject(AuthStore).emailVerified()) void this.watches.load();
    effect(() => {
      const filters = filtersFromQuery(this.statut(), this.type(), this.mint());
      untracked(() => void this.loadFor(filters));
    });
    const view = inject(DOCUMENT).defaultView;
    const media = view?.matchMedia?.('(min-width: 1024px)');
    this.desktop.set(media?.matches ?? false);
    const onChange = (event: MediaQueryListEvent) => {
      this.desktop.set(event.matches);
      if (event.matches) this.filtersOpen.set(false);
    };
    media?.addEventListener?.('change', onChange);
    const timer = setInterval(() => this.now.set(Date.now()), CLOCK_MS);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      media?.removeEventListener?.('change', onChange);
    });
  }

  protected applyFilters(filters: AlertFilters): void {
    void this.router.navigate([], { queryParams: queryFromFilters(filters), queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected resetFilters(): void {
    this.applyFilters(DEFAULT_ALERT_FILTERS);
  }

  protected reload(): void {
    void this.store.load();
  }

  protected async toggleRead(id: string, read: boolean): Promise<void> {
    const error = await this.store.markRead([id], read);
    if (error) this.toasts.show(error.message, { tone: 'error' });
  }

  protected async markAllRead(): Promise<void> {
    this.markingAll.set(true);
    const error = await this.store.markAllRead();
    this.markingAll.set(false);
    this.toasts.show(error ? error.message : 'Toutes tes alertes sont marquées comme lues.', { tone: error ? 'error' : 'success' });
  }

  private async loadFor(filters: AlertFilters): Promise<void> {
    await this.store.load(filters);
    const target = this.alerte();
    if (!target || this.store.status() !== 'ready') return;
    const alert = this.store.items().find((item) => item.id === target);
    if (!alert) return;
    this.highlighted.set(alert.id);
    if (alert.readAt === null) void this.store.markRead([alert.id], true);
    afterNextRender(() => this.items().find((item) => item.alert().id === target)?.reveal(), { injector: this.injector });
  }
}
