import { DynamicModule, Inject, InjectionToken, Logger, Module, ModuleMetadata, OnApplicationBootstrap } from '@nestjs/common';
import { ApiAlertsModule, WatchesService } from '@raijin/api-alerts';
import { ApiAuthModule } from '@raijin/api-auth';
import { APP_CONFIG, type AppConfig } from '@raijin/api-core';
import { ApiNotificationsModule } from '@raijin/api-notifications';
import { BILLING_CONFIG, type BillingConfig } from './config/billing-config';
import { BillingClock, PlanLimitHooks, TrialConversion } from './domain/billing-ports';
import { DefaultTrialConversion } from './domain/trial-conversion';
import { BillingService } from './domain/billing.service';
import { BillingWebhookService } from './domain/billing-webhook.service';
import { BillingInternalController } from './http/billing-internal.controller';
import { BillingThrottleGuard } from './http/billing-throttle.guard';
import { BillingController } from './http/billing.controller';
import { SimulationOnlyGuard } from './http/simulation.guard';
import { BillingMailService } from './mail/billing-mail.service';
import { BillingMailJobs } from './mail/billing-mail-jobs';
import { BillingAccountCloser } from './domain/billing-account-closer';
import { BillingProvider } from './provider/billing-provider';
import { FakeBillingProvider } from './provider/fake-billing.provider';
import { StripeBillingProvider } from './provider/stripe-billing.provider';
import { BillingSimulationService } from './simulation/billing-simulation.service';

/** `fake` (simulation, jamais en production : refusé par `loadBillingConfig`) ou Stripe réel. */
export function createBillingProvider(config: BillingConfig, app: AppConfig): BillingProvider {
  if (config.provider === 'fake' && !app.isProduction) return new FakeBillingProvider(config, app.appUrl);
  return new StripeBillingProvider(config);
}

/** Suivis : mise en pause au passage Gratuit, reprise au passage Pro (`api-alerts`). */
export function createPlanLimitHooks(watches: WatchesService): PlanLimitHooks {
  return {
    enforcePlanLimit: (userId) => watches.enforcePlanLimit(userId),
    resumePlanLimited: (userId) => watches.resumePlanLimited(userId),
  };
}

/**
 * Abonnement Pro (PROMPT.md §4.4, docs/ARCHITECTURE.md §13) : plans et prix, état, Checkout hébergé, portail
 * client, webhook Stripe (corps brut monté par `billingWebhookRawBody` dans `main.ts`), simulation locale.
 * Requiert `ApiCoreModule` et `ApiPrismaModule` (globaux).
 */
@Module({})
export class ApiBillingModule implements OnApplicationBootstrap {
  private readonly logger = new Logger('Billing');

  constructor(
    private readonly provider: BillingProvider,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  /**
   * `options.trialConversion` : fournisseur de `TrialConversion` venant d'un autre module (ex. `TrialLifecycleService`
   * d'`api-trial`, avec son module dans `options.imports`) ; par défaut `DefaultTrialConversion`.
   * `options.testRoutes` : enregistre `internal/billing/*` (fixtures signées, pannes simulées) ; à passer seulement
   * avec `JOBS_TEST_TRIGGER=1` hors production (le contrôleur refuse en plus ces cas à chaque requête).
   */
  static forRoot(config: BillingConfig, options: { imports?: ModuleMetadata['imports']; trialConversion?: InjectionToken; testRoutes?: boolean } = {}): DynamicModule {
    return {
      module: ApiBillingModule,
      imports: [ApiAuthModule, ApiAlertsModule, ApiNotificationsModule, ...(options.imports ?? [])],
      controllers: options.testRoutes ? [BillingController, BillingInternalController] : [BillingController],
      providers: [
        { provide: BILLING_CONFIG, useValue: config },
        { provide: BillingProvider, inject: [BILLING_CONFIG, APP_CONFIG], useFactory: createBillingProvider },
        { provide: PlanLimitHooks, inject: [WatchesService], useFactory: createPlanLimitHooks },
        options.trialConversion ? { provide: TrialConversion, useExisting: options.trialConversion } : { provide: TrialConversion, useClass: DefaultTrialConversion },
        BillingClock,
        BillingMailService,
        BillingMailJobs,
        BillingAccountCloser,
        BillingService,
        BillingWebhookService,
        BillingSimulationService,
        BillingThrottleGuard,
        SimulationOnlyGuard,
      ],
      exports: [BillingProvider, BillingService, BillingAccountCloser, BILLING_CONFIG],
    };
  }

  /** Mode annoncé au démarrage ; prix Stripe comparés à la configuration (sans bloquer le démarrage). */
  onApplicationBootstrap(): void {
    const mode = this.provider.mode();
    if (mode === 'simulation') this.logger.warn('Paiement en mode simulation (BILLING_PROVIDER=fake) : aucun appel à Stripe.');
    else if (mode === 'unavailable') this.logger.warn('Paiement indisponible : Stripe non configuré (503 BILLING_NOT_CONFIGURED).');
    else {
      this.logger.log(`Paiement Stripe en mode ${this.config.livemode ? 'réel' : 'test'}.`);
      void this.provider.verifyPrices();
    }
  }
}
