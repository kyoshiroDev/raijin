import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthStore, BillingStore } from '@raijin/web-data-access';
import { RjButton, RjErrorState, RjIcon, RjMascot } from '@raijin/web-ui';
import { INTERVAL_NAME } from './billing-texts';

/** Sondage de `billing/subscription` après Checkout : toutes les 2 s, 20 s au plus (docs/ARCHITECTURE.md §13.9). */
export const SUCCESS_POLL_INTERVAL_MS = 2_000;
export const SUCCESS_POLL_MAX_MS = 20_000;

type SuccessState = 'confirming' | 'confirmed' | 'timeout' | 'error';

/**
 * Retour de Checkout (`/abonnement/succes`). Le plan n'est jamais accordé par cette page : elle relit le compte
 * jusqu'à ce que le webhook ait enregistré l'abonnement, puis remercie (Rai bravo).
 */
@Component({
  selector: 'rj-checkout-success-page',
  imports: [RouterLink, RjButton, RjErrorState, RjIcon, RjMascot],
  template: `
    <div class="mx-auto flex max-w-xl flex-col items-center gap-5 py-6 text-center md:py-12">
      @switch (state()) {
        @case ('confirming') {
          <div class="flex flex-col items-center gap-4" role="status" aria-live="polite" data-state="confirming">
            <rj-icon name="loader" [size]="32" [spin]="true" class="text-ink-muted" />
            <h1 class="font-display text-h2 text-ink">Confirmation de ton abonnement</h1>
            <p class="text-body text-ink-muted">Stripe a pris en compte ton paiement. Raijin attend sa confirmation, ça prend en général quelques secondes.</p>
          </div>
        }
        @case ('confirmed') {
          <rj-mascot pose="bravo" size="lg" />
          <div class="flex flex-col gap-2" role="status" data-state="confirmed">
            <h1 class="font-display text-h2 text-ink md:text-h1">Bienvenue dans Raijin Pro</h1>
            <p class="text-body text-ink-muted">{{ confirmedText() }}</p>
          </div>
          <div class="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <a rjButton="primary" size="lg" icon="analyse" routerLink="/analyse">Analyser un token</a>
            <a rjButton="secondary" size="lg" routerLink="/abonnement">Voir mon abonnement</a>
          </div>
        }
        @case ('timeout') {
          <div class="flex flex-col items-center gap-4" role="status" data-state="timeout">
            <rj-icon name="clock" [size]="32" class="text-info" />
            <h1 class="font-display text-h2 text-ink">Confirmation en cours</h1>
            <p class="text-body text-ink-muted">
              La confirmation de Stripe prend plus de temps que prévu. Ton abonnement apparaîtra sur la page Abonnement dès sa réception, sans nouveau paiement.
            </p>
          </div>
          <div class="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <button type="button" rjButton="secondary" size="lg" icon="retry" (click)="start()">Vérifier à nouveau</button>
            <a rjButton="ghost" size="lg" routerLink="/abonnement">Voir mon abonnement</a>
          </div>
        }
        @case ('error') {
          <rj-error-state
            title="Raijin n’a pas pu vérifier ton abonnement"
            description="Vérifie ta connexion puis réessaie. Aucun paiement n’est refait."
            (retry)="start()"
          />
        }
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CheckoutSuccessPage {
  private readonly billing = inject(BillingStore);
  private readonly auth = inject(AuthStore);

  protected readonly state = signal<SuccessState>('confirming');
  protected readonly confirmedText = computed(() => {
    const subscription = this.billing.account()?.subscription;
    const kind = subscription ? `Ton abonnement ${INTERVAL_NAME[subscription.interval]} est actif.` : 'Ton abonnement est actif.';
    return `${kind} Toutes les fonctions Pro sont disponibles. Tu peux le gérer à tout moment depuis la page Abonnement.`;
  });

  private timer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      if (this.timer) clearTimeout(this.timer);
    });
    this.start();
  }

  protected start(): void {
    this.state.set('confirming');
    this.startedAt = Date.now();
    void this.poll();
  }

  private async poll(): Promise<void> {
    try {
      const account = await this.billing.refreshAccount();
      if (this.destroyed) return;
      if (account.source === 'subscription') {
        this.state.set('confirmed');
        void this.auth.reloadUser().catch(() => undefined);
        return;
      }
    } catch {
      if (this.destroyed) return;
      this.state.set('error');
      return;
    }
    if (Date.now() - this.startedAt + SUCCESS_POLL_INTERVAL_MS > SUCCESS_POLL_MAX_MS) {
      this.state.set('timeout');
      return;
    }
    this.timer = setTimeout(() => void this.poll(), SUCCESS_POLL_INTERVAL_MS);
  }
}
