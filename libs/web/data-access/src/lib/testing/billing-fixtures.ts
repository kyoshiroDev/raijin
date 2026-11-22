import type { BillingAccount, BillingPlansResponse, Entitlements, Subscription, TrialDetails, TrialRecap } from '@raijin/shared-contracts';

/** Données de test conformes aux contrats de l'abonnement et de l'essai (specs, captures). */
export const FREE_ENTITLEMENTS: Entitlements = { analysesPerDay: 5, maxActiveWatches: 3, pushAlerts: false, walletScansPerDay: 0, alertHistoryDays: 30 };
export const PRO_ENTITLEMENTS: Entitlements = { analysesPerDay: null, maxActiveWatches: 50, pushAlerts: true, walletScansPerDay: 20, alertHistoryDays: 90 };
export const TRIAL_ENTITLEMENTS: Entitlements = { ...PRO_ENTITLEMENTS, analysesPerDay: 50, walletScansPerDay: 10 };

export function fakeBillingPlans(overrides: Partial<BillingPlansResponse> = {}): BillingPlansResponse {
  return {
    free: { plan: 'FREE', entitlements: FREE_ENTITLEMENTS },
    pro: {
      plan: 'PRO',
      entitlements: PRO_ENTITLEMENTS,
      monthly: { interval: 'month', amountCents: 990, currency: 'EUR' },
      yearly: { interval: 'year', amountCents: 9900, currency: 'EUR' },
    },
    trial: { days: 7, entitlements: TRIAL_ENTITLEMENTS },
    mode: 'stripe',
    ...overrides,
  };
}

export function fakeTrialDetails(overrides: Partial<TrialDetails> = {}): TrialDetails {
  return { status: 'none', startedAt: null, endsAt: null, daysRemaining: null, endScreenDue: false, notice: null, ...overrides };
}

export function fakeSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return { status: 'active', interval: 'month', currentPeriodEnd: '2026-12-22T10:00:00.000Z', cancelAtPeriodEnd: false, ...overrides };
}

/** Compte Gratuit (essai terminé) par défaut. */
export function fakeBillingAccount(overrides: Partial<BillingAccount> = {}): BillingAccount {
  return {
    plan: 'FREE',
    source: 'free',
    entitlements: FREE_ENTITLEMENTS,
    subscription: null,
    trial: fakeTrialDetails({ status: 'ended', startedAt: '2026-11-15T10:00:00.000Z', endsAt: '2026-11-22T09:00:00.000Z', daysRemaining: 0 }),
    paymentIssue: false,
    portalAvailable: false,
    checkoutAvailable: true,
    mode: 'stripe',
    ...overrides,
  };
}

export function fakeTrialAccount(daysRemaining = 3, overrides: Partial<BillingAccount> = {}): BillingAccount {
  return fakeBillingAccount({
    plan: 'PRO',
    source: 'trial',
    entitlements: TRIAL_ENTITLEMENTS,
    trial: fakeTrialDetails({
      status: 'active',
      startedAt: '2026-11-19T10:00:00.000Z',
      endsAt: new Date(Date.parse('2026-11-22T10:00:00.000Z') + daysRemaining * 86_400_000).toISOString(),
      daysRemaining,
      endScreenDue: daysRemaining <= 1,
    }),
    ...overrides,
  });
}

export function fakeProAccount(subscription: Partial<Subscription> = {}, overrides: Partial<BillingAccount> = {}): BillingAccount {
  return fakeBillingAccount({
    plan: 'PRO',
    source: 'subscription',
    entitlements: PRO_ENTITLEMENTS,
    subscription: fakeSubscription(subscription),
    portalAvailable: true,
    checkoutAvailable: false,
    ...overrides,
  });
}

export function fakeTrialRecap(overrides: Partial<TrialRecap> = {}): TrialRecap {
  return {
    status: 'ended',
    startedAt: '2026-11-15T10:00:00.000Z',
    endsAt: '2026-11-22T09:00:00.000Z',
    analysesCount: 42,
    alertsCount: 3,
    dangerTokensCount: 7,
    walletScansCount: 2,
    activeWatches: 3,
    planLimitPausedWatches: 2,
    ...overrides,
  };
}
