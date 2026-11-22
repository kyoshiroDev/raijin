import { isTrialActive, trialStatusOf } from '@raijin/api-core';
import type { User } from '@raijin/api-prisma';
import type { PublicUser } from '@raijin/shared-contracts';

/**
 * Profil public (contrat `PublicUser`) : jamais de hash, d'identifiant Stripe ni d'attribution.
 * Plan effectif et état d'essai calculés par la politique unique (`@raijin/api-core`, §13.4).
 */
export function toPublicUser(user: User, now: Date = new Date()): PublicUser {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    plan: user.plan === 'PRO' || isTrialActive(user, now) ? 'PRO' : 'FREE',
    role: user.role,
    trial: {
      status: trialStatusOf(user, now),
      startedAt: user.trialStartedAt?.toISOString() ?? null,
      endsAt: user.trialEndsAt?.toISOString() ?? null,
    },
    createdAt: user.createdAt.toISOString(),
  };
}
