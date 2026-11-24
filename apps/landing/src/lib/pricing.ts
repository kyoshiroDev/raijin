import {
  PUBLIC_PLAN_CATALOG,
  trialOfferText,
  yearlySavingsPercent,
  type Entitlements,
  type PublicPlanCatalog,
} from '@raijin/shared-contracts';

/**
 * Tarifs affichés par la landing, lus **au build** dans `PUBLIC_PLAN_CATALOG` (docs/ARCHITECTURE.md §15.2) :
 * aucune valeur en dur, aucun appel à l'API. Changer un prix = modifier le catalogue et reconstruire.
 */

/** Prix au format français (« 14,90 € »), espaces insécables normalisés. */
export function formatPrice(amountCents: number, currency: string): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency,
    minimumFractionDigits: amountCents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })
    .format(amountCents / 100)
    .replace(/\u202f|\u00a0/g, '\u00a0');
}

/** Liste des droits d'un plan, en phrases courtes (mêmes valeurs que `GET billing/plans`). */
export function entitlementLines(entitlements: Entitlements): string[] {
  const lines: string[] = [];
  lines.push(
    entitlements.analysesPerDay === null
      ? 'Analyses illimitées'
      : `${entitlements.analysesPerDay} analyses par jour`,
  );
  lines.push(`${entitlements.maxActiveWatches} tokens suivis`);
  lines.push(entitlements.pushAlerts ? 'Alertes push et e-mail' : 'Alertes par e-mail');
  if (entitlements.walletScansPerDay > 0) {
    lines.push(`Scan de wallet (${entitlements.walletScansPerDay} par jour)`);
  }
  lines.push(`Historique des alertes : ${entitlements.alertHistoryDays} jours`);
  return lines;
}

export interface PricingView {
  readonly anonAnalysesPerDay: number;
  readonly trialDays: number;
  readonly trialOffer: string;
  readonly trialAnalysesPerDay: number | null;
  readonly proMaxActiveWatches: number;
  readonly free: { readonly analysesPerDay: number | null; readonly maxActiveWatches: number; readonly lines: string[] };
  readonly pro: {
    readonly monthly: string;
    readonly yearly: string;
    readonly yearlySavingsPercent: number;
    readonly monthlyCents: number;
    readonly yearlyCents: number;
    readonly currency: string;
    readonly lines: string[];
  };
}

export function buildPricingView(catalog: PublicPlanCatalog = PUBLIC_PLAN_CATALOG): PricingView {
  const { pro, free, trial } = catalog;
  return {
    anonAnalysesPerDay: catalog.anonAnalysesPerDay,
    trialDays: trial.days,
    trialOffer: trialOfferText(trial.days),
    trialAnalysesPerDay: trial.entitlements.analysesPerDay,
    proMaxActiveWatches: pro.entitlements.maxActiveWatches,
    free: {
      analysesPerDay: free.entitlements.analysesPerDay,
      maxActiveWatches: free.entitlements.maxActiveWatches,
      lines: entitlementLines(free.entitlements),
    },
    pro: {
      monthly: formatPrice(pro.monthly.amountCents, pro.monthly.currency),
      yearly: formatPrice(pro.yearly.amountCents, pro.yearly.currency),
      yearlySavingsPercent: yearlySavingsPercent(pro.monthly.amountCents, pro.yearly.amountCents),
      monthlyCents: pro.monthly.amountCents,
      yearlyCents: pro.yearly.amountCents,
      currency: pro.monthly.currency,
      lines: entitlementLines(pro.entitlements),
    },
  };
}

export const PRICING = buildPricingView();
