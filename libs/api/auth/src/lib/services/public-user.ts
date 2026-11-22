import type { User } from '@raijin/api-prisma';
import type { PublicUser, TrialStatus } from '@raijin/shared-contracts';

const TRIAL_STATUS: Readonly<Record<User['trialStatus'], TrialStatus>> = {
  NONE: 'none',
  ACTIVE: 'active',
  ENDED: 'ended',
  INELIGIBLE: 'ineligible',
};

/** Profil public (contrat `PublicUser`) : jamais de hash, d'identifiant Stripe ni d'attribution. */
export function toPublicUser(user: User, now: Date = new Date()): PublicUser {
  const trialActive = user.trialStatus === 'ACTIVE' && !!user.trialEndsAt && user.trialEndsAt > now;
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    plan: trialActive ? 'PRO' : user.plan,
    role: user.role,
    trial: {
      status: user.trialStatus === 'ACTIVE' && !trialActive ? 'ended' : TRIAL_STATUS[user.trialStatus],
      startedAt: user.trialStartedAt?.toISOString() ?? null,
      endsAt: user.trialEndsAt?.toISOString() ?? null,
    },
    createdAt: user.createdAt.toISOString(),
  };
}
