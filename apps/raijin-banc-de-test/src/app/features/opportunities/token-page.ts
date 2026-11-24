import { ChangeDetectionStrategy, Component, computed, inject, input, resource } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BenchApi } from '../../core/api/bench-api';
import { MarketContext } from '../../core/market/market-context';
import { UserPreferences } from '../../core/preferences/user-preferences';
import { PageHeader } from '../../shared/ui/page-header';
import { isSolanaAddress } from '../../shared/utils/solana-address';
import { TokenDetail } from './components/token-detail';
import { fetchTokenByMint } from './token-query';
import { Icon } from '../../shared/ui/icon';
import { Skeleton } from '../../shared/ui/skeleton';

/** /token/:mint — standalone detail (target of push notifications in a later phase). */
@Component({
  selector: 'app-token-page',
  imports: [Icon, PageHeader, RouterLink, Skeleton, TokenDetail],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header>
      <a routerLink="/" class="btn-ghost size-11 shrink-0 px-0" aria-label="Retour aux opportunités">
        <app-icon name="chevron-left" class="size-5" />
      </a>
      <h1 class="min-w-0 flex-1 truncate text-xl font-black tracking-tight">{{ found()?.symbol ?? 'Token' }}</h1>
    </app-page-header>

    <main class="mx-auto max-w-lg px-safe pt-4">
      @if (token.isLoading()) {
        <app-skeleton variant="detail" label="Chargement du token…" />
      } @else if (found(); as t) {
        <div class="card"><app-token-detail [token]="t" [stake]="preferences.stakeSol()" [eurPerSol]="market.eurPerSol()" /></div>
      } @else {
        <div class="card flex flex-col items-center gap-3 py-10 text-center" role="alert">
          <p class="font-semibold">Token introuvable</p>
          <p class="max-w-xs text-sm text-muted">
            @if (token.error()) { Impossible de charger ce token pour l’instant. } @else { Ce lien ne correspond à aucun token suivi. }
          </p>
          <a routerLink="/" class="btn-primary mt-2">Retour aux opportunités</a>
        </div>
      }
    </main>
  `,
})
export class TokenPage {
  /** Bound from the :mint route param (withComponentInputBinding). Untrusted. */
  readonly mint = input('');

  private readonly api = inject(BenchApi);
  protected readonly preferences = inject(UserPreferences);
  protected readonly market = inject(MarketContext);
  protected readonly validMint = computed(() => (isSolanaAddress(this.mint()) ? this.mint() : undefined));

  /** `params` returns undefined for an invalid mint → the resource stays idle, no query. */
  protected readonly token = resource({
    params: () => this.validMint(),
    loader: ({ params, abortSignal }) => fetchTokenByMint(this.api, params, abortSignal),
  });

  protected readonly found = computed(() => (this.token.hasValue() ? this.token.value() : null));
}
