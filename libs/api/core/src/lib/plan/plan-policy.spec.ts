import { TRIAL_INELIGIBLE_NOTICE, entitlementsSchema, trialDetailsSchema } from '@raijin/shared-contracts';
import { testConfig } from '../../testing/test-config';
import {
  buildTrialDetails,
  isTrialActive,
  planPolicyLimits,
  resolvePlanPolicy,
  trialStatusOf,
  type TrialRow,
} from './plan-policy';

const NOW = new Date('2026-11-22T10:00:00.000Z');
const HOUR = 3_600_000;
const limits = planPolicyLimits(testConfig());

function row(overrides: Partial<TrialRow> = {}): TrialRow {
  return {
    plan: 'FREE',
    trialStatus: 'NONE',
    trialStartedAt: null,
    trialEndsAt: null,
    trialEndScreenSeenAt: null,
    emailVerifiedAt: NOW,
    ...overrides,
  };
}

describe('planPolicyLimits', () => {
  it('reprend les valeurs par défaut de la configuration (PROMPT.md §4.4)', () => {
    expect(limits).toEqual({
      anonAnalysesPerDay: 3,
      free: { analysesPerDay: 5, maxActiveWatches: 3, pushAlerts: false, walletScansPerDay: 0, alertHistoryDays: 30 },
      trial: { analysesPerDay: 50, maxActiveWatches: 50, pushAlerts: true, walletScansPerDay: 10, alertHistoryDays: 90 },
      subscription: { analysesPerDay: null, maxActiveWatches: 50, pushAlerts: true, walletScansPerDay: 20, alertHistoryDays: 90 },
    });
    for (const value of [limits.free, limits.trial, limits.subscription]) expect(entitlementsSchema.parse(value)).toEqual(value);
  });

  it('suit la configuration (aucune valeur en dur)', () => {
    const custom = planPolicyLimits(
      testConfig({ FREE_ANALYSIS_DAILY_LIMIT: '7', TRIAL_ANALYSIS_DAILY_LIMIT: '40', FREE_WATCH_LIMIT: '2', WALLET_SCAN_DAILY_LIMIT_TRIAL: '4', ANON_ANALYSIS_DAILY_LIMIT: '1' }),
    );
    expect(custom.anonAnalysesPerDay).toBe(1);
    expect(custom.free).toMatchObject({ analysesPerDay: 7, maxActiveWatches: 2 });
    expect(custom.trial).toMatchObject({ analysesPerDay: 40, walletScansPerDay: 4 });
  });
});

describe('resolvePlanPolicy', () => {
  it('Gratuit sans essai', () => {
    expect(resolvePlanPolicy(row(), limits, NOW)).toEqual({
      effectivePlan: 'FREE',
      paidPlan: 'FREE',
      source: 'free',
      trialActive: false,
      emailVerified: true,
      entitlements: limits.free,
    });
  });

  it('essai actif : Pro avec analyses plafonnées', () => {
    const policy = resolvePlanPolicy(row({ trialStatus: 'ACTIVE', trialEndsAt: new Date(NOW.getTime() + 1_000) }), limits, NOW);
    expect(policy).toMatchObject({ effectivePlan: 'PRO', paidPlan: 'FREE', source: 'trial', trialActive: true });
    expect(policy.entitlements).toBe(limits.trial);
  });

  it("les droits de l'essai s'arrêtent à la seconde, même si le job n'est pas passé", () => {
    const exact = resolvePlanPolicy(row({ trialStatus: 'ACTIVE', trialEndsAt: NOW }), limits, NOW);
    expect(exact).toMatchObject({ source: 'free', trialActive: false, effectivePlan: 'FREE' });
    expect(isTrialActive({ trialStatus: 'ACTIVE', trialEndsAt: null }, NOW)).toBe(false);
    expect(isTrialActive({ trialStatus: 'ENDED', trialEndsAt: new Date(NOW.getTime() + HOUR) }, NOW)).toBe(false);
  });

  it("l'abonnement Pro prime sur l'essai", () => {
    const policy = resolvePlanPolicy(row({ plan: 'PRO', trialStatus: 'ACTIVE', trialEndsAt: new Date(NOW.getTime() + HOUR) }), limits, NOW);
    expect(policy).toMatchObject({ source: 'subscription', effectivePlan: 'PRO', trialActive: true });
    expect(policy.entitlements.analysesPerDay).toBeNull();
  });

  it('e-mail non vérifié signalé (suivis et push le refusent ailleurs)', () => {
    expect(resolvePlanPolicy(row({ emailVerifiedAt: null }), limits, NOW).emailVerified).toBe(false);
    expect(resolvePlanPolicy({ plan: 'FREE', trialStatus: 'NONE', trialEndsAt: null }, limits, NOW).emailVerified).toBe(false);
  });
});

describe('buildTrialDetails', () => {
  const started = new Date(NOW.getTime() - 3 * 24 * HOUR);

  it('aucun essai', () => {
    expect(buildTrialDetails(row(), NOW)).toEqual({ status: 'none', startedAt: null, endsAt: null, daysRemaining: null, endScreenDue: false, notice: null });
  });

  it('essai actif : jours restants arrondis au supérieur, pas d’écran de fin', () => {
    const details = buildTrialDetails(row({ trialStatus: 'ACTIVE', trialStartedAt: started, trialEndsAt: new Date(NOW.getTime() + 4 * 24 * HOUR - HOUR) }), NOW);
    expect(trialDetailsSchema.parse(details)).toEqual(details);
    expect(details).toMatchObject({ status: 'active', daysRemaining: 4, endScreenDue: false, notice: null });
  });

  it('dernières 24 h : écran de fin dû, sauf déjà vu ou abonné', () => {
    const base = row({ trialStatus: 'ACTIVE', trialStartedAt: started, trialEndsAt: new Date(NOW.getTime() + 23 * HOUR) });
    expect(buildTrialDetails(base, NOW)).toMatchObject({ endScreenDue: true, daysRemaining: 1 });
    expect(buildTrialDetails({ ...base, trialEndScreenSeenAt: NOW }, NOW).endScreenDue).toBe(false);
    expect(buildTrialDetails({ ...base, plan: 'PRO' }, NOW).endScreenDue).toBe(false);
  });

  it('échéance passée sans job : statut ended, écran de fin dû', () => {
    const details = buildTrialDetails(row({ trialStatus: 'ACTIVE', trialStartedAt: started, trialEndsAt: new Date(NOW.getTime() - 1) }), NOW);
    expect(details).toMatchObject({ status: 'ended', daysRemaining: null, endScreenDue: true });
  });

  it('essai terminé : écran dû tant que non vu et sans abonnement', () => {
    const ended = row({ trialStatus: 'ENDED', trialStartedAt: started, trialEndsAt: new Date(NOW.getTime() - HOUR) });
    expect(buildTrialDetails(ended, NOW).endScreenDue).toBe(true);
    expect(buildTrialDetails({ ...ended, trialEndScreenSeenAt: NOW }, NOW).endScreenDue).toBe(false);
    expect(buildTrialDetails({ ...ended, plan: 'PRO' }, NOW).endScreenDue).toBe(false);
  });

  it('inéligible : message neutre, jamais le motif', () => {
    expect(buildTrialDetails(row({ trialStatus: 'INELIGIBLE' }), NOW)).toMatchObject({ status: 'ineligible', notice: TRIAL_INELIGIBLE_NOTICE, endScreenDue: false });
    expect(trialStatusOf({ trialStatus: 'INCONNU', trialEndsAt: null }, NOW)).toBe('none');
  });
});
