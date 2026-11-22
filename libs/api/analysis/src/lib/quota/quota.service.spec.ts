import { testConfig } from '@raijin/api-core';
import type { PrismaService } from '@raijin/api-prisma';
import { quotaInfoSchema } from '@raijin/shared-contracts';
import type { AnalysisClock } from '../ports/facts-collector';
import { KeyValueStore, MemoryKeyValueStore } from '../store/key-value-store';
import { hashIp, ipBucket } from './ip-hash';
import { QuotaService, type QuotaPolicy } from './quota.service';

const NOW = new Date('2026-11-22T23:30:00.000Z');
const clock: AnalysisClock = { now: () => NOW };
const MINT = '8hVdV1j7khEZ1FukoH65EvpwuMZPszv1ikjNSbEnGypt';
const USER_ID = '0193b2a4-5a4e-7c3d-9f00-000000000001';

/** Texte SQL d'un appel `$queryRaw` / `$executeRaw` (gabarit + valeurs, Prisma.sql imbriqués compris). */
function sqlOf(call: unknown[]): { text: string; values: unknown[] } {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  const flat: unknown[] = [];
  for (const value of values) {
    const nested = value as { strings?: string[]; values?: unknown[] } | null;
    if (nested && Array.isArray(nested.strings) && Array.isArray(nested.values)) flat.push(...nested.values);
    else flat.push(value);
  }
  return { text: strings.join('?'), values: flat };
}

function fakePrisma() {
  return {
    user: { findUnique: jest.fn() },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(async () => 1),
  };
}

function setup(store: KeyValueStore = new MemoryKeyValueStore(), env: Record<string, string> = {}) {
  const prisma = fakePrisma();
  const service = new QuotaService(prisma as unknown as PrismaService, store, clock, testConfig(env));
  return { service, prisma, store };
}

describe('empreinte d’IP', () => {
  it('HMAC tronqué, jamais l’IP en clair, stable pour une même IP', () => {
    const hash = hashIp('s'.repeat(48), '203.0.113.7');
    expect(hash).toHaveLength(32);
    expect(hash).not.toContain('203');
    expect(hashIp('s'.repeat(48), '203.0.113.7')).toBe(hash);
    expect(hashIp('t'.repeat(48), '203.0.113.7')).not.toBe(hash);
  });

  it('IPv6 regroupée par /64, IPv4 mappée ramenée à l’IPv4', () => {
    expect(ipBucket('2001:db8:abcd:12:1::1')).toBe('2001:db8:abcd:12::/64');
    expect(ipBucket('2001:0db8:abcd:0012:ffff:ffff:ffff:ffff')).toBe('2001:db8:abcd:12::/64');
    expect(ipBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipBucket('::ffff:198.51.100.4')).toBe('198.51.100.4');
    expect(ipBucket('198.51.100.4')).toBe('198.51.100.4');
    expect(ipBucket(null)).toBe('unknown');
    expect(hashIp('s'.repeat(48), '2001:db8:abcd:12::1')).toBe(hashIp('s'.repeat(48), '2001:db8:abcd:12::2'));
  });
});

describe('QuotaService : politique', () => {
  it('anonyme : 3 par jour par défaut, empreinte d’IP', async () => {
    const { service } = setup();
    const policy = await service.resolvePolicy({ kind: 'anonymous', ip: '203.0.113.7' });
    expect(policy).toMatchObject({ subject: 'anonymous', userId: null, plan: null, limit: 3 });
    expect(policy.ipHash).toHaveLength(32);
  });

  it('Gratuit 5, essai actif 50, essai expiré 5, Pro illimité (relus en base)', async () => {
    const { service, prisma } = setup();
    const actor = { kind: 'user', userId: USER_ID } as const;
    prisma.user.findUnique.mockResolvedValueOnce({ plan: 'FREE', trialStatus: 'NONE', trialEndsAt: null });
    expect((await service.resolvePolicy(actor)).limit).toBe(5);
    prisma.user.findUnique.mockResolvedValueOnce({ plan: 'FREE', trialStatus: 'ACTIVE', trialEndsAt: new Date(NOW.getTime() + 1000) });
    expect((await service.resolvePolicy(actor)).limit).toBe(50);
    prisma.user.findUnique.mockResolvedValueOnce({ plan: 'FREE', trialStatus: 'ACTIVE', trialEndsAt: new Date(NOW.getTime() - 1000) });
    expect((await service.resolvePolicy(actor)).limit).toBe(5);
    prisma.user.findUnique.mockResolvedValueOnce({ plan: 'PRO', trialStatus: 'ENDED', trialEndsAt: null });
    expect(await service.resolvePolicy(actor)).toMatchObject({ plan: 'PRO', limit: null, subject: 'user' });
  });

  it('limites configurables', async () => {
    const { service } = setup(new MemoryKeyValueStore(), { ANON_ANALYSIS_DAILY_LIMIT: '7' });
    expect((await service.resolvePolicy({ kind: 'anonymous', ip: null })).limit).toBe(7);
  });

  it('compte supprimé entre-temps : session expirée', async () => {
    const { service, prisma } = setup();
    prisma.user.findUnique.mockResolvedValueOnce(null);
    await expect(service.resolvePolicy({ kind: 'user', userId: USER_ID })).rejects.toMatchObject({ code: 'AUTH_SESSION_EXPIRED' });
  });
});

describe('QuotaService : réservation et remboursement', () => {
  const anonymous: QuotaPolicy = { kind: 'analysis', subject: 'anonymous', userId: null, ipHash: 'empreinte', plan: null, limit: 3 };
  const user: QuotaPolicy = { kind: 'analysis', subject: 'user', userId: USER_ID, ipHash: null, plan: 'FREE', limit: 5 };

  it('réserve atomiquement sous la limite (INSERT … ON CONFLICT … WHERE count < limit), jour UTC', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 2 }]);
    const reservation = await service.reserve(anonymous, MINT);
    expect(reservation).toMatchObject({ counted: true, used: 2, day: '2026-11-22' });
    const { text, values } = sqlOf(prisma.$queryRaw.mock.calls[0]);
    expect(text).toMatch(/ON CONFLICT \("ipHash", "kind", "day"\)/);
    expect(text).toMatch(/WHERE "UsageCounter"\."count" < \?/);
    expect(values).toEqual(expect.arrayContaining(['empreinte', 'analysis', '2026-11-22', 3]));
  });

  it('utilisateur : conflit sur (userId, kind, day)', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 1 }]);
    await service.reserve(user, MINT);
    const { text, values } = sqlOf(prisma.$queryRaw.mock.calls[0]);
    expect(text).toMatch(/ON CONFLICT \("userId", "kind", "day"\)/);
    expect(values).toEqual(expect.arrayContaining([USER_ID, 5]));
  });

  it('limite atteinte : 429 QUOTA_EXCEEDED, marque anti-double-comptage retirée', async () => {
    const { service, prisma, store } = setup();
    prisma.$queryRaw.mockResolvedValueOnce([]);
    await expect(service.reserve(anonymous, MINT)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', status: 429 });
    await expect(store.get(`quota:seen:analysis:a:empreinte:${MINT}`)).resolves.toBeNull();
  });

  it('même sujet + même mint dans les 10 min : pas recompté', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 1 }]).mockResolvedValueOnce([{ count: 1 }]);
    await service.reserve(anonymous, MINT);
    const again = await service.reserve(anonymous, MINT);
    expect(again).toMatchObject({ counted: false, used: 1 });
    // Deuxième appel SQL = lecture du compteur, pas un incrément.
    expect(sqlOf(prisma.$queryRaw.mock.calls[1]).text).toMatch(/^\s*SELECT "count"/);
    await service.refund(again);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('remboursement : décrémente (jamais sous 0) et retire la marque', async () => {
    const { service, prisma, store } = setup();
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 1 }]);
    const reservation = await service.reserve(user, MINT);
    await service.refund(reservation);
    const { text, values } = sqlOf(prisma.$executeRaw.mock.calls[0] as unknown[]);
    expect(text).toMatch(/SET "count" = "count" - 1/);
    expect(text).toMatch(/"count" > 0/);
    expect(values).toEqual(expect.arrayContaining([USER_ID, 'analysis', '2026-11-22']));
    await expect(store.get(`quota:seen:analysis:u:${USER_ID}:${MINT}`)).resolves.toBeNull();
  });

  it('remboursement en échec : journalisé, jamais levé', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 1 }]);
    const reservation = await service.reserve(user, MINT);
    prisma.$executeRaw.mockRejectedValueOnce(new Error('base indisponible'));
    await expect(service.refund(reservation)).resolves.toBeUndefined();
  });

  it('Redis indisponible : compté en base à chaque fois (jamais gratuit)', async () => {
    const store = new MemoryKeyValueStore();
    jest.spyOn(store, 'setIfAbsent').mockResolvedValue(null);
    const { service, prisma } = setup(store);
    prisma.$queryRaw.mockResolvedValue([{ count: 1 }]);
    expect((await service.reserve(anonymous, MINT)).counted).toBe(true);
    expect((await service.reserve(anonymous, MINT)).counted).toBe(true);
  });

  it('Pro : compté sans limite, restant illimité', async () => {
    const { service, prisma } = setup();
    const pro: QuotaPolicy = { ...user, plan: 'PRO', limit: null };
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 120 }]);
    const reservation = await service.reserve(pro, MINT);
    expect(sqlOf(prisma.$queryRaw.mock.calls[0]).values).toContain(2_147_483_647);
    const info = await service.info(pro, reservation.used);
    expect(info).toMatchObject({ limit: null, remaining: null, used: 120, plan: 'PRO' });
  });

  it('info : restant, remise à zéro à minuit UTC, conforme au contrat', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 2 }]);
    const info = await service.info(anonymous);
    expect(quotaInfoSchema.parse(info)).toEqual({
      kind: 'analysis',
      subject: 'anonymous',
      plan: null,
      limit: 3,
      used: 2,
      remaining: 1,
      resetsAt: '2026-11-23T00:00:00.000Z',
    });
    prisma.$queryRaw.mockResolvedValueOnce([]);
    expect((await service.info(anonymous)).remaining).toBe(3);
  });
});
