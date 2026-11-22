import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, ApiException, type AppConfig } from '@raijin/api-core';
import { PrismaService } from '@raijin/api-prisma';
import { PRO_SUBSCRIPTION_STATUSES, type FakeCheckoutCompleteRequest, type FakePortalActionRequest } from '@raijin/shared-contracts';
import { billingError } from '../domain/billing.service';
import { fromPrismaInterval, fromPrismaStatus, toPrismaStatus } from '../domain/billing-enums';
import { BillingWebhookService, type WebhookOutcome } from '../domain/billing-webhook.service';
import { BillingProvider } from '../provider/billing-provider';
import { FakeBillingProvider, type SignedFakeEvent } from '../provider/fake-billing.provider';

const PRO_STATUSES = PRO_SUBSCRIPTION_STATUSES.map(toPrismaStatus);

/**
 * Faux Checkout et faux portail (`BILLING_PROVIDER=fake`, jamais en production ; sinon 404). Chaque action
 * produit les événements qu'enverrait Stripe, **signés localement** et traités par le même chemin que le
 * webhook (vérification de signature comprise) : la simulation ne peut rien accorder que le webhook n'accorde.
 */
@Injectable()
export class BillingSimulationService {
  constructor(
    private readonly provider: BillingProvider,
    private readonly webhook: BillingWebhookService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly app: AppConfig,
  ) {}

  /** Fournisseur simulé, ou 404 (route inexistante hors simulation et en production). */
  fake(): FakeBillingProvider {
    if (this.app.isProduction || !(this.provider instanceof FakeBillingProvider)) throw new ApiException('NOT_FOUND', HttpStatus.NOT_FOUND);
    return this.provider;
  }

  /** `POST billing/simulation/checkout` : paiement accepté (`paid`) ou refusé (`payment_failed`). */
  async completeCheckout(userId: string, request: FakeCheckoutCompleteRequest): Promise<WebhookOutcome[]> {
    const fake = this.fake();
    const session = fake.takeSession(request.sessionId, userId);
    if (!session) throw new ApiException('NOT_FOUND', HttpStatus.NOT_FOUND);
    const paid = request.outcome === 'paid';
    const sub = fake.createSubscription({ customerId: session.customerId, userId, interval: session.interval, status: paid ? 'active' : 'past_due' });
    const invoice = fake.createInvoice(sub, paid);
    return this.deliver([
      fake.signEvent('checkout.session.completed', fake.checkoutSessionObject(session, sub['id'] as string)),
      fake.signEvent(paid ? 'invoice.paid' : 'invoice.payment_failed', invoice),
    ]);
  }

  /** `POST billing/simulation/portal` : résiliation (fin de période ou immédiate), reprise, changement de périodicité. */
  async portalAction(userId: string, request: FakePortalActionRequest): Promise<WebhookOutcome[]> {
    const fake = this.fake();
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true } });
    const row = user?.stripeCustomerId
      ? await this.prisma.subscription.findFirst({
          where: { userId, status: { in: PRO_STATUSES } },
          orderBy: { updatedAt: 'desc' },
          select: { stripeSubscriptionId: true, status: true, interval: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
        })
      : null;
    if (!user?.stripeCustomerId || !row) throw billingError('NO_BILLING_ACCOUNT', HttpStatus.CONFLICT);
    const id = row.stripeSubscriptionId;
    const current =
      fake.subscription(id) ??
      fake.restoreSubscription({
        id,
        customerId: user.stripeCustomerId,
        userId,
        status: fromPrismaStatus(row.status),
        interval: fromPrismaInterval(row.interval),
        currentPeriodEnd: row.currentPeriodEnd,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      });
    const interval = fromPrismaInterval(row.interval);
    let updated;
    switch (request.action) {
      case 'cancel_at_period_end':
        updated = fake.updateSubscription(id, { cancelAtPeriodEnd: true });
        break;
      case 'resume':
        updated = fake.updateSubscription(id, { cancelAtPeriodEnd: false });
        break;
      case 'switch_interval':
        updated = fake.updateSubscription(id, { interval: interval === 'month' ? 'year' : 'month' });
        break;
      case 'cancel_now':
        updated = fake.updateSubscription(id, { status: 'canceled', cancelAtPeriodEnd: false });
        break;
    }
    const object = updated ?? current;
    return this.deliver([fake.signEvent(request.action === 'cancel_now' ? 'customer.subscription.deleted' : 'customer.subscription.updated', object)]);
  }

  private async deliver(events: readonly SignedFakeEvent[]): Promise<WebhookOutcome[]> {
    const outcomes: WebhookOutcome[] = [];
    for (const event of events) outcomes.push(await this.webhook.handle(event.payload, event.signature));
    return outcomes;
  }
}
