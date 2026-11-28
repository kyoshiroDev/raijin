import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  BILLING_ERROR_MESSAGES,
  BILLING_INTERVAL_LABELS,
  CHECKOUT_CANCELED_VALUE,
  trialOfferText,
  yearlySavingsPercent,
  type BillingInterval,
} from '@raijin/shared-contracts';
import { AuthStore, BillingApi, BillingRedirectRefusedError, BillingStore, toClientError } from '@raijin/web-data-access';
import { RjButton, RjCard, RjErrorState, RjIcon, RjSkeleton, RjToastService } from '@raijin/web-ui';
import { RjFormAlert } from '../shared/form-alert';
import { DISCLAIMER, TEXT_LINK } from '../shared/links';
import { INTERVAL_SUFFIX, entitlementLines, formatPrice, monthlyEquivalent, planStatus } from './billing-texts';
import { RjModeBadge } from './mode-badge';
import { RjPlanFeatures } from './plan-features';

/** Message quand l'URL de paiement renvoyée n'est pas autorisée (jamais suivie). */
export const REDIRECT_REFUSED_MESSAGE = 'Raijin n’a pas pu ouvrir la page de paiement. Réessaie dans un instant.';

/**
 * Écran Abonnement (`/abonnement`) : statut du plan, offres Gratuit et Pro avec les droits et les prix renvoyés
 * par l'API, bascule Mensuel / Annuel, Checkout (seule action jaune) et portail. Visible sans compte (offres
 * seules). Le plan n'est jamais déduit côté front : tout vient de `billing/plans` et `billing/subscription`.
 */
@Component({
  selector: 'rj-subscription-page',
  imports: [RouterLink, RjButton, RjCard, RjErrorState, RjIcon, RjSkeleton, RjFormAlert, RjModeBadge, RjPlanFeatures],
  template: `
    @if (billing.status() === 'error' && !billing.plans()) {
      <rj-error-state
        title="Raijin n’a pas pu charger les offres"
        description="Vérifie ta connexion puis réessaie. Ton abonnement n’est pas modifié."
        [retrying]="retrying()"
        (retry)="retry()"
      />
    } @else if (billing.plans(); as plans) {
      <div class="flex flex-col gap-6 md:gap-8">
        <header class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div class="flex flex-col gap-1">
            <h1 class="font-display text-h2 text-ink md:text-h1">Abonnement</h1>
            <p class="text-body text-ink-muted">Ton plan, les offres de Raijin et ta facturation.</p>
          </div>
          @if (plans.mode === 'simulation') {
            <rj-mode-badge class="self-start sm:mt-2" />
          }
        </header>

        @if (unavailable()) {
          <rj-form-alert tone="info" data-billing-unavailable>{{ unavailableText }}</rj-form-alert>
        }
        @if (needsVerification()) {
          <rj-form-alert tone="warn">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <span>Confirme ton adresse e-mail pour pouvoir t’abonner.</span>
              <a routerLink="/compte/verifier-email" [class]="link + ' shrink-0 sm:-my-3'">Confirmer l’adresse</a>
            </div>
          </rj-form-alert>
        }

        @if (billing.account(); as account) {
          <rj-card data-plan-status>
            <div class="flex flex-col gap-1">
              <h2 class="text-body-sm text-ink-muted">Ton plan</h2>
              <p class="flex items-center gap-2 font-display text-h3 text-ink">
                <rj-icon [name]="status()?.tone === 'warn' ? 'warn' : 'safe'" [size]="20" [class]="status()?.tone === 'warn' ? 'text-warn' : 'text-thunder-ink'" />
                {{ status()?.title }}
              </p>
            </div>
            @if (status()?.tone === 'warn') {
              <rj-form-alert tone="warn" data-payment-issue>{{ status()?.detail }}</rj-form-alert>
            } @else {
              <p class="text-body text-ink-muted" data-status-detail>{{ status()?.detail }}</p>
            }
            @if (account.portalAvailable) {
              <div rjCardFooter class="flex flex-col gap-2 sm:flex-row">
                <button type="button" rjButton="secondary" icon="external" [loading]="openingPortal()" [disabled]="unavailable()" (click)="openPortal()" data-portal>
                  Gérer mon abonnement
                </button>
              </div>
            }
          </rj-card>
        }

        <section class="flex flex-col gap-4" aria-labelledby="rj-offers-title">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div class="flex flex-col gap-1">
              <h2 id="rj-offers-title" class="font-display text-h3 text-ink">Les offres</h2>
              @if (showTrialOffer()) {
                <p class="text-body text-ink-muted" data-trial-offer>{{ trialOffer() }}</p>
              }
            </div>
            <fieldset class="flex flex-col gap-1">
              <legend class="sr-only">Périodicité du plan Pro</legend>
              <div class="inline-flex w-full rounded-md border border-line-strong bg-surface p-1 sm:w-auto">
                @for (option of intervals; track option) {
                  <label
                    class="relative inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-sm px-4 text-body text-ink-muted transition-colors duration-150 ease-raijin has-[:checked]:bg-surface-raised has-[:checked]:font-semibold has-[:checked]:text-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus-ring sm:flex-none"
                  >
                    <input type="radio" name="rj-interval" class="sr-only" [value]="option" [checked]="interval() === option" (change)="interval.set(option)" />
                    {{ intervalLabels[option] }}
                    @if (option === 'year' && savings() > 0) {
                      <span class="tabular rounded-sm border border-line-strong px-1.5 text-label text-ink">−{{ savings() }} %</span>
                    }
                  </label>
                }
              </div>
            </fieldset>
          </div>

          <div class="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6">
            <rj-card data-plan="FREE">
              <div class="flex items-start justify-between gap-3">
                <h3 class="font-display text-h3 text-ink">Gratuit</h3>
                @if (currentPlan() === 'FREE') {
                  <span class="rounded-sm border border-line-strong px-2 py-0.5 text-label text-ink">Ton plan actuel</span>
                }
              </div>
              <div class="flex flex-col gap-0.5">
                <p class="flex items-baseline gap-2">
                  <span class="tabular text-metric text-ink">{{ freePrice() }}</span>
                  <span class="text-body-sm text-ink-muted">pour toujours</span>
                </p>
                <p class="text-body-sm text-ink-muted">Sans carte bancaire, sans limite de durée.</p>
              </div>
              <rj-plan-features [lines]="freeLines()" />
            </rj-card>

            <rj-card data-plan="PRO">
              <div class="flex items-start justify-between gap-3">
                <h3 class="font-display text-h3 text-ink">Pro</h3>
                @if (currentPlan() === 'PRO') {
                  <span class="rounded-sm border border-line-strong px-2 py-0.5 text-label text-ink">{{ proTag() }}</span>
                }
              </div>
              <div class="flex flex-col gap-0.5">
                <p class="flex items-baseline gap-2">
                  <span class="tabular text-metric text-ink" data-price>{{ proPrice() }}</span>
                  <span class="text-body-sm text-ink-muted">{{ suffix() }}</span>
                </p>
                <p class="text-body-sm text-ink-muted" data-price-detail>{{ priceDetail() }}</p>
              </div>
              <rj-plan-features [lines]="proLines()" />
              @if (currentPlan() !== 'PRO' || account()?.source === 'trial' || account()?.source === 'gift') {
                <div rjCardFooter class="flex flex-col gap-2 pt-1">
                  @if (!auth.isAuthenticated()) {
                    <a rjButton="primary" size="lg" [block]="true" routerLink="/compte/inscription" [queryParams]="{ redirect: '/abonnement' }" data-checkout>Créer un compte</a>
                    <p class="text-body-sm text-ink-muted">Confirme ton e-mail : l’essai Pro démarre tout seul.</p>
                  } @else {
                    <button type="button" rjButton="primary" size="lg" [block]="true" [disabled]="!canCheckout()" [loading]="checkingOut()" (click)="startCheckout()" data-checkout>
                      Passer à Pro
                    </button>
                    <p class="text-body-sm text-ink-muted">Paiement sécurisé par Stripe. Résiliable à tout moment depuis cette page.</p>
                  }
                </div>
              }
            </rj-card>
          </div>
        </section>

        <p class="text-label text-ink-muted" data-disclaimer>{{ disclaimer }}</p>
      </div>
    } @else {
      <div class="flex flex-col gap-6 md:gap-8" role="status" aria-busy="true" aria-label="Chargement des offres">
        <div class="flex flex-col gap-2">
          <rj-skeleton class="h-8 w-44 md:h-11" />
          <rj-skeleton class="h-5 w-64 max-w-full" />
        </div>
        <rj-skeleton shape="block" class="h-32" />
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6">
          <rj-skeleton shape="block" class="h-80" />
          <rj-skeleton shape="block" class="h-80" />
        </div>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SubscriptionPage {
  protected readonly auth = inject(AuthStore);
  protected readonly billing = inject(BillingStore);
  private readonly api = inject(BillingApi);
  private readonly router = inject(Router);
  private readonly toasts = inject(RjToastService);

  /** `?checkout=annule` : retour d'un Checkout abandonné (toast neutre). */
  readonly checkout = input<string>();

  protected readonly link = TEXT_LINK;
  protected readonly disclaimer = DISCLAIMER;
  protected readonly unavailableText = BILLING_ERROR_MESSAGES.BILLING_NOT_CONFIGURED;
  protected readonly intervals: readonly BillingInterval[] = ['month', 'year'];
  protected readonly intervalLabels = BILLING_INTERVAL_LABELS;
  protected readonly interval = signal<BillingInterval>('month');
  protected readonly retrying = signal(false);
  protected readonly checkingOut = signal(false);
  protected readonly openingPortal = signal(false);

  protected readonly account = this.billing.account;
  protected readonly status = computed(() => {
    const account = this.billing.account();
    return account ? planStatus(account) : null;
  });
  protected readonly currentPlan = computed(() => this.billing.account()?.plan ?? null);
  protected readonly proTag = computed(() => {
    const source = this.billing.account()?.source;
    return source === 'trial' ? 'Essai en cours' : source === 'gift' ? 'Pro offert' : 'Ton plan actuel';
  });
  protected readonly unavailable = computed(() => this.billing.mode() === 'unavailable');
  protected readonly needsVerification = computed(() => this.auth.isAuthenticated() && !this.auth.emailVerified());
  protected readonly canCheckout = computed(() => {
    const account = this.billing.account();
    return !!account && account.checkoutAvailable && !this.unavailable() && this.auth.emailVerified();
  });
  /** L'offre d'essai ne s'adresse qu'à qui ne l'a pas encore eue (visiteur, e-mail pas encore confirmé). */
  protected readonly showTrialOffer = computed(() => {
    if (!this.auth.isAuthenticated()) return true;
    return this.billing.account()?.trial.status === 'none';
  });
  protected readonly trialOffer = computed(() => trialOfferText(this.billing.plans()?.trial.days));
  protected readonly savings = computed(() => {
    const pro = this.billing.plans()?.pro;
    return pro ? yearlySavingsPercent(pro.monthly.amountCents, pro.yearly.amountCents) : 0;
  });
  protected readonly selectedPrice = computed(() => {
    const pro = this.billing.plans()?.pro;
    if (!pro) return null;
    return this.interval() === 'year' ? pro.yearly : pro.monthly;
  });
  protected readonly proPrice = computed(() => {
    const price = this.selectedPrice();
    return price ? formatPrice(price.amountCents, price.currency) : '';
  });
  protected readonly freePrice = computed(() => formatPrice(0, this.billing.plans()?.pro.monthly.currency ?? 'EUR'));
  protected readonly suffix = computed(() => INTERVAL_SUFFIX[this.interval()]);
  protected readonly priceDetail = computed(() => {
    const price = this.selectedPrice();
    if (!price) return '';
    return price.interval === 'year' ? `Soit ${monthlyEquivalent(price)} par mois, payé une fois par an.` : 'Payé chaque mois, sans engagement.';
  });
  protected readonly freeLines = computed(() => {
    const plans = this.billing.plans();
    return plans ? entitlementLines(plans.free.entitlements) : [];
  });
  protected readonly proLines = computed(() => {
    const plans = this.billing.plans();
    return plans ? entitlementLines(plans.pro.entitlements) : [];
  });

  constructor() {
    void this.load();
  }

  protected async retry(): Promise<void> {
    this.retrying.set(true);
    await this.load();
    this.retrying.set(false);
  }

  protected async startCheckout(): Promise<void> {
    if (!this.canCheckout()) return;
    this.checkingOut.set(true);
    try {
      await this.api.startCheckout(this.interval());
      // La page est quittée : le bouton reste en chargement jusqu'au départ.
    } catch (error) {
      this.checkingOut.set(false);
      this.handleError(error);
    }
  }

  protected async openPortal(): Promise<void> {
    this.openingPortal.set(true);
    try {
      await this.api.openPortal();
    } catch (error) {
      this.openingPortal.set(false);
      this.handleError(error);
    }
  }

  private handleError(error: unknown): void {
    if (error instanceof BillingRedirectRefusedError) {
      this.toasts.show(REDIRECT_REFUSED_MESSAGE, { tone: 'error' });
      return;
    }
    const clientError = toClientError(error);
    this.toasts.show(clientError.message, { tone: clientError.code === 'ALREADY_SUBSCRIBED' ? 'info' : 'error' });
    if (clientError.code === 'ALREADY_SUBSCRIBED' || clientError.code === 'BILLING_NOT_CONFIGURED') {
      void this.billing.refreshAccount().catch(() => undefined);
    }
  }

  private async load(): Promise<void> {
    await this.auth.whenReady();
    await this.billing.load(this.auth.isAuthenticated());
    if (this.checkout() === CHECKOUT_CANCELED_VALUE) {
      this.toasts.show('Paiement annulé : rien n’a été débité.');
      void this.router.navigate([], { queryParams: { checkout: null }, queryParamsHandling: 'merge', replaceUrl: true });
    }
  }
}
