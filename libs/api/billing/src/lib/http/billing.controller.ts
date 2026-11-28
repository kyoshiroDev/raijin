import { Body, Controller, Get, Header, Headers, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, CurrentAuth, type AuthContext } from '@raijin/api-auth';
import { ApiZodBody, SkipCsrf, ZodValidationPipe } from '@raijin/api-core';
import {
  checkoutSessionRequestSchema,
  fakeCheckoutCompleteRequestSchema,
  fakePortalActionRequestSchema,
  type BillingAccount,
  type BillingPlansResponse,
  type BillingRedirect,
  type CheckoutSessionRequest,
  type FakeCheckoutCompleteRequest,
  type FakePortalActionRequest,
} from '@raijin/shared-contracts';
import type { Request } from 'express';
import { BillingService, billingError } from '../domain/billing.service';
import { BillingWebhookService } from '../domain/billing-webhook.service';
import { WebhookSignatureError } from '../provider/billing-provider';
import { BillingSimulationService } from '../simulation/billing-simulation.service';
import { BillingThrottleGuard } from './billing-throttle.guard';
import { SimulationOnlyGuard } from './simulation.guard';

/**
 * Abonnement (`/api/v1/billing`, docs/ARCHITECTURE.md §13.2). Mutations protégées par la garde CSRF globale,
 * sauf le webhook (signature Stripe sur le corps brut, sans session).
 */
@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly webhooks: BillingWebhookService,
    private readonly simulation: BillingSimulationService,
  ) {}

  @Get('plans')
  @Header('Cache-Control', 'public, max-age=300')
  @ApiOperation({ summary: 'Plans, droits et prix (configuration, centimes TTC), mode de paiement.' })
  plans(): BillingPlansResponse {
    return this.billing.plans();
  }

  @Get('subscription')
  @UseGuards(AuthGuard)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Plan effectif, abonnement, essai Pro, disponibilité du Checkout et du portail.' })
  subscription(@CurrentAuth() auth: AuthContext): Promise<BillingAccount> {
    return this.billing.account(auth.userId);
  }

  @Post('checkout-sessions')
  @HttpCode(200)
  @UseGuards(AuthGuard, BillingThrottleGuard)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Crée une session Checkout (le front n’envoie que la périodicité).' })
  @ApiZodBody(checkoutSessionRequestSchema)
  checkout(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(checkoutSessionRequestSchema)) body: CheckoutSessionRequest): Promise<BillingRedirect> {
    return this.billing.createCheckout(auth.userId, body.interval);
  }

  @Post('portal-sessions')
  @HttpCode(200)
  @UseGuards(AuthGuard, BillingThrottleGuard)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Ouvre le portail client (gestion, résiliation, factures).' })
  portal(@CurrentAuth() auth: AuthContext): Promise<BillingRedirect> {
    return this.billing.createPortal(auth.userId);
  }

  /** Webhook Stripe : corps brut (`billingWebhookRawBody`), signature vérifiée, idempotent. */
  @Post('webhook')
  @HttpCode(200)
  @SkipCsrf()
  @ApiExcludeEndpoint()
  async webhook(@Req() req: Request, @Headers('stripe-signature') signature: string | undefined): Promise<{ received: true }> {
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body)) throw billingError('BILLING_WEBHOOK_INVALID', HttpStatus.BAD_REQUEST);
    try {
      await this.webhooks.handle(body, signature);
    } catch (error) {
      if (error instanceof WebhookSignatureError) throw billingError('BILLING_WEBHOOK_INVALID', HttpStatus.BAD_REQUEST);
      throw error;
    }
    return { received: true };
  }

  @Post('simulation/checkout')
  @HttpCode(200)
  @UseGuards(SimulationOnlyGuard, AuthGuard, BillingThrottleGuard)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Simulation : termine le faux Checkout (BILLING_PROVIDER=fake, 404 sinon).' })
  async simulateCheckout(@CurrentAuth() auth: AuthContext, @Body() raw: unknown): Promise<BillingAccount> {
    const body: FakeCheckoutCompleteRequest = new ZodValidationPipe(fakeCheckoutCompleteRequestSchema).transform(raw);
    await this.simulation.completeCheckout(auth.userId, body);
    return this.billing.account(auth.userId);
  }

  @Post('simulation/portal')
  @HttpCode(200)
  @UseGuards(SimulationOnlyGuard, AuthGuard, BillingThrottleGuard)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Simulation : action du faux portail (BILLING_PROVIDER=fake, 404 sinon).' })
  async simulatePortal(@CurrentAuth() auth: AuthContext, @Body() raw: unknown): Promise<BillingAccount> {
    const body: FakePortalActionRequest = new ZodValidationPipe(fakePortalActionRequestSchema).transform(raw);
    await this.simulation.portalAction(auth.userId, body);
    return this.billing.account(auth.userId);
  }
}
