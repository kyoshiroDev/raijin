import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { APP_CONFIG, ApiException, type AppConfig } from '@raijin/api-core';
import { buildFixtureEvent, isFixtureName, webhookFixtureOverridesSchema } from '../../testing/webhook-fixtures';
import { BILLING_CONFIG, type BillingConfig } from '../config/billing-config';
import { BillingWebhookService, type WebhookOutcome } from '../domain/billing-webhook.service';
import { BillingProvider } from '../provider/billing-provider';
import { FakeBillingProvider, signEventJson } from '../provider/fake-billing.provider';
import { toProviderSubscription } from '../provider/stripe-mapping';

/**
 * `POST internal/billing/webhook-fixtures/:name` (tests e2e) : rejoue une fixture d'événement Stripe signée à la
 * volée, par le même chemin que le webhook. Active seulement si `JOBS_TEST_TRIGGER=1` hors production (refusé
 * par la configuration en production) ; sinon 404 comme une route inexistante.
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
