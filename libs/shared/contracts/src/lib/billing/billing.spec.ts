import {
  BILLING_ERROR_CODES,
  BILLING_ERROR_MESSAGES,
  TRIAL_INELIGIBLE_NOTICE,
  apiErrorCodeSchema,
  billingAccountSchema,
  billingPlansResponseSchema,
  checkoutSessionRequestSchema,
  fakeCheckoutCompleteRequestSchema,
  isAllowedBillingRedirect,
  isProSubscriptionStatus,
  notificationPreferencesSchema,
  trialConversionReportSchema,
  trialDaysRemaining,
  trialOfferText,
  trialRecapSchema,
  watchKeepRequestSchema,
  yearlySavingsPercent,
  type Entitlements,
} from '../../index';

const NOW = new Date('2026-11-22T10:00:00.000Z');
const FREE: Entitlements = {
  analysesPerDay: 5,
  maxActiveWatches: 3,
  pushAlerts: false,
  walletScansPerDay: 0,
  alertHistoryDays: 30,
};
const PRO: Entitlements = {
  analysesPerDay: null,
  maxActiveWatches: 50,
  pushAlerts: true,
  walletScansPerDay: 20,
  alertHistoryDays: 90,
};

describe('plans et prix', () => {
  it('valide la réponse publique des plans', () => {
    const plans = {
      free: { plan: 'FREE', entitlements: FREE },
      pro: {
        plan: 'PRO',
        entitlements: PRO,
        monthly: { interval: 'month', amountCents: 990, currency: 'EUR' },
        yearly: { interval: 'year', amountCents: 9900, currency: 'EUR' },
      },
      trial: {
        days: 7,
        entitlements: { ...PRO, analysesPerDay: 50, walletScansPerDay: 10 },
      },
      mode: 'simulation',
    };
    expect(billingPlansResponseSchema.safeParse(plans).success).toBe(true);
    const swapped = {
      ...plans,
      pro: { ...plans.pro, monthly: plans.pro.yearly },
    };
    expect(billingPlansResponseSchema.safeParse(swapped).success).toBe(false);
    const float = {
      ...plans,
      pro: {
        ...plans.pro,
        monthly: { ...plans.pro.monthly, amountCents: 9.9 },
      },
    };
    expect(billingPlansResponseSchema.safeParse(float).success).toBe(false);
  });

  it('calcule l’économie de l’annuel et la phrase d’offre', () => {
    expect(yearlySavingsPercent(990, 9900)).toBe(17);
    expect(yearlySavingsPercent(990, 11880)).toBe(0);
    expect(yearlySavingsPercent(0, 100)).toBe(0);
    expect(trialOfferText()).toBe(
      'Essaie Pro gratuitement pendant 7 jours. Sans carte bancaire.',
    );
  });
});

describe('checkout et redirections', () => {
  it('n’accepte que la périodicité (jamais de prix venu du front)', () => {
    expect(
      checkoutSessionRequestSchema.safeParse({ interval: 'year' }).success,
    ).toBe(true);
    expect(
      checkoutSessionRequestSchema.safeParse({
        interval: 'year',
        priceId: 'price_x',
      }).success,
    ).toBe(false);
    expect(
      checkoutSessionRequestSchema.safeParse({ interval: 'week' }).success,
    ).toBe(false);
  });

  it('limite les redirections aux hôtes Stripe et à l’origine de l’app', () => {
    const app = 'http://localhost:4300';
    expect(
      isAllowedBillingRedirect(
        'https://checkout.stripe.com/c/pay/cs_test_1',
        app,
      ),
    ).toBe(true);
    expect(
      isAllowedBillingRedirect('https://billing.stripe.com/p/session/x', app),
    ).toBe(true);
    expect(
      isAllowedBillingRedirect(
        'http://localhost:4300/abonnement/simulation?session=cs_fake_x',
        app,
      ),
    ).toBe(true);
    expect(
      isAllowedBillingRedirect('http://checkout.stripe.com/c/pay', app),
    ).toBe(false);
    expect(
      isAllowedBillingRedirect('https://checkout.stripe.com.evil.io/', app),
    ).toBe(false);
    expect(
      isAllowedBillingRedirect('https://user:pw@checkout.stripe.com/', app),
    ).toBe(false);
    expect(isAllowedBillingRedirect('javascript:alert(1)', app)).toBe(false);
    expect(isAllowedBillingRedirect('pas une url', app)).toBe(false);
  });

  it('valide les requêtes de simulation', () => {
    expect(
      fakeCheckoutCompleteRequestSchema.safeParse({
        sessionId: 'cs_fake_abcdefghijklmnop',
        outcome: 'paid',
      }).success,
    ).toBe(true);
    expect(
      fakeCheckoutCompleteRequestSchema.safeParse({
        sessionId: 'cs_test_abc',
        outcome: 'paid',
      }).success,
    ).toBe(false);
  });

  it('donne Pro aux statuts actif, essai Stripe et retard de paiement seulement', () => {
    expect(isProSubscriptionStatus('active')).toBe(true);
    expect(isProSubscriptionStatus('past_due')).toBe(true);
    expect(isProSubscriptionStatus('unpaid')).toBe(false);
    expect(isProSubscriptionStatus('canceled')).toBe(false);
    expect(isProSubscriptionStatus('incomplete')).toBe(false);
  });
});

describe('compte de facturation et essai', () => {
  it('valide un compte en essai', () => {
    const account = {
      plan: 'PRO',
      source: 'trial',
      entitlements: { ...PRO, analysesPerDay: 50, walletScansPerDay: 10 },
      subscription: null,
      trial: {
        status: 'active',
        startedAt: '2026-11-20T10:00:00.000Z',
        endsAt: '2026-11-27T10:00:00.000Z',
        daysRemaining: 5,
        endScreenDue: false,
        notice: null,
      },
      paymentIssue: false,
      portalAvailable: false,
      checkoutAvailable: true,
      mode: 'stripe',
    };
    expect(billingAccountSchema.safeParse(account).success).toBe(true);
    const ineligible = {
      ...account,
      plan: 'FREE',
      source: 'free',
      trial: {
        ...account.trial,
        status: 'ineligible',
        startedAt: null,
        endsAt: null,
        daysRemaining: null,
        notice: TRIAL_INELIGIBLE_NOTICE,
      },
    };
    expect(billingAccountSchema.safeParse(ineligible).success).toBe(true);
  });

  it('calcule les jours restants au jour supérieur', () => {
    expect(trialDaysRemaining('2026-11-25T09:00:00.000Z', NOW)).toBe(3);
    expect(trialDaysRemaining(new Date('2026-11-22T10:00:01.000Z'), NOW)).toBe(
      1,
    );
    expect(trialDaysRemaining('2026-11-21T10:00:00.000Z', NOW)).toBe(0);
    expect(trialDaysRemaining('invalide', NOW)).toBe(0);
  });

  it('valide le récapitulatif et le rapport de conversion', () => {
    expect(
      trialRecapSchema.safeParse({
        status: 'ended',
        startedAt: '2026-11-15T10:00:00.000Z',
        endsAt: '2026-11-22T10:00:00.000Z',
        analysesCount: 42,
        alertsCount: 3,
        dangerTokensCount: 7,
        walletScansCount: 2,
        activeWatches: 3,
        planLimitPausedWatches: 4,
      }).success,
    ).toBe(true);
    const report = {
      generatedAt: NOW.toISOString(),
      totals: {
        started: 10,
        active: 2,
        converted: 2,
        expired: 6,
        conversionRate: 0.25,
      },
      refusals: {
        email_already_used: 1,
        disposable_domain: 3,
        fingerprint_seen: 0,
      },
      cohorts: [
        {
          weekStart: '2026-11-16',
          started: 10,
          active: 2,
          converted: 2,
          expired: 6,
          conversionRate: 0.25,
        },
      ],
    };
    expect(trialConversionReportSchema.safeParse(report).success).toBe(true);
    expect(
      trialConversionReportSchema.safeParse({
        ...report,
        refusals: { disposable_domain: 3 },
      }).success,
    ).toBe(false);
  });
});

describe('suivis à garder et préférences', () => {
  const A = '0193a1b2-0000-7000-8000-000000000001';
  const B = '0193a1b2-0000-7000-8000-000000000002';

  it('refuse une liste vide ou avec doublons', () => {
    expect(watchKeepRequestSchema.safeParse({ watchIds: [A, B] }).success).toBe(
      true,
    );
    expect(watchKeepRequestSchema.safeParse({ watchIds: [] }).success).toBe(
      false,
    );
    expect(watchKeepRequestSchema.safeParse({ watchIds: [A, A] }).success).toBe(
      false,
    );
  });

  it('expose la préférence des e-mails d’essai', () => {
    expect(
      notificationPreferencesSchema.safeParse({
        emailAlerts: true,
        pushAlerts: true,
        weeklyDigest: false,
        trialEmails: false,
      }).success,
    ).toBe(true);
  });
});

describe('erreurs de l’abonnement', () => {
  it('sont intégrées aux codes de l’API avec un message', () => {
    for (const code of BILLING_ERROR_CODES) {
      expect(apiErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(BILLING_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
    }
    expect(apiErrorCodeSchema.safeParse('WATCH_KEEP_INVALID').success).toBe(
      true,
    );
  });
});
