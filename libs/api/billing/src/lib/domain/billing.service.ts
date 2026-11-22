import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  APP_CONFIG,
  ApiException,
  PLAN_POLICY_USER_SELECT,
  buildTrialDetails,
  errorCode,
  planPolicyLimits,
  resolvePlanPolicy,
  type AppConfig,
} from '@raijin/api-core';
import { PrismaService } from '@raijin/api-prisma';
import {
  BILLING_ERROR_MESSAGES,
  BILLING_RETURN_PATHS,
  CHECKOUT_CANCELED_PARAM,
  CHECKOUT_CANCELED_VALUE,
  CHECKOUT_SESSION_ID_PARAM,
  PRO_SUBSCRIPTION_STATUSES,
  type BillingAccount,
  type BillingErrorCode,
  type BillingInterval,
  type BillingPlansResponse,
  type BillingRedirect,
} from '@raijin/shared-contracts';
import { BILLING_CONFIG, type BillingConfig } from '../config/billing-config';
import { BillingProvider, BillingUnavailableError } from '../provider/billing-provider';
import { BillingClock } from './billing-ports';
import { fromPrismaInterval, fromPrismaStatus, toPrismaStatus } from './billing-enums';

const PRO_STATUSES = PRO_SUBSCRIPTION_STATUSES.map(toPrismaStatus);

export function billingError(code: BillingErrorCode, status: HttpStatus): ApiException {
  return new ApiException(code, status, BILLING_ERROR_MESSAGES[code]);
}

const notConfigured = () => billingError('BILLING_NOT_CONFIGURED', HttpStatus.SERVICE_UNAVAILABLE);

/**
 * Plans, état de l'abonnement, Checkout et portail (docs/ARCHITECTURE.md §13.2, §13.9). Droits calculés par
 * `resolvePlanPolicy` (source unique) ; prix, client et URLs de retour décidés ici, jamais par le front.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger('Billing');

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: BillingProvider,
    private readonly clock: BillingClock,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
    @Inject(APP_CONFIG) private readonly app: AppConfig,
  ) {}

  /** `GET billing/plans` (public). */
  plans(): BillingPlansResponse {
    const limits = planPolicyLimits(this.app);
    const { monthlyCents, yearlyCents, currency } = this.config.prices;
    return {
      free: { plan: 'FREE', entitlements: limits.free },
      pro: {
        plan: 'PRO',
        entitlements: limits.subscription,
        monthly: { interval: 'month', amountCents: monthlyCents, currency },
        yearly: { interval: 'year', amountCents: yearlyCents, currency },
      },
      trial: { days: this.app.trial.days, entitlements: limits.trial },
      mode: this.provider.mode(),
    };
  }

  /** `GET billing/subscription` : relu en base à chaque requête. */
  async account(userId: string): Promise<BillingAccount> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { ...PLAN_POLICY_USER_SELECT, stripeCustomerId: true },
    });
    if (!user) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    const now = this.clock.now();
    const policy = resolvePlanPolicy(user, planPolicyLimits(this.app), now);
    const latest = await this.prisma.subscription.findFirst({
      where: { userId },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      select: { status: true, interval: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
    });
    const pro = await this.prisma.subscription.findFirst({
      where: { userId, status: { in: PRO_STATUSES } },
      orderBy: { updatedAt: 'desc' },
      select: { status: true, interval: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
    });
    const shown = pro ?? latest;
    const mode = this.provider.mode();
    return {
      plan: policy.effectivePlan,
      source: policy.source,
      entitlements: policy.entitlements,
      subscription: shown
        ? {
            status: fromPrismaStatus(shown.status),
            interval: fromPrismaInterval(shown.interval),
            currentPeriodEnd: shown.currentPeriodEnd.toISOString(),
            cancelAtPeriodEnd: shown.cancelAtPeriodEnd,
          }
        : null,
      trial: buildTrialDetails(user, now),
      paymentIssue: pro?.status === 'PAST_DUE',
      portalAvailable: mode !== 'unavailable' && user.stripeCustomerId !== null,
      checkoutAvailable: mode !== 'unavailable' && policy.emailVerified && !pro,
      mode,
    };
  }

  /**
   * `POST billing/checkout-sessions` : e-mail vérifié, aucun abonnement Pro en cours (`ALREADY_SUBSCRIBED`),
   * client Stripe créé sous verrou de la ligne `User` (une seule création même en cas de double clic).
   */
  async createCheckout(userId: string, interval: BillingInterval): Promise<BillingRedirect> {
    if (this.provider.mode() === 'unavailable') throw notConfigured();
    const customer = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`;
        const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true, stripeCustomerId: true } });
        if (!user) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
        if (!user.emailVerifiedAt) throw ApiException.auth('AUTH_EMAIL_NOT_VERIFIED', HttpStatus.FORBIDDEN);
        const active = await tx.subscription.count({ where: { userId, status: { in: PRO_STATUSES } } });
        if (active > 0) throw billingError('ALREADY_SUBSCRIBED', HttpStatus.CONFLICT);
        if (user.stripeCustomerId) return user.stripeCustomerId;
        const customerId = await this.call(() => this.provider.createCustomer({ userId, email: user.email, idempotencyKey: `customer:${userId}` }));
        await tx.user.update({ where: { id: userId }, data: { stripeCustomerId: customerId } });
        return customerId;
      },
      { timeout: 20_000, maxWait: 10_000 },
    );
    const minute = Math.floor(this.clock.now().getTime() / 60_000);
    const url = await this.call(() =>
      this.provider.createCheckoutSession({
        userId,
        customerId: customer,
        interval,
        successUrl: `${this.app.appUrl}${BILLING_RETURN_PATHS.checkoutSuccess}?${CHECKOUT_SESSION_ID_PARAM}={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${this.app.appUrl}${BILLING_RETURN_PATHS.subscription}?${CHECKOUT_CANCELED_PARAM}=${CHECKOUT_CANCELED_VALUE}`,
        idempotencyKey: `checkout:${userId}:${interval}:${minute}`,
      }),
    );
    await this.prisma.productEvent.create({ data: { userId, type: 'checkout_started', properties: { interval } } });
    return { url };
  }

  /** `POST billing/portal-sessions` : `NO_BILLING_ACCOUNT` sans client Stripe. */
  async createPortal(userId: string): Promise<BillingRedirect> {
    if (this.provider.mode() === 'unavailable') throw notConfigured();
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true } });
    if (!user) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    if (!user.stripeCustomerId) throw billingError('NO_BILLING_ACCOUNT', HttpStatus.CONFLICT);
    const customerId = user.stripeCustomerId;
    const url = await this.call(() => this.provider.createPortalSession(customerId, `${this.app.appUrl}${BILLING_RETURN_PATHS.subscription}`));
    return { url };
  }

  /** Appel au prestataire : non configuré → 503 `BILLING_NOT_CONFIGURED` ; autre erreur → 503 `UPSTREAM_UNAVAILABLE` (code journalisé, jamais le message). */
  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ApiException) throw error;
      if (error instanceof BillingUnavailableError) throw notConfigured();
      this.logger.error(`Appel au prestataire de paiement en échec (${errorCode(error)})`);
      throw new ApiException('UPSTREAM_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }
}
