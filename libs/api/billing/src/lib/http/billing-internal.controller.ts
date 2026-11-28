import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { APP_CONFIG, ApiException, type AppConfig } from '@raijin/api-core';
import { buildFixtureEvent, isFixtureName, webhookFixtureOverridesSchema } from '../../testing/webhook-fixtures';
import { BILLING_CONFIG, type BillingConfig } from '../config/billing-config';
import { BillingWebhookService, type WebhookOutcome } from '../domain/billing-webhook.service';
import { BillingProvider } from '../provider/billing-provider';
import { FakeBillingProvider, signEventJson } from '../provider/fake-billing.provider';
import { toProviderSubscription } from '../provider/stripe-mapping';

/**
 * Routes de test `internal/billing/*` (e2e) : fixtures d'événements Stripe signées à la volée et traitées par le
 * même chemin que le webhook, pannes et état du faux Stripe. Contrôleur **enregistré seulement** avec
 * `JOBS_TEST_TRIGGER=1` hors production (`ApiBillingModule.forRoot(…, { testRoutes })`), et 404 à chaque requête
 * sinon (défense en profondeur).
 */
@ApiExcludeController()
@Controller('internal/billing')
export class BillingInternalController {
  constructor(
    @Inject(APP_CONFIG) private readonly app: AppConfig,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
    private readonly webhooks: BillingWebhookService,
    private readonly provider: BillingProvider,
  ) {}

  private fake(): FakeBillingProvider {
    if (!this.app.jobs.testTrigger || this.app.isProduction || !(this.provider instanceof FakeBillingProvider)) throw new ApiException('NOT_FOUND', HttpStatus.NOT_FOUND);
    return this.provider;
  }

  /** `POST internal/billing/fake-failures/:operation` : la prochaine résiliation / suppression de client du faux Stripe échoue. */
  @Post('fake-failures/:operation')
  @HttpCode(204)
  failNext(@Param('operation') operation: string): void {
    const fake = this.fake();
    if (operation !== 'cancel' && operation !== 'deleteCustomer') throw new ApiException('NOT_FOUND', HttpStatus.NOT_FOUND);
    fake.failNext(operation);
  }

  /** `GET internal/billing/fake-customers?id=` : état du client dans le faux Stripe (supprimé, abonnements). */
  @Get('fake-customers')
  customer(@Query('id') id: string | undefined): ReturnType<FakeBillingProvider['customerState']> {
    const fake = this.fake();
    if (!id || !/^cus_[A-Za-z0-9_]{4,64}$/.test(id)) throw new ApiException('VALIDATION_ERROR', HttpStatus.BAD_REQUEST);
    return fake.customerState(id);
  }

  @Post('webhook-fixtures/:name')
  @HttpCode(200)
  async replay(@Param('name') name: string, @Body() rawBody: unknown): Promise<{ eventId: string; outcome: WebhookOutcome }> {
    if (!this.app.jobs.testTrigger || this.app.isProduction || !this.config.webhookSecret) throw new ApiException('NOT_FOUND', HttpStatus.NOT_FOUND);
    const overrides = webhookFixtureOverridesSchema.safeParse(rawBody ?? {});
    if (!isFixtureName(name)) throw new ApiException('NOT_FOUND', HttpStatus.NOT_FOUND);
    if (!overrides.success) throw new ApiException('VALIDATION_ERROR', HttpStatus.BAD_REQUEST);
    const event = buildFixtureEvent(name, overrides.data, { defaultPriceId: this.config.prices.monthlyId ?? undefined });
    // Le faux Stripe adopte l'état de l'abonnement rejoué (relu ensuite par le webhook).
    const object = (event['data'] as { object: Record<string, unknown> }).object;
    if (this.provider instanceof FakeBillingProvider && toProviderSubscription(object)) this.provider.putSubscription(object);
    const signed = signEventJson(this.config.webhookSecret, event);
    return { eventId: event['id'] as string, outcome: await this.webhooks.handle(signed.payload, signed.signature) };
  }
}
