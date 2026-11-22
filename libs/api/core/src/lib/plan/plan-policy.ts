import {
  TRIAL_INELIGIBLE_NOTICE,
  trialDaysRemaining,
  type Entitlements,
  type Plan,
  type PlanSource,
  type TrialDetails,
  type TrialStatus,
} from '@raijin/shared-contracts';
import type { AppConfig } from '../config/app-config';

/**
 * Source unique des droits et de l'état d'essai de toute l'API (docs/ARCHITECTURE.md §13.4).
 * Fonctions **pures** (aucun accès base) : la ligne `User` est relue en base à chaque requête avec
 * `PLAN_POLICY_USER_SELECT`, puis passée ici avec l'heure courante.
 */

/** Statuts Prisma de l'essai (enum `TrialStatus`). */
export type TrialStatusRow = 'NONE' | 'ACTIVE' | 'ENDED' | 'INELIGIBLE';

/** Colonnes `User` lues par la politique (sélection Prisma). */
export const PLAN_POLICY_USER_SELECT = {
  plan: true,
  emailVerifiedAt: true,
  trialStatus: true,
  trialStartedAt: true,
  trialEndsAt: true,
  trialEndScreenSeenAt: true,
} as const;

export interface PlanPolicyRow {
  /** Plan **payé** (`PRO` seulement avec un abonnement Pro ; reste `FREE` pendant l'essai). */
  readonly plan: Plan;
  readonly trialStatus: TrialStatusRow | string;
  readonly trialEndsAt: Date | null;
  readonly emailVerifiedAt?: Date | null;
}

export interface TrialRow extends PlanPolicyRow {
  readonly trialStartedAt: Date | null;
  readonly trialEndScreenSeenAt: Date | null;
}

/** Droits par origine du plan, tirés de la configuration (aucune valeur en dur). */
export interface PlanPolicyLimits {
  /** Analyses par jour d'un visiteur anonyme (par empreinte d'IP). */
  readonly anonAnalysesPerDay: number;
  readonly free: Entitlements;
  readonly trial: Entitlements;
  readonly subscription: Entitlements;
}

export interface PlanPolicy {
  /** Plan effectif : `PRO` avec un abonnement Pro ou pendant l'essai actif. */
  readonly effectivePlan: Plan;
  /** Plan payé (colonne `User.plan`). */
  readonly paidPlan: Plan;
  readonly source: PlanSource;
  readonly trialActive: boolean;
  readonly emailVerified: boolean;
  readonly entitlements: Entitlements;
}

export function planPolicyLimits(config: AppConfig): PlanPolicyLimits {
  return {
    anonAnalysesPerDay: config.analysis.anonDailyLimit,
    free: {
      analysesPerDay: config.analysis.freeDailyLimit,
      maxActiveWatches: config.watch.freeLimit,
      pushAlerts: false,
      walletScansPerDay: 0,
      alertHistoryDays: config.watch.freeAlertHistoryDays,
    },
    trial: {
      analysesPerDay: config.analysis.trialDailyLimit,
      maxActiveWatches: config.watch.proLimit,
      pushAlerts: true,
      walletScansPerDay: config.wallet.dailyLimitTrial,
      alertHistoryDays: config.watch.proAlertHistoryDays,
    },
    subscription: {
      analysesPerDay: null,
      maxActiveWatches: config.watch.proLimit,
      pushAlerts: true,
      walletScansPerDay: config.wallet.dailyLimitPro,
      alertHistoryDays: config.watch.proAlertHistoryDays,
    },
  };
}

/** Essai actif ⇔ `ACTIVE` et échéance strictement future : les droits s'arrêtent à la seconde (le job peut être en retard). */
export function isTrialActive(row: Pick<PlanPolicyRow, 'trialStatus' | 'trialEndsAt'>, now: Date): boolean {
  return row.trialStatus === 'ACTIVE' && row.trialEndsAt !== null && row.trialEndsAt.getTime() > now.getTime();
}

/** Priorité : abonnement Pro > essai actif > Gratuit. */
export function resolvePlanPolicy(row: PlanPolicyRow, limits: PlanPolicyLimits, now: Date): PlanPolicy {
  const trialActive = isTrialActive(row, now);
  const source: PlanSource = row.plan === 'PRO' ? 'subscription' : trialActive ? 'trial' : 'free';
  return {
    effectivePlan: source === 'free' ? 'FREE' : 'PRO',
    paidPlan: row.plan,
    source,
    trialActive,
    emailVerified: row.emailVerifiedAt !== null && row.emailVerifiedAt !== undefined,
    entitlements: limits[source],
  };
}

const TRIAL_STATUS: Readonly<Record<TrialStatusRow, TrialStatus>> = {
  NONE: 'none',
  ACTIVE: 'active',
  ENDED: 'ended',
  INELIGIBLE: 'ineligible',
};

const DAY_MS = 86_400_000;

/** Statut exposé : un essai `ACTIVE` dont l'échéance est passée est déjà `ended` (job pas encore passé). */
export function trialStatusOf(row: Pick<PlanPolicyRow, 'trialStatus' | 'trialEndsAt'>, now: Date): TrialStatus {
  if (row.trialStatus === 'ACTIVE') return isTrialActive(row, now) ? 'active' : 'ended';
  return TRIAL_STATUS[row.trialStatus as TrialStatusRow] ?? 'none';
}

/**
 * État d'essai détaillé (contrat `TrialDetails`) : jours restants, écran de fin dû (dernières 24 h de
 * l'essai ou essai terminé, sans abonnement Pro, écran pas encore vu), message neutre d'inéligibilité.
 */
export function buildTrialDetails(row: TrialRow, now: Date): TrialDetails {
  const status = trialStatusOf(row, now);
  const active = status === 'active';
  const lastDay = active && row.trialEndsAt !== null && row.trialEndsAt.getTime() - now.getTime() <= DAY_MS;
  const endScreenDue = row.plan !== 'PRO' && row.trialEndScreenSeenAt === null && (lastDay || (status === 'ended' && row.trialStartedAt !== null));
  return {
    status,
    startedAt: row.trialStartedAt?.toISOString() ?? null,
    endsAt: row.trialEndsAt?.toISOString() ?? null,
    daysRemaining: active && row.trialEndsAt ? trialDaysRemaining(row.trialEndsAt, now) : null,
    endScreenDue,
    notice: status === 'ineligible' ? TRIAL_INELIGIBLE_NOTICE : null,
  };
}
