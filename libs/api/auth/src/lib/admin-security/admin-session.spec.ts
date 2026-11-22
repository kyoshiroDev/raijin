import { adminSessionDeadlines, adminSessionState } from './admin-session';

const timeouts = { sessionIdleMs: 30 * 60_000, sessionMaxMs: 8 * 3_600_000 };
const t0 = new Date('2026-11-22T10:00:00Z');
const plus = (ms: number) => new Date(t0.getTime() + ms);

describe('session admin (30 min d’inactivité, 8 h max)', () => {
  it('non vérifiée', () => {
    expect(adminSessionState({ adminVerifiedAt: null, adminLastSeenAt: null }, timeouts, t0)).toBe('unverified');
    expect(adminSessionDeadlines({ adminVerifiedAt: null, adminLastSeenAt: null }, timeouts, t0)).toEqual({ idleExpiresAt: null, absoluteExpiresAt: null });
  });

  it('active jusqu’à 30 min sans activité, expirée au-delà', () => {
    const session = { adminVerifiedAt: t0, adminLastSeenAt: t0 };
    expect(adminSessionState(session, timeouts, plus(30 * 60_000))).toBe('active');
    expect(adminSessionState(session, timeouts, plus(30 * 60_000 + 1))).toBe('expired');
    expect(adminSessionState({ adminVerifiedAt: t0, adminLastSeenAt: null }, timeouts, plus(31 * 60_000))).toBe('expired');
  });

  it('durée maximale de 8 h même avec de l’activité', () => {
    const session = { adminVerifiedAt: t0, adminLastSeenAt: plus(8 * 3_600_000) };
    expect(adminSessionState(session, timeouts, plus(8 * 3_600_000))).toBe('active');
    expect(adminSessionState(session, timeouts, plus(8 * 3_600_000 + 1))).toBe('expired');
  });

  it('échéances : inactivité bornée par la fin absolue', () => {
    const early = adminSessionDeadlines({ adminVerifiedAt: t0, adminLastSeenAt: plus(60_000) }, timeouts, plus(120_000));
    expect(early.idleExpiresAt?.toISOString()).toBe(plus(31 * 60_000).toISOString());
    expect(early.absoluteExpiresAt?.toISOString()).toBe(plus(8 * 3_600_000).toISOString());
    const late = adminSessionDeadlines({ adminVerifiedAt: t0, adminLastSeenAt: plus(8 * 3_600_000 - 60_000) }, timeouts, plus(8 * 3_600_000 - 30_000));
    expect(late.idleExpiresAt?.toISOString()).toBe(plus(8 * 3_600_000).toISOString());
    expect(adminSessionDeadlines({ adminVerifiedAt: t0, adminLastSeenAt: t0 }, timeouts, plus(40 * 60_000)).idleExpiresAt).toBeNull();
  });
});
