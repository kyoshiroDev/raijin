import { PUBLIC_PLAN_CATALOG, trialOfferText } from '@raijin/shared-contracts';
import { describe, expect, it } from 'vitest';
import { buildPricingView, entitlementLines, formatPrice, PRICING } from './pricing';

describe('tarifs affichés', () => {
  it('formate les prix en français', () => {
    expect(formatPrice(1490, 'EUR')).toBe('14,90\u00a0€');
    expect(formatPrice(14900, 'EUR')).toBe('149\u00a0€');
  });

  it('reprend exactement le catalogue partagé', () => {
    const { pro, free, trial, anonAnalysesPerDay } = PUBLIC_PLAN_CATALOG;
    expect(PRICING.pro.monthly).toBe(formatPrice(pro.monthly.amountCents, pro.monthly.currency));
    expect(PRICING.pro.yearly).toBe(formatPrice(pro.yearly.amountCents, pro.yearly.currency));
    expect(PRICING.pro.monthlyCents).toBe(pro.monthly.amountCents);
    expect(PRICING.anonAnalysesPerDay).toBe(anonAnalysesPerDay);
    expect(PRICING.free.analysesPerDay).toBe(free.entitlements.analysesPerDay);
    expect(PRICING.trialDays).toBe(trial.days);
    expect(PRICING.trialOffer).toBe(trialOfferText(trial.days));
    expect(PRICING.trialOffer).toBe('Essaie Pro gratuitement pendant 7 jours. Sans carte bancaire.');
    expect(PRICING.pro.yearlySavingsPercent).toBe(17);
  });

  it('suit une modification du catalogue (aucune valeur en dur)', () => {
    const view = buildPricingView({
      ...PUBLIC_PLAN_CATALOG,
      anonAnalysesPerDay: 2,
      pro: { ...PUBLIC_PLAN_CATALOG.pro, monthly: { interval: 'month', amountCents: 1290, currency: 'EUR' } },
    });
    expect(view.anonAnalysesPerDay).toBe(2);
    expect(view.pro.monthly).toBe('12,90\u00a0€');
  });

  it('décrit les droits sans promesse', () => {
    expect(entitlementLines(PUBLIC_PLAN_CATALOG.free.entitlements)).toEqual([
      '5 analyses par jour',
      '3 tokens suivis',
      'Alertes par e-mail',
      'Historique des alertes : 30 jours',
    ]);
    expect(entitlementLines(PUBLIC_PLAN_CATALOG.pro.entitlements)).toContain('Analyses illimitées');
    expect(entitlementLines(PUBLIC_PLAN_CATALOG.pro.entitlements)).toContain('Scan de wallet (20 par jour)');
  });
});
