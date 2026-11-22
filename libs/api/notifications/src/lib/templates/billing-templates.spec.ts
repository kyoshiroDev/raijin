import { formatAmount, formatDate, paymentFailedTemplate, receiptTemplate } from './billing-templates';
import { LEGAL_NOTICE } from './layout';

const ctx = { logoUrl: 'https://app.raijinshield.com/icons/icon-192.png', appUrl: 'https://app.raijinshield.com' };
const subscriptionUrl = 'https://app.raijinshield.com/abonnement';

describe('templates de l’abonnement', () => {
  it('formate montants et dates en français', () => {
    expect(formatAmount(990, 'EUR')).toBe('9,90 €');
    expect(formatAmount(9900, 'EUR')).toBe('99,00 €');
    expect(formatAmount(990, 'XX')).toBe('9,90 XX');
    expect(formatDate(new Date('2026-12-22T12:00:00.000Z'))).toBe('22 décembre 2026');
  });

  it('reçu : montant, formule, renouvellement, facture, thème clair, tutoiement, mention légale', () => {
    const mail = receiptTemplate(ctx, {
      amountCents: 9900,
      currency: 'EUR',
      interval: 'year',
      periodEnd: new Date('2027-11-22T12:00:00.000Z'),
      invoiceNumber: 'ABC-0001',
      invoiceUrl: 'https://invoice.stripe.com/i/acct_x/test_y',
      subscriptionUrl,
    });
    expect(mail.subject).toBe('Ton reçu Raijin Pro (99,00 €)');
    expect(mail.html).toContain('data-theme="light"');
    expect(mail.html).toContain('Raijin Pro, annuel');
    expect(mail.html).toContain('22 novembre 2027');
    expect(mail.html).toContain('href="https://invoice.stripe.com/i/acct_x/test_y"');
    expect(mail.html).toContain(`href="${subscriptionUrl}"`);
    expect(mail.text).toContain('Montant payé : 99,00 €');
    expect(mail.text).toContain('Facture : ABC-0001');
    expect(mail.text).toContain('Tu peux changer de formule');
    expect(mail.text).toContain(LEGAL_NOTICE);
    expect(mail.html).toContain('pas un conseil en investissement');
  });

  it('reçu minimal : sans périodicité, date ni facture', () => {
    const mail = receiptTemplate(ctx, { amountCents: 990, currency: 'EUR', interval: null, periodEnd: null, invoiceNumber: null, invoiceUrl: null, subscriptionUrl });
    expect(mail.text).toContain('Formule : Raijin Pro');
    expect(mail.text).not.toContain('Prochain renouvellement');
    expect(mail.html).not.toContain('invoice.stripe.com');
  });

  it('échec de paiement : ton neutre, Pro gardé pendant les relances, lien vers /abonnement', () => {
    const mail = paymentFailedTemplate(ctx, { amountCents: 990, currency: 'EUR', subscriptionUrl });
    expect(mail.subject).toBe('Ton paiement Raijin Pro n’est pas passé');
    expect(mail.text).toContain('Le paiement de 9,90 €');
    expect(mail.text).toContain('Tu gardes Pro');
    expect(mail.text).toContain(`Mettre à jour mon paiement : ${subscriptionUrl}`);
    expect(mail.html).toContain(LEGAL_NOTICE.replace('’', '&#39;').slice(0, 10));
    expect(mail.text).not.toMatch(/urgent|dernière chance|immédiatement/i);
    expect(paymentFailedTemplate(ctx, { amountCents: null, currency: null, subscriptionUrl }).text).toContain('Le paiement pour ton abonnement');
  });
});
