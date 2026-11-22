import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@raijin/api-core';
import { Mailer, paymentFailedTemplate, receiptTemplate, type TemplateContext } from '@raijin/api-notifications';
import { BILLING_RETURN_PATHS, type BillingInterval } from '@raijin/shared-contracts';
import type { ProviderInvoice } from '../provider/billing-provider';

/** E-mails de l'abonnement : reçu (`invoice.paid`) et échec de paiement (`invoice.payment_failed`). */
@Injectable()
export class BillingMailService {
  private readonly ctx: TemplateContext;
  private readonly subscriptionUrl: string;

  constructor(
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.ctx = { logoUrl: config.mail.logoUrl, appUrl: config.appUrl };
    this.subscriptionUrl = `${config.appUrl}${BILLING_RETURN_PATHS.subscription}`;
  }

  /** `renewsAt` : fin de la période de l'abonnement relu chez Stripe (prochain renouvellement). */
  sendReceipt(to: string, invoice: ProviderInvoice, interval: BillingInterval | null, renewsAt: Date | null): Promise<void> {
    return this.mailer.send({
      to,
      ...receiptTemplate(this.ctx, {
        amountCents: invoice.amountPaidCents,
        currency: invoice.currency,
        interval,
        periodEnd: renewsAt,
        invoiceNumber: invoice.number,
        invoiceUrl: invoice.hostedInvoiceUrl,
        subscriptionUrl: this.subscriptionUrl,
      }),
    });
  }

  sendPaymentFailed(to: string, invoice: ProviderInvoice | null): Promise<void> {
    return this.mailer.send({
      to,
      ...paymentFailedTemplate(this.ctx, {
        amountCents: invoice && invoice.amountDueCents > 0 ? invoice.amountDueCents : null,
        currency: invoice?.currency ?? null,
        subscriptionUrl: this.subscriptionUrl,
      }),
    });
  }
}
