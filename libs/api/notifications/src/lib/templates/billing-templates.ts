import type { RenderedMail, TemplateContext } from './auth-templates';
import { button, escapeHtml, EMAIL_THEME, fallbackLink, paragraph, renderLayout, renderText } from './layout';

/** Données d'un reçu (montant relu chez Stripe, jamais calculé par Raijin). */
export interface ReceiptMailInput {
  readonly amountCents: number;
  /** ISO 4217 (ex. EUR). */
  readonly currency: string;
  readonly interval: 'month' | 'year' | null;
  /** Fin de la période payée (prochain renouvellement). */
  readonly periodEnd: Date | null;
  readonly invoiceNumber: string | null;
  /** Facture hébergée par Stripe (https://invoice.stripe.com/…), sinon `null`. */
  readonly invoiceUrl: string | null;
  /** Page Abonnement de l'app (`APP_URL/abonnement`). */
  readonly subscriptionUrl: string;
}

export interface PaymentFailedMailInput {
  readonly amountCents: number | null;
  readonly currency: string | null;
  readonly subscriptionUrl: string;
}

/** « 9,90 € » (fr-FR, espaces insécables normalisés pour les clients mail). */
export function formatAmount(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(cents / 100).replace(/\u202f/g, '\u00a0');
  } catch {
    return `${(cents / 100).toFixed(2).replace('.', ',')} ${currency}`;
  }
}

/** « 22 décembre 2026 » (heure de Paris). */
export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' }).format(date);
}

const INTERVAL_LABEL = { month: 'Raijin Pro, mensuel', year: 'Raijin Pro, annuel' } as const;

/** Tableau récapitulatif (libellé / valeur), styles en ligne. */
function summary(rows: readonly (readonly [string, string])[]): string {
  const t = EMAIL_THEME;
  const cells = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:8px 0;font-family:Inter,ui-sans-serif,system-ui,sans-serif;font-size:14px;line-height:20px;color:${t['ink-muted']};">${escapeHtml(label)}</td><td align="right" style="padding:8px 0;font-family:Inter,ui-sans-serif,system-ui,sans-serif;font-size:14px;line-height:20px;font-weight:600;color:${t.ink};">${escapeHtml(value)}</td></tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-top:1px solid ${t.line};border-bottom:1px solid ${t.line};">${cells}</table>`;
}

/** Lien vers la facture hébergée par Stripe. */
function invoiceLink(href: string): string {
  const t = EMAIL_THEME;
  return `<p style="margin:0 0 16px;font-family:Inter,ui-sans-serif,system-ui,sans-serif;font-size:13px;line-height:20px;color:${t['ink-muted']};">Ta facture détaillée : <a href="${escapeHtml(href)}" style="color:${t['thunder-ink']};word-break:break-all;">${escapeHtml(href)}</a></p>`;
}

/** Reçu de paiement (`invoice.paid`) : premier paiement et renouvellements. */
export function receiptTemplate(ctx: TemplateContext, input: ReceiptMailInput): RenderedMail {
  const amount = formatAmount(input.amountCents, input.currency);
  const rows: [string, string][] = [
    ['Formule', input.interval ? INTERVAL_LABEL[input.interval] : 'Raijin Pro'],
    ['Montant payé', amount],
  ];
  if (input.periodEnd) rows.push(['Prochain renouvellement', formatDate(input.periodEnd)]);
  if (input.invoiceNumber) rows.push(['Facture', input.invoiceNumber]);
  const intro = 'Merci, ton paiement est bien passé. Tu profites de Raijin Pro : analyses illimitées, suivis et alertes push.';
  const manage = 'Tu peux changer de formule ou résilier à tout moment depuis la page Abonnement.';
  const body = [
    paragraph(intro),
    summary(rows),
    input.invoiceUrl ? invoiceLink(input.invoiceUrl) : '',
    paragraph(manage),
    button('Voir mon abonnement', input.subscriptionUrl),
    fallbackLink(input.subscriptionUrl),
  ]
    .filter(Boolean)
    .join('\n');
  return {
    subject: `Ton reçu Raijin Pro (${amount})`,
    html: renderLayout({ title: 'Ton reçu Raijin Pro', preheader: `Paiement de ${amount} reçu. Merci.`, body, ...ctx }),
    text: renderText([
      'Ton reçu Raijin Pro',
      intro,
      rows.map(([label, value]) => `${label} : ${value}`).join('\n'),
      ...(input.invoiceUrl ? [`Facture détaillée : ${input.invoiceUrl}`] : []),
      manage,
      `Voir mon abonnement : ${input.subscriptionUrl}`,
    ]),
  };
}

/** Échec de paiement (`invoice.payment_failed`) : ton neutre, aucune urgence artificielle. */
export function paymentFailedTemplate(ctx: TemplateContext, input: PaymentFailedMailInput): RenderedMail {
  const amount = input.amountCents && input.currency ? ` de ${formatAmount(input.amountCents, input.currency)}` : '';
  const intro = `Le paiement${amount} pour ton abonnement Raijin Pro n’est pas passé.`;
  const keep = 'Tu gardes Pro pendant que nous réessayons automatiquement dans les prochains jours.';
  const action = 'Pour éviter une interruption, vérifie ou change ton moyen de paiement depuis la page Abonnement.';
  const body = [paragraph(intro), paragraph(keep), paragraph(action), button('Mettre à jour mon paiement', input.subscriptionUrl), fallbackLink(input.subscriptionUrl)].join('\n');
  return {
    subject: 'Ton paiement Raijin Pro n’est pas passé',
    html: renderLayout({ title: 'Ton paiement n’est pas passé', preheader: 'Vérifie ton moyen de paiement pour garder Pro.', body, ...ctx }),
    text: renderText(['Ton paiement n’est pas passé', intro, keep, action, `Mettre à jour mon paiement : ${input.subscriptionUrl}`]),
  };
}
