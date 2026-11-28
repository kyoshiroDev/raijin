import type { PrismaService } from '@raijin/api-prisma';
import { trialRecapSchema } from '@raijin/shared-contracts';
import { TrialRecapService } from './trial-recap.service';

const START = new Date('2026-11-23T08:00:00.000Z');
const END = new Date('2026-11-30T08:00:00.000Z');
const USER = '01968b3a-7c2e-7d4a-9f00-000000000001';

function setup(user: Record<string, unknown> | null) {
  const prisma = {
    user: { findUnique: jest.fn(async () => user) },
    productEvent: { count: jest.fn(async () => 12) },
    $queryRaw: jest.fn(async () => [{ count: 2 }]),
    alert: { count: jest.fn(async () => 3) },
    usageCounter: { aggregate: jest.fn(async () => ({ _sum: { count: 4 } })) },
    watch: { count: jest.fn(async (args: { where: { status: string } }) => (args.where.status === 'active' ? 3 : 2)) },
  };
  return { prisma, service: new TrialRecapService(prisma as unknown as PrismaService) };
}

describe('TrialRecapService', () => {
  it('fenêtre début → min(maintenant, fin) : analyses, tokens Danger distincts, alertes, scans, suivis', async () => {
    const { service, prisma } = setup({ trialStatus: 'ACTIVE', trialStartedAt: START, trialEndsAt: END });
    const now = new Date('2026-11-25T10:00:00.000Z');
    const recap = await service.recap(USER, now);
    expect(trialRecapSchema.parse(recap)).toEqual(recap);
    expect(recap).toEqual({
      status: 'active',
      startedAt: START.toISOString(),
      endsAt: END.toISOString(),
      analysesCount: 12,
      alertsCount: 3,
      dangerTokensCount: 2,
      walletScansCount: 4,
      activeWatches: 3,
      planLimitPausedWatches: 2,
    });
    expect(prisma.productEvent.count).toHaveBeenCalledWith({ where: { userId: USER, type: 'analysis_done', createdAt: { gte: START, lte: now } } });
    expect(prisma.usageCounter.aggregate).toHaveBeenCalledWith({
      where: { userId: USER, kind: 'wallet_scan', day: { gte: new Date('2026-11-23T00:00:00.000Z'), lte: new Date('2026-11-25T00:00:00.000Z') } },
      _sum: { count: true },
    });
  });

  it('essai terminé : fenêtre bornée à la fin, statut ended ; aucun scan : 0', async () => {
    const { service, prisma } = setup({ trialStatus: 'ACTIVE', trialStartedAt: START, trialEndsAt: END });
    prisma.usageCounter.aggregate.mockResolvedValueOnce({ _sum: { count: null } } as never);
    prisma.$queryRaw.mockResolvedValueOnce([]);
    const recap = await service.recap(USER, new Date('2026-12-05T00:00:00.000Z'));
    expect(recap).toMatchObject({ status: 'ended', walletScansCount: 0, dangerTokensCount: 0 });
    expect(prisma.alert.count).toHaveBeenCalledWith({ where: { userId: USER, createdAt: { gte: START, lte: END } } });
  });

  it('jamais d’essai (aucun, refusé) : 404 TRIAL_NOT_FOUND', async () => {
    await expect(setup({ trialStatus: 'INELIGIBLE', trialStartedAt: null, trialEndsAt: null }).service.recap(USER)).rejects.toMatchObject({ code: 'TRIAL_NOT_FOUND', status: 404 });
    await expect(setup(null).service.recap(USER)).rejects.toMatchObject({ code: 'TRIAL_NOT_FOUND' });
  });
});
