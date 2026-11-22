import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorCode } from '@raijin/api-core';
import { Prisma, PrismaService } from '@raijin/api-prisma';
import {
  PRO_SUBSCRIPTION_STATUSES,
  STRIPE_WEBHOOK_EVENT_TYPES,
  type BillingInterval,
  type BillingProductEventType,
  type StripeWebhookEventType,
} from '@raijin/shared-contracts';
import { BILLING_CONFIG, type BillingConfig } from '../config/billing-config';
import { BillingProvider, WebhookSignatureError, type BillingWebhookEvent, type ProviderInvoice, type ProviderSubscription } from '../provider/billing-provider';
import { checkoutSessionRefs, invoiceSubscriptionId, toProviderInvoice, toProviderSubscription } from '../provider/stripe-mapping';
import { BillingMailService } from '../mail/billing-mail.service';
import { BillingClock, PlanLimitHooks, TrialConversion } from './billing-ports';
import { toPrismaInterval, toPrismaStatus } from './billing-enums';

/** Issue du traitement d'un webhook (journal, tests). */
export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored' | 'stale' | 'unmatched';

/** Effets à exécuter après le commit (la transaction ne fait aucun appel réseau ni envoi). */
interface AfterCommit {
  userId: string | null;
  email: string | null;
  resume: boolean;
  enforce: boolean;
  receipt: ProviderInvoice | null;
  paymentFailed: boolean;
  failedInvoice: ProviderInvoice | null;
  interval: BillingInterval | null;
  renewsAt: Date | null;
}

type Tx = Prisma.TransactionClient;

const PRO_STATUSES = PRO_SUBSCRIPTION_STATUSES.map(toPrismaStatus);

function isHandled(type: string): type is StripeWebhookEventType {
  return (STRIPE_WEBHOOK_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Webhooks Stripe (docs/ARCHITECTURE.md §13.5) : signature vérifiée sur le corps brut, mode (test / réel)
 * contrôlé, idempotence **transactionnelle** (`StripeEvent` inséré dans la même transaction que les effets ;
 * erreur → rollback → 500 → Stripe réessaie), état de l'abonnement **relu chez Stripe**, événement plus ancien
 * que le dernier appliqué ignoré, rattachement par `metadata.userId` puis par client Stripe. Seul ce service
 * écrit `Subscription` et `User.plan` (jamais la page de succès du Checkout).
 */
@Injectable()
export class BillingWebhookService {
  private readonly logger = new Logger('BillingWebhook');

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: BillingProvider,
    private readonly mail: BillingMailService,
    private readonly plans: PlanLimitHooks,
    private readonly clock: BillingClock,
    private readonly trial: TrialConversion,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  /** Vérifie puis traite un webhook ; lève `WebhookSignatureError` (400) si la requête n'est pas authentique. */
  async handle(rawBody: Buffer, signature: string | undefined): Promise<WebhookOutcome> {
    const event = this.provider.constructWebhookEvent(rawBody, signature);
    if (event.livemode !== this.provider.livemode) throw new WebhookSignatureError();
    return this.process(event);
  }

  /** Traite un événement déjà vérifié. */
  async process(event: BillingWebhookEvent): Promise<WebhookOutcome> {
    if (!isHandled(event.type)) return 'ignored';
    // Lectures chez Stripe AVANT la transaction (aucun appel réseau pendant qu'elle tient des verrous).
    const { subscription, invoice, checkout } = await this.load(event);
    const effects: AfterCommit = { userId: null, email: null, resume: false, enforce: false, receipt: null, paymentFailed: false, failedInvoice: null, interval: null, renewsAt: null };
    const outcome = await this.prisma.$transaction(
      async (tx) => {
        const inserted = await tx.stripeEvent.createMany({ data: [{ id: event.id, type: event.type }], skipDuplicates: true });
        if (inserted.count === 0) return 'duplicate' as const;
        return this.apply(tx, event, subscription, invoice, checkout, effects);
      },
      { timeout: 15_000, maxWait: 10_000 },
    );
    if (outcome === 'processed') await this.afterCommit(event, effects);
    this.logger.log(`Événement ${event.id} (${event.type}) : ${outcome}`);
    return outcome;
  }

  private async load(event: BillingWebhookEvent): Promise<{
    subscription: ProviderSubscription | null;
    invoice: ProviderInvoice | null;
    checkout: ReturnType<typeof checkoutSessionRefs>;
  }> {
    const checkout = event.type === 'checkout.session.completed' ? checkoutSessionRefs(event.object) : null;
    let invoice: ProviderInvoice | null = null;
    let subscriptionId: string | null = null;
    if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
      const snapshot = toProviderInvoice(event.object);
      // Montant relu chez Stripe (jamais celui du corps reçu, sauf facture inconnue du prestataire).
      invoice = snapshot ? ((await this.provider.retrieveInvoice(snapshot.id)) ?? snapshot) : null;
      subscriptionId = invoice?.subscriptionId ?? invoiceSubscriptionId(event.object);
    } else if (checkout) {
      subscriptionId = checkout.subscriptionId;
    } else {
      subscriptionId = typeof event.object['id'] === 'string' ? event.object['id'] : null;
    }
    let subscription: ProviderSubscription | null = null;
    if (subscriptionId) {
      subscription = await this.provider.retrieveSubscription(subscriptionId);
      // Abonnement inconnu du prestataire : instantané de l'événement s'il s'agit d'un abonnement.
      if (!subscription && event.type.startsWith('customer.subscription.')) subscription = toProviderSubscription(event.object);
    }
    return { subscription, invoice, checkout };
  }

  private async apply(
    tx: Tx,
    event: BillingWebhookEvent,
    subscription: ProviderSubscription | null,
    invoice: ProviderInvoice | null,
    checkout: ReturnType<typeof checkoutSessionRefs>,
    effects: AfterCommit,
  ): Promise<WebhookOutcome> {
    const customerId = subscription?.customerId ?? checkout?.customerId ?? invoice?.customerId ?? null;
    const user = await this.findUser(tx, [subscription?.userId ?? null, checkout?.userId ?? null], customerId);
    if (!user) {
      this.logger.warn(`Événement ${event.id} : aucun utilisateur rattaché (BILLING_UNMATCHED)`);
      return 'unmatched';
    }
    effects.userId = user.id;
    effects.email = user.email;

    const existing = subscription
      ? await tx.subscription.findUnique({ where: { stripeSubscriptionId: subscription.id }, select: { userId: true, lastEventAt: true } })
      : null;
    if (existing && existing.userId !== user.id) {
      this.logger.warn(`Événement ${event.id} : abonnement rattaché à un autre compte (BILLING_OWNER_MISMATCH)`);
      return 'unmatched';
    }

    if (customerId && !user.stripeCustomerId) {
      const owner = await tx.user.findUnique({ where: { stripeCustomerId: customerId }, select: { id: true } });
      if (!owner) await tx.user.update({ where: { id: user.id }, data: { stripeCustomerId: customerId } });
    }

    let applied = false;
    if (subscription) {
      if (existing?.lastEventAt && event.created.getTime() < existing.lastEventAt.getTime()) return 'stale';
      const interval = this.intervalOf(subscription);
      const data = {
        stripePriceId: subscription.priceId,
        status: toPrismaStatus(subscription.status),
        interval: toPrismaInterval(interval),
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        lastEventAt: event.created,
        latestInvoiceId: invoice?.id ?? subscription.latestInvoiceId,
      };
      await tx.subscription.upsert({
        where: { stripeSubscriptionId: subscription.id },
        create: { userId: user.id, stripeSubscriptionId: subscription.id, ...data },
        update: data,
      });
      effects.interval = interval;
      effects.renewsAt = subscription.currentPeriodEnd;
      applied = true;
    }

    if (applied) await this.syncPlan(tx, event, user, effects);

    if (event.type === 'invoice.paid' && invoice && invoice.amountPaidCents > 0) effects.receipt = invoice;
    if (event.type === 'invoice.payment_failed') {
      effects.paymentFailed = true;
      effects.failedInvoice = invoice;
      await this.productEvent(tx, user.id, 'payment_failed', {});
    }
    return 'processed';
  }

  /** `User.plan` = PRO si au moins un abonnement a un statut Pro (`active`, `trialing`, `past_due`). */
  private async syncPlan(tx: Tx, event: BillingWebhookEvent, user: LockedUser, effects: AfterCommit): Promise<void> {
    const proCount = await tx.subscription.count({ where: { userId: user.id, status: { in: PRO_STATUSES } } });
    if (proCount > 1) this.logger.warn(`Événement ${event.id} : plusieurs abonnements Pro pour un même compte (BILLING_SECOND_SUBSCRIPTION)`);
    const nowPro = proCount > 0;
    const wasPro = user.plan === 'PRO';
    if (nowPro === wasPro) return;
    await tx.user.update({ where: { id: user.id }, data: { plan: nowPro ? 'PRO' : 'FREE' } });
    if (nowPro) {
      effects.resume = true;
      await this.productEvent(tx, user.id, 'subscription_activated', {});
      await this.trial.endTrialOnSubscriptionInTx(tx, user.id, effects.interval ?? 'month', this.clock.now());
    } else {
      effects.enforce = true;
      await this.productEvent(tx, user.id, 'subscription_canceled', {});
    }
  }

  private productEvent(tx: Tx, userId: string, type: BillingProductEventType, properties: Prisma.InputJsonObject): Promise<unknown> {
    return tx.productEvent.create({ data: { userId, type, properties } });
  }

  /** Périodicité : prix configuré, sinon celle du prix Stripe, sinon mensuel (journalisé). */
  private intervalOf(subscription: ProviderSubscription): BillingInterval {
    if (subscription.priceId === this.config.prices.monthlyId) return 'month';
    if (subscription.priceId === this.config.prices.yearlyId) return 'year';
    this.logger.warn(`Abonnement avec un prix non configuré (BILLING_UNKNOWN_PRICE)`);
    return subscription.interval ?? 'month';
  }

  /**
   * Rattachement : `metadata.userId` (abonnement puis session) si le compte existe et que son client Stripe
   * est absent ou identique ; sinon le compte portant ce client Stripe. Ligne `User` verrouillée.
   */
  private async findUser(tx: Tx, candidates: readonly (string | null)[], customerId: string | null): Promise<LockedUser | null> {
    for (const id of candidates) {
      if (!id) continue;
      const user = await this.lockUser(tx, { id });
      if (user && (!user.stripeCustomerId || !customerId || user.stripeCustomerId === customerId)) return user;
    }
    return customerId ? this.lockUser(tx, { stripeCustomerId: customerId }) : null;
  }

  /** Verrouille la ligne `User` (`SELECT … FOR UPDATE`) puis la relit (état à jour sous verrou). */
  private async lockUser(tx: Tx, where: { id: string } | { stripeCustomerId: string }): Promise<LockedUser | null> {
    const found = await tx.user.findUnique({ where, select: { id: true } });
    if (!found) return null;
    await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${found.id}::uuid FOR UPDATE`;
    return tx.user.findUnique({ where: { id: found.id }, select: LOCKED_USER_SELECT });
  }

  private async afterCommit(event: BillingWebhookEvent, effects: AfterCommit): Promise<void> {
    const { userId, email } = effects;
    if (!userId) return;
    await this.safely(event, 'PLAN_HOOK', async () => {
      if (effects.resume) await this.plans.resumePlanLimited(userId);
      if (effects.enforce) await this.plans.enforcePlanLimit(userId);
    });
    if (!email) return;
    // Un événement n'est traité qu'une fois (StripeEvent) : un seul reçu par facture.
    if (effects.receipt) {
      const receipt = effects.receipt;
      await this.safely(event, 'RECEIPT_MAIL', () => this.mail.sendReceipt(email, receipt, effects.interval, effects.renewsAt));
    }
    if (effects.paymentFailed) await this.safely(event, 'PAYMENT_FAILED_MAIL', () => this.mail.sendPaymentFailed(email, effects.failedInvoice));
  }

  private async safely(event: BillingWebhookEvent, step: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.error(`Événement ${event.id} : ${step} en échec (${errorCode(error)})`);
    }
  }
}

const LOCKED_USER_SELECT = { id: true, email: true, plan: true, trialStatus: true, trialEndsAt: true, stripeCustomerId: true } satisfies Prisma.UserSelect;
type LockedUser = Prisma.UserGetPayload<{ select: typeof LOCKED_USER_SELECT }>;
