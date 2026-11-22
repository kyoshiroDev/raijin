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
      giftEndsAt: policy.source === 'gift' && user.proGrantedUntil ? user.proGrantedUntil.toISOString() : null,
      paymentIssue: pro?.status === 'PAST_DUE',
      // Portail seulement s'il existe ou a existé un abonnement (pas après un Checkout simplement abandonné).
      portalAvailable: mode !== 'unavailable' && user.stripeCustomerId !== null && latest !== null,
      checkoutAvailable: mode !== 'unavailable' && policy.emailVerified && !pro,
      mode,
    };
  }

  /**
   * `POST billing/checkout-sessions` : e-mail vérifié, aucun abonnement Pro en cours, ni en base ni chez le
   * prestataire (`ALREADY_SUBSCRIBED`). Le client Stripe est créé **hors transaction** (aucun verrou tenu pendant
   * l'appel réseau) avec la clé d'idempotence `customer:<userId>` (double clic : même client), puis rattaché
   * seulement si le compte n'en a pas encore (`UPDATE … WHERE stripeCustomerId IS NULL`).
   */
  async createCheckout(userId: string, interval: BillingInterval): Promise<BillingRedirect> {
    if (this.provider.mode() === 'unavailable') throw notConfigured();
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true, stripeCustomerId: true } });
    if (!user) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    if (!user.emailVerifiedAt) throw ApiException.auth('AUTH_EMAIL_NOT_VERIFIED', HttpStatus.FORBIDDEN);
    if ((await this.prisma.subscription.count({ where: { userId, status: { in: PRO_STATUSES } } })) > 0) throw billingError('ALREADY_SUBSCRIBED', HttpStatus.CONFLICT);
    const customer = user.stripeCustomerId ?? (await this.attachCustomer(userId, user.email));
    // Webhook pas encore reçu (ou perdu) : Stripe fait foi.
    if ((await this.call(() => this.provider.listProSubscriptions(customer))).length > 0) throw billingError('ALREADY_SUBSCRIBED', HttpStatus.CONFLICT);
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

  /** Crée le client Stripe (idempotent) puis le rattache au compte s'il n'en a toujours pas ; renvoie le client du compte. */
  private async attachCustomer(userId: string, email: string): Promise<string> {
    const created = await this.call(() => this.provider.createCustomer({ userId, email, idempotencyKey: `customer:${userId}` }));
    await this.prisma.user.updateMany({ where: { id: userId, stripeCustomerId: null }, data: { stripeCustomerId: created } });
    const current = await this.prisma.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true } });
    if (!current?.stripeCustomerId) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    return current.stripeCustomerId;
  }

  /** `POST billing/portal-sessions` : `NO_BILLING_ACCOUNT` sans client Stripe ni abonnement (actuel ou passé). */
  async createPortal(userId: string): Promise<BillingRedirect> {
    if (this.provider.mode() === 'unavailable') throw notConfigured();
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true } });
    if (!user) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    const subscribed = user.stripeCustomerId ? await this.prisma.subscription.count({ where: { userId } }) : 0;
    if (!user.stripeCustomerId || subscribed === 0) throw billingError('NO_BILLING_ACCOUNT', HttpStatus.CONFLICT);
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
