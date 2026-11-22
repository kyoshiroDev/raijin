import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ApiException, errorCode } from '@raijin/api-core';
import { PrismaService } from '@raijin/api-prisma';
import { PRO_SUBSCRIPTION_STATUSES } from '@raijin/shared-contracts';
import { BillingProvider } from '../provider/billing-provider';
import { toPrismaStatus } from './billing-enums';

const PRO_STATUSES = PRO_SUBSCRIPTION_STATUSES.map(toPrismaStatus);

/**
 * Le prestataire n'a pas pu clôturer la facturation (panne, Stripe non configuré) : 503. Le compte ne doit PAS
 * être supprimé (sinon l'abonnement continuerait d'être prélevé sans compte pour le gérer).
 */
export class BillingAccountCloseError extends ApiException {
  constructor() {
    super('UPSTREAM_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE);
    this.name = 'BillingAccountCloseError';
  }
}

/**
 * Clôture de la facturation avant la suppression d'un compte (audit phase 6, I1) : résilie **immédiatement**
 * (sans prorata) tout abonnement `active` / `trialing` / `past_due` chez le prestataire (ceux qu'il connaît et
 * ceux de la base), puis supprime le client Stripe et le détache du compte. Idempotent : sans client Stripe,
 * rien à faire. Toute erreur du prestataire → `BillingAccountCloseError` (compte conservé, l'appelant répond 503).
 */
@Injectable()
export class BillingAccountCloser {
  private readonly logger = new Logger('BillingAccountCloser');

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: BillingProvider,
  ) {}

  async closeForUser(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true } });
    const customerId = user?.stripeCustomerId;
    if (!customerId) return;
    if (this.provider.mode() === 'unavailable') {
      this.logger.error('Clôture impossible : prestataire de paiement non configuré (BILLING_NOT_CONFIGURED)');
      throw new BillingAccountCloseError();
    }
    try {
      const local = await this.prisma.subscription.findMany({ where: { userId, status: { in: PRO_STATUSES } }, select: { stripeSubscriptionId: true } });
      const remote = await this.provider.listProSubscriptions(customerId);
      const ids = new Set([...remote.map((sub) => sub.id), ...local.map((row) => row.stripeSubscriptionId)]);
      for (const id of ids) await this.provider.cancelSubscriptionNow(id);
      await this.provider.deleteCustomer(customerId);
    } catch (error) {
      this.logger.error(`Clôture de la facturation en échec (${errorCode(error)})`);
      throw new BillingAccountCloseError();
    }
    // Base alignée tout de suite (les webhooks de résiliation arriveront ensuite, sans compte rattaché).
    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.updateMany({ where: { userId, status: { in: PRO_STATUSES } }, data: { status: 'CANCELED', cancelAtPeriodEnd: false } });
      await tx.user.update({ where: { id: userId }, data: { stripeCustomerId: null, plan: 'FREE' } });
    });
    this.logger.log('Facturation clôturée avant suppression du compte');
  }
}
