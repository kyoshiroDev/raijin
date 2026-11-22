/**
 * État de la session admin portée par la ligne `Session` (docs/ARCHITECTURE.md §14.3) : vérifiée par un code,
 * expirée après `sessionIdleMs` sans activité admin ou `sessionMaxMs` après la saisie du code.
 */
export interface AdminSessionColumns {
  readonly adminVerifiedAt: Date | null;
  readonly adminLastSeenAt: Date | null;
}

export interface AdminSessionTimeouts {
  readonly sessionIdleMs: number;
  readonly sessionMaxMs: number;
}

export type AdminSessionState = 'unverified' | 'expired' | 'active';

export function adminSessionState(session: AdminSessionColumns, timeouts: AdminSessionTimeouts, now: Date): AdminSessionState {
  if (!session.adminVerifiedAt) return 'unverified';
  const lastSeen = session.adminLastSeenAt ?? session.adminVerifiedAt;
  if (now.getTime() - lastSeen.getTime() > timeouts.sessionIdleMs) return 'expired';
  if (now.getTime() - session.adminVerifiedAt.getTime() > timeouts.sessionMaxMs) return 'expired';
  return 'active';
}

/** Échéances affichées par le front (`AdminSecurityStatus`) ; `null` si la session n'est pas active. */
export function adminSessionDeadlines(
  session: AdminSessionColumns,
  timeouts: AdminSessionTimeouts,
  now: Date,
): { idleExpiresAt: Date | null; absoluteExpiresAt: Date | null } {
  if (adminSessionState(session, timeouts, now) !== 'active' || !session.adminVerifiedAt) {
    return { idleExpiresAt: null, absoluteExpiresAt: null };
  }
  const lastSeen = session.adminLastSeenAt ?? session.adminVerifiedAt;
  const absolute = session.adminVerifiedAt.getTime() + timeouts.sessionMaxMs;
  return {
    idleExpiresAt: new Date(Math.min(lastSeen.getTime() + timeouts.sessionIdleMs, absolute)),
    absoluteExpiresAt: new Date(absolute),
  };
}

/** Écriture de « dernière activité » au plus une fois par minute. */
export const ADMIN_LAST_SEEN_THROTTLE_MS = 60_000;
