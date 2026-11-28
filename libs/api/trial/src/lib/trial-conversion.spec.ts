import { testConfig } from '@raijin/api-core';
import type { PrismaService } from '@raijin/api-prisma';
import { trialConversionReportSchema } from '@raijin/shared-contracts';
import { conversionRate, TrialConversionService, weekStartUtc } from './trial-conversion.service';

describe('TrialConversionService', () => {
  it('lundi UTC de la semaine ; taux = convertis / (convertis + expirés)', () => {
    expect(weekStartUtc(new Date('2026-11-22T23:00:00Z'))).toBe('2026-11-16');
    expect(weekStartUtc(new Date('2026-11-23T00:00:00Z'))).toBe('2026-11-23');
    expect(conversionRate(1, 3)).toBe(0.25);
    expect(conversionRate(0, 0)).toBeNull();
  });

  it('cohortes hebdomadaires, totaux, refus par motif (motifs inconnus ignorés)', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([
        { week: '2026-11-16', started: 4, active: 1, converted: 1, expired: 2 },
        { week: '2026-11-09', started: 2, active: 0, converted: 0, expired: 2 },
      ])
      .mockResolvedValueOnce([
        { reason: 'disposable_domain', count: 3 },
        { reason: 'fingerprint_seen', count: 1 },
        { reason: 'autre', count: 9 },
      ]);
    const service = new TrialConversionService({ $queryRaw: queryRaw } as unknown as PrismaService, testConfig());
    const report = await service.report(new Date('2026-11-22T10:00:00.000Z'));
    expect(trialConversionReportSchema.parse(report)).toEqual(report);
    expect(report.totals).toEqual({ started: 6, active: 1, converted: 1, expired: 4, conversionRate: 0.2 });
    expect(report.cohorts[0]).toEqual({ weekStart: '2026-11-16', started: 4, active: 1, converted: 1, expired: 2, conversionRate: 1 / 3 });
    expect(report.cohorts[1]?.conversionRate).toBe(0);
    expect(report.refusals).toEqual({ email_already_used: 0, disposable_domain: 3, fingerprint_seen: 1 });
    expect(report.generatedAt).toBe('2026-11-22T10:00:00.000Z');
  });

  it('aucun essai : totaux à zéro, taux nul', async () => {
    const service = new TrialConversionService({ $queryRaw: jest.fn(async () => []) } as unknown as PrismaService, testConfig());
    const report = await service.report();
    expect(report).toMatchObject({ totals: { started: 0, conversionRate: null }, cohorts: [] });
  });
});
