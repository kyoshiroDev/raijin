import { ChangeDetectionStrategy, Component, computed, inject, signal, type OnInit } from '@angular/core';
import { MarketContext } from '../../core/market/market-context';
import { UserPreferences } from '../../core/preferences/user-preferences';
import type { TokenRow } from '@raijin/bench-web-logic';
import { PageHeader } from '../../shared/ui/page-header';
import { Sheet } from '../../shared/ui/sheet';
import { UpdatedAgo } from '../../shared/ui/updated-ago';
import { FilterBar } from './components/filter-bar';
import { FiltersButton } from './components/filters-button';
import { RefreshButton } from './components/refresh-button';
import { TokenCard } from './components/token-card';
import { TokenDetail } from './components/token-detail';
import { OpportunitiesStore } from './opportunities-store';
import { Brand } from '../../shared/ui/brand';
import { EmptyState } from '../../shared/ui/empty-state';
import { Skeleton } from '../../shared/ui/skeleton';

@Component({
  selector: 'app-opportunities-page',
  imports: [Brand, EmptyState, FilterBar, FiltersButton, PageHeader, RefreshButton, Sheet, Skeleton, TokenCard, TokenDetail, UpdatedAgo],
  providers: [OpportunitiesStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header>
      <div class="min-w-0 flex-1">
        <h1 class="text-xl leading-tight font-black tracking-tight"><app-brand /></h1>
        <app-updated-ago class="truncate text-label text-muted" [at]="store.dataUpdatedAt()" />
      </div>
      <app-refresh-button [loading]="store.loading()" (refresh)="store.load()" />
    </app-page-header>

    <main class="mx-auto max-w-5xl space-y-4 px-safe pt-4">
      <div class="flex items-center gap-3">
        <app-filters-button [count]="store.activeFilters()" (activate)="filtersOpen.set(true)" />
        <p class="ml-auto text-right text-xs text-muted tabular-nums slashed-zero" data-count>
          <b class="text-fg">{{ store.visible().length }}</b> / {{ store.total() }} tokens
        </p>
      </div>

      <label class="flex min-h-11 items-center gap-3 text-sm" data-show-old>
        <input type="checkbox" class="size-5 shrink-0 accent-fg" [checked]="store.showOld()" (change)="onShowOld($event)" />
        <span>
          Afficher les tokens anciens
          <span class="block text-xs text-muted">Par défaut : paires de moins de 24 h, les plus jeunes d’abord.</span>
        </span>
      </label>

      @if (store.error(); as err) {
        <div class="card border-bear/50 text-sm text-bear" role="alert">
          {{ err }}
          <button type="button" class="btn-ghost mt-3 w-full" [disabled]="store.loading()" (click)="store.load()">Réessayer</button>
        </div>
      }

      @if (store.loading() && store.total() === 0) {
        <app-skeleton variant="token-card" [count]="3" label="Recherche des opportunités…" />
      } @else {
        <div class="grid grid-cols-1 items-stretch gap-3 md:grid-cols-2 lg:grid-cols-3" data-token-grid>
          @for (token of store.visible(); track token.mint) {
            <app-token-card [token]="token" [stake]="preferences.stakeSol()" (open)="selected.set(token)" />
          } @empty {
            <app-empty-state
              class="col-span-full"
              data-empty
              title="Aucun token ne passe tes filtres pour l'instant"
              [hint]="store.showOld() ? 'Élargis la market cap ou réinitialise les filtres.' : 'Affiche les tokens anciens ou élargis la market cap.'"
            />
          }
        </div>
      }

      <p class="text-center text-label text-muted">
        Aide à la décision, pas un conseil en investissement. La plupart des memecoins finissent à zéro : ne mise que ce que tu
        acceptes de perdre.
      </p>
    </main>

    <app-sheet heading="Filtres" [(open)]="filtersOpen">
      <app-filter-bar [(filters)]="store.filters" />
      <button type="button" class="btn-primary mt-4 w-full" (click)="filtersOpen.set(false)">
        Voir {{ store.visible().length }} token{{ store.visible().length > 1 ? 's' : '' }}
      </button>
    </app-sheet>

    <app-sheet layout="responsive" [heading]="detail()?.symbol ?? 'Détail du token'" [open]="detail() !== null" (openChange)="onDetailOpenChange($event)">
      @if (detail(); as t) {
        <app-token-detail [token]="t" [stake]="preferences.stakeSol()" [eurPerSol]="market.eurPerSol()" />
      }
    </app-sheet>
  `,
})
export class OpportunitiesPage implements OnInit {
  protected readonly store = inject(OpportunitiesStore);
  protected readonly preferences = inject(UserPreferences);
  protected readonly market = inject(MarketContext);

  readonly filtersOpen = signal(false);
  /** Token tapped in the list (snapshot); the detail follows realtime updates of the same mint. */
  readonly selected = signal<TokenRow | null>(null);
  readonly detail = computed(() => {
    const s = this.selected();
    if (!s) return null;
    return this.store.tokens().find((t) => t.mint === s.mint) ?? s;
  });

  ngOnInit(): void {
    void this.store.load();
    this.store.listen();
  }

  protected onShowOld(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement) this.store.setShowOld(target.checked);
  }

  protected onDetailOpenChange(open: boolean): void {
    if (!open) this.selected.set(null);
  }
}
