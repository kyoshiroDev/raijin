import { RecordingJobQueue } from '@raijin/api-alerts';
import { billingKit } from '../../testing/billing-test-kit';
import { BILLING_EMAIL_JOB } from './billing-mail-jobs';

const USER = '0195a0c4-0000-7000-8000-0000000000aa';

describe('BillingMailJobs (file notify)', () => {
  it('met le reçu en file (jobId = facture, sans doublon) puis l’envoie avec le montant relu chez le prestataire', async () => {
    const queue = new RecordingJobQueue();
    const kit = billingKit({ queue });
    kit.prisma.addUser({ id: USER, email: 'kyo@exemple.fr' });
    const sub = kit.fake.createSubscription({ customerId: 'cus_fake_1', userId: USER, interval: 'month', status: 'active' });
    const invoice = kit.fake.createInvoice(sub, true);
    const stored = await kit.fake.retrieveInvoice(invoice['id'] as string);
    if (!stored) throw new Error('facture');
    const input = { kind: 'receipt' as const, userId: USER, interval: 'month' as const, renewsAt: new Date('2026-12-22T12:00:00.000Z'), invoice: { ...stored, amountPaidCents: 1 } };
    await kit.mailJobs.enqueue(input, 'evt_1');
    await kit.mailJobs.enqueue(input, 'evt_2');
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({ name: BILLING_EMAIL_JOB, options: { jobId: `billing-receipt-${stored.id}` } });
    expect(kit.mailer.sent).toHaveLength(0);
    const handler = kit.registry.get(BILLING_EMAIL_JOB);
    expect(handler?.queue).toBe('notify');
    await expect(handler?.handler(queue.jobs[0]?.data ?? {})).resolves.toEqual({ sent: true });
    expect(kit.mailer.sent[0]?.subject).toBe('Ton reçu Raijin Pro (14,90 €)');
  });

  it('données altérées refusées ; compte supprimé ou reçu à 0 € : rien envoyé ; échec sans facture', async () => {
    const kit = billingKit();
    kit.prisma.addUser({ id: USER, email: 'kyo@exemple.fr' });
    await expect(kit.mailJobs.run({ kind: 'receipt', userId: 'x', interval: null, renewsAt: null, invoice: null })).rejects.toThrow();
    await expect(kit.mailJobs.run({ kind: 'receipt', userId: '0195a0c4-0000-7000-8000-0000000000ff', interval: null, renewsAt: null, invoice: null })).resolves.toEqual({ sent: false });
    await expect(kit.mailJobs.run({ kind: 'receipt', userId: USER, interval: null, renewsAt: null, invoice: null })).resolves.toEqual({ sent: false });
    await expect(kit.mailJobs.run({ kind: 'payment_failed', userId: USER, interval: null, renewsAt: null, invoice: null })).resolves.toEqual({ sent: true });
    expect(kit.mailer.sent.map((mail) => mail.subject)).toEqual(['Ton paiement Raijin Pro n’est pas passé']);
  });
});
