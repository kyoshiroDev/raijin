import type { BillingAccount, BillingInterval, Entitlements, Price } from '@raijin/shared-contracts';

const DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

/** Montant en centimes → « 9,90 € » (fr-FR, devise renvoyée par l'API). Rien n'est écrit en dur. */
export function formatPrice(amountCents: number, currency: string): string {
  const fractionDigits = amountCents % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, minimumFractionDigits: fractionDigits, maximumFractionDigits: 2 }).format(amountCents / 100);
}

/** Prix « par mois » d'un abonnement annuel (affichage seulement, arrondi au centime). */
export function monthlyEquivalent(price: Price): string {
  return formatPrice(Math.round(price.amountCents / 12), price.currency);
}

export function formatDate(iso: string): string {
  return DATE.format(new Date(iso));
}

export const INTERVAL_SUFFIX: Readonly<Record<BillingInterval, string>> = { month: '/ mois', year: '/ an' };
export const INTERVAL_NAME: Readonly<Record<BillingInterval, string>> = { month: 'mensuel', year: 'annuel' };

export interface EntitlementLine {
  readonly text: string;
  readonly included: boolean;
}

const plural = (count: number, singular: string, pluralForm = `${singular}s`) => `${count} ${count > 1 ? pluralForm : singular}`;

/** Droits d'un plan, tels que renvoyés par l'API (`entitlements`). */
export function entitlementLines(entitlements: Entitlements): EntitlementLine[] {
  return [
    {
      text: entitlements.analysesPerDay === null ? 'Analyses illimitées' : `${plural(entitlements.analysesPerDay, 'analyse')} par jour`,
      included: true,
    },
    { text: `${plural(entitlements.maxActiveWatches, 'token suivi', 'tokens suivis')} à la fois`, included: true },
    { text: 'Alertes par e-mail', included: true },
    { text: 'Notifications push', included: entitlements.pushAlerts },
    {
      text: entitlements.walletScansPerDay > 0 ? `${plural(entitlements.walletScansPerDay, 'scan', 'scans')} de wallet par jour` : 'Scan de wallet',
      included: entitlements.walletScansPerDay > 0,
    },
    { text: `Historique des alertes sur ${entitlements.alertHistoryDays} jours`, included: true },
  ];
}

export type StatusTone = 'safe' | 'warn' | 'info';

export interface PlanStatus {
  readonly title: string;
  readonly detail: string;
  readonly tone: StatusTone;
}

/** Statut du plan pour la carte « Ton plan » : factuel, sans urgence. */
export function planStatus(account: BillingAccount): PlanStatus {
  const { subscription, trial } = account;
  if (account.source === 'subscription' && subscription) {
    const interval = INTERVAL_NAME[subscription.interval];
    const end = formatDate(subscription.currentPeriodEnd);
    if (account.paymentIssue || subscription.status === 'past_due') {
      return {
        title: `Pro, abonnement ${interval}`,
        detail: 'Le dernier paiement n’a pas abouti. Pro reste actif pendant que Stripe réessaie : mets à jour ton moyen de paiement depuis « Gérer mon abonnement ».',
        tone: 'warn',
      };
    }
    if (subscription.cancelAtPeriodEnd) {
      return { title: `Pro, abonnement ${interval}`, detail: `Résiliation programmée : Pro reste actif jusqu’au ${end}, puis ton compte repasse en Gratuit.`, tone: 'info' };
    }
    return { title: `Pro, abonnement ${interval}`, detail: `Actif. Prochain renouvellement le ${end}.`, tone: 'safe' };
  }
  if (account.source === 'trial' && trial.endsAt) {
    const days = trial.daysRemaining ?? 0;
    const left = days <= 1 ? 'Il se termine aujourd’hui.' : `Il reste ${days} jours.`;
    return { title: 'Essai Pro', detail: `Toutes les fonctions Pro jusqu’au ${formatDate(trial.endsAt)}. ${left}`, tone: 'info' };
  }
  if (account.source === 'gift') {
    const end = account.giftEndsAt ? ` jusqu’au ${formatDate(account.giftEndsAt)}` : '';
    return { title: 'Pro offert', detail: `Toutes les fonctions Pro te sont offertes${end}. Aucun paiement ne t’est demandé.`, tone: 'safe' };
  }
  if (trial.notice) return { title: 'Gratuit', detail: trial.notice, tone: 'info' };
  if (trial.status === 'ended') return { title: 'Gratuit', detail: 'Ton essai Pro est terminé. Tu peux passer à Pro quand tu veux.', tone: 'info' };
  return { title: 'Gratuit', detail: 'Tu utilises la formule gratuite de Raijin.', tone: 'info' };
}
