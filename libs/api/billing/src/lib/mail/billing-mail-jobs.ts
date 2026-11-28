import { Injectable, OnModuleInit } from '@nestjs/common';
import { DisabledJobQueue, JobQueue, JobRegistry, jobId, type JobData } from '@raijin/api-alerts';
import { PrismaService } from '@raijin/api-prisma';
import * as z from 'zod';
import { BillingProvider, type ProviderInvoice } from '../provider/billing-provider';
import { BillingMailService } from './billing-mail.service';

export const BILLING_EMAIL_JOB = 'billing-email';

const invoiceSnapshotSchema = z
  .object({
    id: z.string().min(1).max(255),
    customerId: z.string().max(255).nullable(),
    subscriptionId: z.string().max(255).nullable(),
    amountPaidCents: z.number().int().min(0).max(100_000_000),
    amountDueCents: z.number().int().min(0).max(100_000_000),
    currency: z.string().regex(/^[A-Z]{3}$/),
    number: z.string().max(255).nullable(),
    hostedInvoiceUrl: z.string().regex(/^https:\/\/invoice\.stripe\.com\//).max(2048).nullable(),
    periodEnd: z.iso.datetime().nullable(),
  })
  .strict();

const billingEmailDataSchema = z
  .object({
    kind: z.enum(['receipt', 'payment_failed']),
    userId: z.uuid(),
    interval: z.enum(['month', 'year']).nullable(),
    renewsAt: z.iso.datetime().nullable(),
    invoice: invoiceSnapshotSchema.nullable(),
  })
  .strict();
export type BillingEmailJob = z.infer<typeof billingEmailDataSchema>;

function snapshot(invoice: ProviderInvoice): z.infer<typeof invoiceSnapshotSchema> {
  return { ...invoice, periodEnd: invoice.periodEnd?.toISOString() ?? null };
}

function fromSnapshot(data: z.infer<typeof invoiceSnapshotSchema>): ProviderInvoice {
  return { ...data, periodEnd: data.periodEnd ? new Date(data.periodEnd) : null };
}

/**
 * E-mails de facturation (reçu, échec de paiement) par la file BullMQ `notify` (job `billing-email` déclaré dans
 * le `JobRegistry` d'`api-alerts`) : réessais BullMQ, `jobId` = facture (un seul e-mail par facture et par type).
 * Le traitement relit l'adresse en base et le montant chez le prestataire. Jobs désactivés (tests, dev sans
 * Redis) : envoi direct.
 */
@Injectable()
export class BillingMailJobs implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly queue: JobQueue,
    private readonly mail: BillingMailService,
    private readonly provider: BillingProvider,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register({ name: BILLING_EMAIL_JOB, queue: 'notify', handler: (data: JobData) => this.run(data) });
  }

  /** `key` : identifiant de l'événement si la facture est inconnue. */
  async enqueue(input: { kind: BillingEmailJob['kind']; userId: string; interval: BillingEmailJob['interval']; renewsAt: Date | null; invoice: ProviderInvoice | null }, key: string): Promise<void> {
    const data: BillingEmailJob = {
      kind: input.kind,
      userId: input.userId,
      interval: input.interval,
      renewsAt: input.renewsAt?.toISOString() ?? null,
      invoice: input.invoice ? snapshot(input.invoice) : null,
    };
    if (this.queue instanceof DisabledJobQueue) {
      await this.run(data);
      return;
    }
    await this.queue.add(BILLING_EMAIL_JOB, data, { jobId: jobId('billing', input.kind, input.invoice?.id ?? key) });
  }

  /** Traitement du job (données revalidées : un job altéré dans Redis n'envoie rien d'imprévu). */
  async run(raw: JobData): Promise<{ sent: boolean }> {
    const data = billingEmailDataSchema.parse(raw);
    const user = await this.prisma.user.findUnique({ where: { id: data.userId }, select: { email: true } });
    if (!user) return { sent: false };
    const stored = data.invoice ? fromSnapshot(data.invoice) : null;
    const invoice = stored ? ((await this.provider.retrieveInvoice(stored.id)) ?? stored) : null;
    if (data.kind === 'receipt') {
      if (!invoice || invoice.amountPaidCents <= 0) return { sent: false };
      await this.mail.sendReceipt(user.email, invoice, data.interval, data.renewsAt ? new Date(data.renewsAt) : null);
    } else {
      await this.mail.sendPaymentFailed(user.email, invoice);
    }
    return { sent: true };
  }
}
