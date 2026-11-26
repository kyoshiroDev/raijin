import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { FakePortalActionRequest } from '@raijin/shared-contracts';
import { AuthStore, BillingApi, BillingStore, toClientError } from '@raijin/web-data-access';
import { RjButton, RjCard, RjEmptyState, RjErrorState, RjSkeleton, RjToastService } from '@raijin/web-ui';
import { RjFormAlert } from '../shared/form-alert';
import { INTERVAL_NAME, planStatus } from './billing-texts';
import { RjModeBadge } from './mode-badge';
import { RjSimulationUnavailable } from './simulation-unavailable';

type PortalAction = FakePortalActionRequest['action'];

const DONE: Readonly<Record<PortalAction, string>> = {
  cancel_at_period_end: 'Résiliation programmée (simulation).',
  resume: 'Abonnement repris (simulation).',
  cancel_now: 'Abonnement résilié (simulation).',
  switch_interval: 'Périodicité modifiée (simulation).',
};

/**
 * Faux portail client (`/abonnement/simulation-portail`), seulement en mode simulé : résilier en fin de période,
 * reprendre, changer de périodicité, résilier tout de suite. Chaque action passe par le chemin du webhook.
 */
@Component({
  selector: 'rj-simulated-portal-page',
  imports: [RouterLink, RjButton, RjCard, RjEmptyState, RjErrorState, RjSkeleton, RjFormAlert, RjModeBadge, RjSimulationUnavailable],
  template: `
    <div class="mx-auto flex w-full max-w-lg flex-col gap-6 md:py-6">
      @if (billing.status() === 'error') {
        <rj-error-state title="Raijin n’a pas pu préparer la simulation" [retrying]="loading()" (retry)="load()" />
      } @else if (billing.status() !== 'ready') {
        <div class="flex flex-col gap-4" role="status" aria-busy="true" aria-label="Chargement de la simulation">
          <rj-skeleton class="h-8 w-56" />
          <rj-skeleton shape="block" class="h-72" />
        </div>
      } @else if (billing.mode() !== 'simulation') {
        <rj-simulation-unavailable />
      } @else {
        <header class="flex flex-col items-start gap-3">
          <rj-mode-badge />
          <h1 class="font-display text-h2 text-ink md:text-h1">Portail simulé</h1>
          <p class="text-body text-ink-muted">Cette page remplace le portail client de Stripe en développement. Aucun paiement réel.</p>
        </header>

        @if (subscription(); as subscription) {
          <rj-card>
            <div class="flex flex-col gap-1">
              <h2 class="text-body-sm text-ink-muted">Abonnement</h2>
              <p class="font-display text-h3 text-ink">{{ status()?.title }}</p>
            </div>
            @if (status()?.tone === 'warn') {
              <rj-form-alert tone="warn">{{ status()?.detail }}</rj-form-alert>
            } @else {
              <p class="text-body text-ink-muted" data-status-detail>{{ status()?.detail }}</p>
            }
            <div rjCardFooter class="flex flex-col gap-2">
              @if (subscription.cancelAtPeriodEnd) {
                <button type="button" rjButton="secondary" icon="play" [block]="true" [disabled]="busy() !== null" [loading]="busy() === 'resume'" (click)="run('resume')" data-action="resume">Reprendre Pro</button>
              } @else {
                <button type="button" rjButton="secondary" icon="pause" [block]="true" [disabled]="busy() !== null" [loading]="busy() === 'cancel_at_period_end'" (click)="run('cancel_at_period_end')" data-action="cancel_at_period_end">Résilier à l’échéance</button>
              }
              <button type="button" rjButton="secondary" icon="retry" [block]="true" [disabled]="busy() !== null" [loading]="busy() === 'switch_interval'" (click)="run('switch_interval')" data-action="switch_interval">
                Passer en {{ otherInterval() }}
              </button>
              <button type="button" rjButton="danger" icon="close" [block]="true" [disabled]="busy() !== null" [loading]="busy() === 'cancel_now'" (click)="run('cancel_now')" data-action="cancel_now">Résilier tout de suite</button>
            </div>
          </rj-card>
        } @else {
          <rj-empty-state title="Aucun abonnement à gérer" description="Ce compte n’a pas d’abonnement Pro en cours." />
        }

        <a rjButton="primary" size="lg" [block]="true" icon="arrowLeft" routerLink="/abonnement">Retour à Raijin</a>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SimulatedPortalPage {
  protected readonly billing = inject(BillingStore);
  private readonly api = inject(BillingApi);
  private readonly auth = inject(AuthStore);
  private readonly toasts = inject(RjToastService);

  protected readonly loading = signal(false);
  protected readonly busy = signal<PortalAction | null>(null);
  protected readonly subscription = computed(() => {
    const account = this.billing.account();
    return account?.source === 'subscription' ? account.subscription : null;
  });
  protected readonly status = computed(() => {
    const account = this.billing.account();
    return account ? planStatus(account) : null;
  });
  protected readonly otherInterval = computed(() => INTERVAL_NAME[this.subscription()?.interval === 'year' ? 'month' : 'year']);

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    await this.auth.whenReady();
    await this.billing.load(this.auth.isAuthenticated());
    this.loading.set(false);
  }

  protected async run(action: PortalAction): Promise<void> {
    this.busy.set(action);
    try {
      await this.api.simulatePortal({ action });
      await this.billing.refreshAccount();
      this.toasts.show(DONE[action], { tone: 'success' });
    } catch (error) {
      this.toasts.show(toClientError(error).message, { tone: 'error' });
    } finally {
      this.busy.set(null);
    }
  }
}
