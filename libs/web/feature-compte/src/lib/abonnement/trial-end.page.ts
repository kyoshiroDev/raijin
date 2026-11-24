import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { BillingPlansResponse, TrialRecap } from '@raijin/shared-contracts';
import { BillingApi, TrialApi, TrialBannerState, toClientError } from '@raijin/web-data-access';
import { RjButton, RjCard, RjEmptyState, RjErrorState, RjIcon, RjMascot, RjSkeleton, RjToastService, type RjIconName } from '@raijin/web-ui';
import { DISCLAIMER } from '../shared/links';
import { entitlementLines, formatDate } from './billing-texts';
import { RjPlanFeatures } from './plan-features';

type LoadState = 'loading' | 'ready' | 'none' | 'error';

interface Stat {
  readonly value: number;
  readonly label: string;
  readonly icon: RjIconName;
  readonly iconClass: string;
  readonly key: string;
}

/** Nombre de suivis à départager après l'essai (actifs + en pause pour la limite du plan). */
export function watchesToChoose(recap: TrialRecap): number {
  return recap.activeWatches + recap.planLimitPausedWatches;
}

/**
 * Écran de fin d'essai (`/abonnement/fin-essai`, PROMPT.md §4.4) : Rai bravo résume l'essai (analyses, alertes,
 * tokens Danger repérés), dit ce qui change en Gratuit, puis « Garder Pro » (seule action jaune) ou « Continuer en
 * Gratuit » (écran marqué vu, puis choix des suivis à garder si le compte en a plus que le plan Gratuit).
 */
@Component({
  selector: 'rj-trial-end-page',
  imports: [RouterLink, RjButton, RjCard, RjEmptyState, RjErrorState, RjIcon, RjMascot, RjSkeleton, RjPlanFeatures],
  template: `
    <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 md:gap-8">
      @switch (state()) {
        @case ('loading') {
          <div class="flex flex-col items-center gap-4" aria-busy="true" aria-label="Chargement du récapitulatif">
            <rj-skeleton shape="block" class="h-28 w-24" />
            <rj-skeleton class="h-8 w-72 max-w-full" />
            <div class="grid w-full grid-cols-1 gap-4 sm:grid-cols-3">
              @for (item of [1, 2, 3]; track item) {
                <rj-skeleton shape="block" class="h-28" />
              }
            </div>
            <rj-skeleton shape="block" class="h-56 w-full" />
          </div>
        }
        @case ('none') {
          <rj-empty-state title="Aucun essai Pro à résumer" description="Ce compte n’a pas eu d’essai Pro. Tu peux découvrir les offres sur la page Abonnement.">
            <a rjButton="secondary" routerLink="/abonnement">Voir les offres</a>
          </rj-empty-state>
        }
        @case ('error') {
          <rj-error-state title="Raijin n’a pas pu charger ton récapitulatif" [retrying]="retrying()" (retry)="retry()" />
        }
        @case ('ready') {
          @if (recap(); as recap) {
            <header class="flex flex-col items-center gap-4 text-center">
              <rj-mascot pose="bravo" size="md" />
              <div class="flex flex-col gap-2">
                <h1 class="font-display text-h2 text-ink md:text-h1">{{ title() }}</h1>
                <p class="mx-auto max-w-xl text-body text-ink-muted">{{ intro() }}</p>
              </div>
            </header>

            <section aria-labelledby="rj-recap-title" class="flex flex-col gap-3">
              <h2 id="rj-recap-title" class="sr-only">Récapitulatif de ton essai</h2>
              <ul class="grid grid-cols-1 gap-3 sm:grid-cols-3 md:gap-4">
                @for (stat of stats(); track stat.key) {
                  <li class="flex h-full items-center gap-4 rounded-lg border border-line bg-surface p-4 sm:flex-col sm:items-start sm:gap-2 md:p-5" [attr.data-stat]="stat.key">
                    <rj-icon [name]="stat.icon" [size]="24" [class]="'shrink-0 ' + stat.iconClass" />
                    <div class="flex flex-col">
                      <span class="tabular text-metric text-ink">{{ stat.value }}</span>
                      <span class="text-body-sm text-ink-muted">{{ stat.label }}</span>
                    </div>
                  </li>
                }
              </ul>
            </section>

            <rj-card>
              <h2 class="font-display text-h3 text-ink">Ce qui change en Gratuit</h2>
              <rj-plan-features [lines]="freeLines()" />
              @if (pauseNote(); as note) {
                <p class="flex items-start gap-2 border-t border-line pt-3 text-body text-ink" data-pause-note>
                  <rj-icon name="info" [size]="20" class="mt-0.5 shrink-0 text-info" /><span>{{ note }}</span>
                </p>
              }
            </rj-card>

            <div class="flex flex-col gap-2 sm:flex-row sm:justify-center">
              <a rjButton="primary" size="lg" routerLink="/abonnement" data-keep-pro>Garder Pro</a>
              <button type="button" rjButton="secondary" size="lg" [loading]="continuing()" (click)="continueFree()" data-continue-free>Continuer en Gratuit</button>
            </div>

            <p class="text-center text-label text-ink-muted">{{ disclaimer }}</p>
          }
        }
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrialEndPage {
  private readonly trialApi = inject(TrialApi);
  private readonly billingApi = inject(BillingApi);
  private readonly router = inject(Router);
  private readonly toasts = inject(RjToastService);
  private readonly banner = inject(TrialBannerState);

  protected readonly disclaimer = DISCLAIMER;
  protected readonly state = signal<LoadState>('loading');
  protected readonly recap = signal<TrialRecap | null>(null);
  protected readonly plans = signal<BillingPlansResponse | null>(null);
  protected readonly retrying = signal(false);
  protected readonly continuing = signal(false);

  protected readonly title = computed(() => (this.recap()?.status === 'active' ? 'Ton essai Pro se termine aujourd’hui' : 'Ton essai Pro est terminé'));
  protected readonly intro = computed(() => {
    const recap = this.recap();
    if (!recap) return '';
    return `Du ${formatDate(recap.startedAt)} au ${formatDate(recap.endsAt)}, voici ce que Raijin a vérifié pour toi.`;
  });
  protected readonly stats = computed<Stat[]>(() => {
    const recap = this.recap();
    if (!recap) return [];
    return [
      { key: 'analyses', value: recap.analysesCount, label: recap.analysesCount > 1 ? 'analyses faites' : 'analyse faite', icon: 'analyse', iconClass: 'text-ink-muted' },
      { key: 'alerts', value: recap.alertsCount, label: recap.alertsCount > 1 ? 'alertes reçues' : 'alerte reçue', icon: 'bell', iconClass: 'text-ink-muted' },
      {
        key: 'danger',
        value: recap.dangerTokensCount,
        label: recap.dangerTokensCount > 1 ? 'tokens Danger repérés' : 'token Danger repéré',
        icon: 'danger',
        iconClass: 'text-danger',
      },
    ];
  });
  protected readonly freeMax = computed(() => this.plans()?.free.entitlements.maxActiveWatches ?? null);
  protected readonly freeLines = computed(() => {
    const plans = this.plans();
    return plans ? entitlementLines(plans.free.entitlements) : [];
  });
  protected readonly pauseNote = computed(() => {
    const recap = this.recap();
    const max = this.freeMax();
    if (!recap || max === null || watchesToChoose(recap) <= max) return null;
    return `Tu suis ${watchesToChoose(recap)} tokens : en Gratuit, ${max} restent actifs et les autres sont mis en pause, jamais supprimés. Tu choisis lesquels garder.`;
  });

  constructor() {
    void this.load();
  }

  protected async retry(): Promise<void> {
    this.retrying.set(true);
    await this.load();
    this.retrying.set(false);
  }

  protected async continueFree(): Promise<void> {
    const recap = this.recap();
    if (!recap) return;
    this.continuing.set(true);
    try {
      await this.trialApi.markEndScreenSeen();
      this.banner.endScreenSeen();
    } catch (error) {
      this.continuing.set(false);
      this.toasts.show(toClientError(error).message, { tone: 'error' });
      return;
    }
    const max = this.freeMax();
    if (recap.status !== 'active' && max !== null && watchesToChoose(recap) > max) {
      await this.router.navigate(['/abonnement/suivis']);
      return;
    }
    this.toasts.show(recap.status === 'active' ? `Ton essai Pro continue jusqu’au ${formatDate(recap.endsAt)}, puis tu passes en Gratuit.` : 'Tu continues avec le plan Gratuit.', {
      tone: 'success',
    });
    await this.router.navigate(['/analyse']);
  }

  private async load(): Promise<void> {
    if (this.state() !== 'ready') this.state.set('loading');
    try {
      const [recap, plans] = await Promise.all([this.trialApi.recap(), this.billingApi.plans()]);
      this.recap.set(recap);
      this.plans.set(plans);
      this.state.set('ready');
    } catch (error) {
      this.state.set(toClientError(error).code === 'TRIAL_NOT_FOUND' ? 'none' : 'error');
    }
  }
}
