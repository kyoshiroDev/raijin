import { ConfigError } from '@raijin/api-core';
import { loadBillingConfig, stripeConfigured } from './billing-config';

const DEV = { isProduction: false };
const PROD = { isProduction: true };
const STRIPE = {
  BILLING_PROVIDER: 'stripe',
  STRIPE_SECRET_KEY: 'sk_test_51abcdefghijklmnopqrstuvwxyz',
  STRIPE_WEBHOOK_SECRET: 'whsec_abcdefghijklmnopqrstuvwxyz',
  STRIPE_PRICE_PRO_MONTHLY: 'price_1Monthly0001',
  STRIPE_PRICE_PRO_YEARLY: 'price_1Yearly00001',
};

function problems(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  }
  return [];
}

describe('loadBillingConfig', () => {
  it('développement par défaut : simulation, secret éphémère, prix par défaut', () => {
    const warn = jest.fn();
    const config = loadBillingConfig({}, DEV, warn);
    expect(config).toMatchObject({ provider: 'fake', secretKey: null, livemode: false, perMinute: 10, prices: { monthlyCents: 990, yearlyCents: 9900, currency: 'EUR' } });
    expect(config.webhookSecret).toMatch(/^whsec_/);
    expect(loadBillingConfig({}, DEV).webhookSecret).not.toBe(config.webhookSecret);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('secret éphémère'));
  });

  it('production : stripe par défaut ; fake refusé', () => {
    expect(loadBillingConfig({}, PROD).provider).toBe('stripe');
    expect(problems(() => loadBillingConfig({ BILLING_PROVIDER: 'fake' }, PROD))).toEqual([expect.stringContaining('BILLING_PROVIDER')]);
  });

  it('stripe sans clés ou avec les valeurs factices : démarre, non configuré, avertissement sans valeur', () => {
    const warn = jest.fn();
    const config = loadBillingConfig(
      { BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_factice', STRIPE_WEBHOOK_SECRET: 'whsec_factice', STRIPE_PRICE_PRO_MONTHLY: 'price_factice_mensuel' },
      PROD,
      warn,
    );
    expect(stripeConfigured(config)).toBe(false);
    expect(config.secretKey).toBeNull();
    expect(warn.mock.calls[0]?.[0]).toContain('STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_PRO_MONTHLY, STRIPE_PRICE_PRO_YEARLY');
    expect(warn.mock.calls[0]?.[0]).not.toContain('sk_test_factice');
    expect(warn.mock.calls[0]?.[0]).not.toContain('price_factice_mensuel');
  });

  it('stripe complet : configuré, mode test ; clé live refusée hors production, acceptée en production', () => {
    const config = loadBillingConfig(STRIPE, DEV);
    expect(stripeConfigured(config)).toBe(true);
    expect(config.livemode).toBe(false);
    const live = { ...STRIPE, STRIPE_SECRET_KEY: 'sk_live_51abcdefghijklmnopqrstuvwxyz' };
    const issues = problems(() => loadBillingConfig(live, DEV));
    expect(issues).toEqual([expect.stringContaining('clé live interdite')]);
    expect(issues.join()).not.toContain('sk_live_51');
    expect(loadBillingConfig(live, PROD).livemode).toBe(true);
  });

  it('refuse des prix incohérents, une devise invalide, deux prix Stripe identiques', () => {
    expect(problems(() => loadBillingConfig({ PRO_PRICE_MONTHLY_CENTS: '9900', PRO_PRICE_YEARLY_CENTS: '990' }, DEV))).toEqual([expect.stringContaining('PRO_PRICE_YEARLY_CENTS')]);
    expect(problems(() => loadBillingConfig({ PRO_PRICE_MONTHLY_CENTS: '9.9' }, DEV))[0]).toContain('PRO_PRICE_MONTHLY_CENTS');
    expect(problems(() => loadBillingConfig({ BILLING_CURRENCY: 'euro' }, DEV))[0]).toContain('BILLING_CURRENCY');
    expect(problems(() => loadBillingConfig({ ...STRIPE, STRIPE_PRICE_PRO_YEARLY: STRIPE.STRIPE_PRICE_PRO_MONTHLY }, DEV))[0]).toContain('deux prix distincts');
  });

  it('options : configuration du portail, limite par minute (vide = 10)', () => {
    expect(loadBillingConfig({ STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_1abcdefg', RATE_LIMIT_BILLING_PER_MINUTE: '3' }, DEV)).toMatchObject({ portalConfigurationId: 'bpc_1abcdefg', perMinute: 3 });
    expect(loadBillingConfig({ RATE_LIMIT_BILLING_PER_MINUTE: '' }, DEV).perMinute).toBe(10);
  });
});
