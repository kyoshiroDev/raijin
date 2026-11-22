import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { BILLING_RETURN_PATHS, CHECKOUT_CANCELED_PARAM, CHECKOUT_CANCELED_VALUE, CHECKOUT_SESSION_ID_PARAM, fakeCheckoutSessionIdSchema } from '@raijin/shared-contracts';
import { AuthStore, BillingApi, BillingStore, toClientError } from '@raijin/web-data-access';
import { RjButton, RjCard, RjErrorState, RjSkeleton, RjToastService } from '@raijin/web-ui';
import { RjFormAlert } from '../shared/form-alert';
import { RjModeBadge } from './mode-badge';
import { RjSimulationUnavailable } from './simulation-unavailable';

type Outcome = 'paid' | 'payment_failed';

/**
 * Faux Checkout (`/abonnement/simulation?session=cs_fake_…`), affiché seulement si l'API est en mode simulé.
 * Aucun champ de carte : l'API signe localement l'événement et le traite comme un vrai webhook.
 */
@Component({
  selector: 'rj-simulated-checkout-page',
  imports: [RjButton, RjCard, RjErrorState, RjSkeleton, RjFormAlert, RjModeBadge, RjSimulationUnavailable],
  template: `
    <div class="mx-auto flex w-full max-w-lg flex-col gap-6 md:py-6">
      @if (billing.status() === 'error') {
        <rj-error-state title="Raijin n’a pas pu préparer la simulation" [retrying]="loading()" (retry)="load()" />
      } @else if (billing.status() !== 'ready') {
        <div class="flex flex-col gap-4" aria-busy="true" aria-label="Chargement de la simulation">
          <rj-skeleton class="h-8 w-56" />
          <rj-skeleton shape="block" class="h-72" />
        </div>
      } @else if (billing.mode() !== 'simulation') {
        <rj-simulation-unavailable />
      } @else {
        <header class="flex flex-col items-start gap-3">
          <rj-mode-badge />
          <h1 class="font-display text-h2 text-ink md:text-h1">Paiement simulé</h1>
          <p class="text-body text-ink-muted">Cette page remplace Stripe Checkout en développement. Aucune carte n’est demandée et aucun paiement réel n’a lieu.</p>
        </header>

        @if (!sessionValid()) {
          <rj-form-alert tone="danger" data-invalid-session>Cette session de paiement n’est pas valide. Repars de la page Abonnement.</rj-form-alert>
        }

        <rj-card>
          <dl class="flex flex-col divide-y divide-line">
            <div class="flex items-center justify-between gap-4 pb-3">
              <dt class="text-body-sm text-ink-muted">Offre</dt>
              <dd class="text-body font-semibold text-ink">Raijin Pro</dd>
            </div>
            <div class="flex items-center justify-between gap-4 pt-3">
              <dt class="text-body-sm text-ink-muted">Session</dt>
              <dd class="tabular min-w-0 truncate text-data text-ink" [title]="session() ?? ''">{{ sessionLabel() }}</dd>
            </div>
          </dl>
          <div rjCardFooter class="flex flex-col gap-2">
            <button type="button" rjButton="primary" size="lg" [block]="true" [disabled]="!sessionValid() || busy() !== null" [loading]="busy() === 'paid'" (click)="complete('paid')" data-simulate-paid>
              Simuler le paiement
            </button>
            <button type="button" rjButton="secondary" [block]="true" [disabled]="!sessionValid() || busy() !== null" [loading]="busy() === 'payment_failed'" (click)="complete('payment_failed')" data-simulate-failed>
              Simuler un refus de paiement
            </button>
            <button type="button" rjButton="ghost" [block]="true" [disabled]="busy() !== null" (click)="cancel()" data-simulate-cancel>Annuler</button>
          </div>
        </rj-card>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SimulatedCheckoutPage {
  protected readonly billing = inject(BillingStore);
  private readonly api = inject(BillingApi);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly toasts = inject(RjToastService);

  readonly session = input<string | undefined>();

  protected readonly loading = signal(false);
  protected readonly busy = signal<Outcome | null>(null);
  protected readonly sessionValid = computed(() => fakeCheckoutSessionIdSchema.safeParse(this.session()).success);
  protected readonly sessionLabel = computed(() => {
    const session = this.session() ?? '';
    return session.length > 20 ? `${session.slice(0, 12)}…${session.slice(-6)}` : session || '—';
  });

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    await this.auth.whenReady();
    await this.billing.load(this.auth.isAuthenticated());
    this.loading.set(false);
  }

  protected async complete(outcome: Outcome): Promise<void> {
    const sessionId = this.session();
    if (!sessionId || !this.sessionValid()) return;
    this.busy.set(outcome);
    try {
      await this.api.simulateCheckout({ sessionId, outcome });
      if (outcome === 'paid') {
        await this.router.navigate([BILLING_RETURN_PATHS.checkoutSuccess], { queryParams: { [CHECKOUT_SESSION_ID_PARAM]: sessionId }, replaceUrl: true });
      } else {
        this.toasts.show('Refus de paiement simulé. Le statut de ton abonnement est à jour sur cette page.');
        await this.router.navigate([BILLING_RETURN_PATHS.subscription], { replaceUrl: true });
      }
    } catch (error) {
      this.toasts.show(toClientError(error).message, { tone: 'error' });
    } finally {
      this.busy.set(null);
    }
  }

  protected cancel(): void {
    void this.router.navigate([BILLING_RETURN_PATHS.subscription], { queryParams: { [CHECKOUT_CANCELED_PARAM]: CHECKOUT_CANCELED_VALUE }, replaceUrl: true });
  }
}
