import { testConfig } from '@raijin/api-core';
import type { PrismaService } from '@raijin/api-prisma';
import type { AlertMailService } from '@raijin/api-notifications';
import { MemoryPrisma } from '../../testing/memory-prisma';
import { WeeklyDigestService } from '../digest/weekly-digest.service';
import { JobRunService } from '../jobs/job-run.service';
import { PURGE_BATCH, PurgeService } from './purge.service';

const NOW = new Date('2026-11-22T03:30:00.000Z');
const clock = { now: () => NOW };

describe('PurgeService', () => {
  it('règles §11.9 : tables et seuils (90 j, JobRun 30 j, sessions, jetons, états sans suivi)', () => {
    const purge = new PurgeService({} as PrismaService, {} as JobRunService, clock, testConfig());
    const rules = purge.rules(NOW);
    expect(rules.map((rule) => rule.name)).toEqual([
      'tokenAnalysis',
      'productEvent',
      'usageCounter',
      'trialFingerprint',
      'trialClaim',
      'alert',
      'watchEvent',
      'auditLog',
      'jobRun',
      'session',
      'authToken',
      'mintWatchState',
    ]);
    const values = (name: string) => rules.find((rule) => rule.name === name)?.where.values ?? [];
    expect(values('alert')).toEqual([new Date(NOW.getTime() - 90 * 86_400_000)]);
    expect(values('jobRun')).toEqual([new Date(NOW.getTime() - 30 * 86_400_000)]);
    // Journal d'audit : AUDIT_LOG_RETENTION_DAYS (365 j par défaut, m1 de l'audit phase 6 bis).
    expect(values('auditLog')).toEqual([new Date(NOW.getTime() - 365 * 86_400_000)]);
    const custom = new PurgeService({} as PrismaService, {} as JobRunService, clock, testConfig({ AUDIT_LOG_RETENTION_DAYS: '30' }));
    expect(custom.rules(NOW).find((rule) => rule.name === 'auditLog')?.where.values).toEqual([new Date(NOW.getTime() - 30 * 86_400_000)]);
    expect(values('trialFingerprint')).toEqual([new Date(NOW.getTime() - 90 * 86_400_000)]);
    expect(values('trialClaim')).toEqual([new Date(NOW.getTime() - 730 * 86_400_000)]);
    expect(values('usageCounter')).toEqual(['2026-08-24']);
    expect(values('session')).toEqual([new Date(NOW.getTime() - 86_400_000), new Date(NOW.getTime() - 7 * 86_400_000)]);
    expect(rules.find((rule) => rule.name === 'mintWatchState')?.where.sql).toContain('NOT EXISTS');
    expect(rules.find((rule) => rule.name === 'jobRun')?.where.sql).toContain("<> 'RUNNING'");
  });

  it('suppression par lots de 5 000 jusqu’à épuisement, compteurs journalisés dans JobRun', async () => {
    const prisma = new MemoryPrisma();
    const batches = [PURGE_BATCH, 12];
    const table = (values: unknown[]) => String((values[0] as { sql?: string } | undefined)?.sql ?? '');
    prisma.rawHandler = (_sql, values) => (table(values) === '"Alert"' ? (batches.shift() ?? 0) : 0);
    const runs = new JobRunService(prisma as unknown as PrismaService);
    const purge = new PurgeService(prisma as unknown as PrismaService, runs, clock, testConfig());
    const counts = await purge.run();
    expect(counts['alert']).toBe(PURGE_BATCH + 12);
    expect(counts['session']).toBe(0);
    // Aucun passage des agrégats : TokenAnalysis et ProductEvent ne sont pas purgés (10 règles, 2 lots pour Alert).
    expect(prisma.rawQueries.filter((sql) => sql.includes('DELETE FROM'))).toHaveLength(11);
    expect(counts['tokenAnalysis']).toBeUndefined();
    expect(counts['skippedUnaggregated']).toBe(1);
    expect(prisma.rawQueries.every((sql) => !sql.includes('DROP') && !sql.includes('TRUNCATE'))).toBe(true);
    const run = prisma.tables['jobRun']?.[0];
    expect(run).toMatchObject({ job: 'purge', status: 'SUCCESS', details: expect.objectContaining({ alert: PURGE_BATCH + 12 }) });
    expect(run?.['durationMs']).toEqual(expect.any(Number));
  });

  it('m6 : événements purgés seulement jusqu’au dernier jour agrégé par metrics-aggregate', async () => {
    const purge = new PurgeService({} as PrismaService, {} as JobRunService, clock, testConfig());
    const cutoff = (through: string | null | undefined) => purge.rules(NOW, through).find((rule) => rule.name === 'tokenAnalysis')?.where.values[0];
    const retention = new Date(NOW.getTime() - 90 * 86_400_000);
    expect(cutoff(undefined)).toEqual(retention);
    expect(cutoff('2026-11-21')).toEqual(retention);
    expect(cutoff('2026-08-01')).toEqual(new Date('2026-08-02T00:00:00.000Z'));
    expect(cutoff(null)).toBeUndefined();
    expect(purge.rules(NOW, null).map((rule) => rule.name)).not.toContain('productEvent');
  });

  it('m6 : jour agrégé lu dans le dernier JobRun metrics-aggregate réussi ; tout agrégé = rien de sauté', async () => {
    const prisma = new MemoryPrisma();
    prisma.rawHandler = (sql) => (sql.includes('"through"') ? [{ through: '2026-11-21' }] : 0);
    const purge = new PurgeService(prisma as unknown as PrismaService, new JobRunService(prisma as unknown as PrismaService), clock, testConfig());
    const counts = await purge.run();
    expect(counts).toMatchObject({ tokenAnalysis: 0, productEvent: 0, skippedUnaggregated: 0 });
    expect(prisma.rawQueries.find((sql) => sql.includes('"through"'))).toContain("'SUCCESS'");
    prisma.rawHandler = (sql) => (sql.includes('"through"') ? [{ through: 'pas-une-date' }] : 0);
    expect(await purge.aggregatedThrough()).toBeNull();
  });

  it('échec : JobRun FAILED avec le code seulement, erreur propagée (reprise BullMQ)', async () => {
    const prisma = new MemoryPrisma();
    prisma.rawHandler = () => {
      throw Object.assign(new Error('connexion postgres://secret@hote'), { code: 'ECONNRESET' });
    };
    const purge = new PurgeService(prisma as unknown as PrismaService, new JobRunService(prisma as unknown as PrismaService), clock, testConfig());
    await expect(purge.run()).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(prisma.tables['jobRun']?.[0]).toMatchObject({ status: 'FAILED', error: 'ECONNRESET' });
    expect(JSON.stringify(prisma.tables['jobRun'])).not.toContain('secret');
  });
});

describe('WeeklyDigestService', () => {
  function setup(sentAt: Date | null) {
    const prisma = new MemoryPrisma();
    prisma.tables['user']?.push({ id: 'u1', email: 'a@exemple.fr', notifyWeeklyDigest: true, emailVerifiedAt: NOW, weeklyDigestSentAt: sentAt });
    prisma.tables['watch']?.push({ id: 'w1', userId: 'u1', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', status: 'active', lastVerdict: 'safe', createdAt: NOW });
    prisma.tables['alert']?.push({ id: 'a1', userId: 'u1', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', createdAt: NOW });
    const mail = { sendWeeklyDigest: jest.fn(async () => undefined) };
    const digest = new WeeklyDigestService(prisma as unknown as PrismaService, mail as unknown as AlertMailService, new JobRunService(prisma as unknown as PrismaService), clock);
    return { prisma, mail, digest };
  }

  it('un résumé par semaine au plus (rejouer le job ne renvoie rien)', async () => {
    const t = setup(null);
    expect(await t.digest.run()).toEqual({ sent: 1, failed: 0 });
    expect(t.mail.sendWeeklyDigest).toHaveBeenCalledWith('a@exemple.fr', [
      { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', token: null, lastVerdict: 'safe', alertsThisWeek: 1 },
    ]);
    expect(await t.digest.run()).toEqual({ sent: 0, failed: 0 });
  });

  it('échec d’envoi : réservation relâchée (repris au prochain passage)', async () => {
    const t = setup(null);
    t.mail.sendWeeklyDigest.mockRejectedValueOnce(new Error('smtp'));
    expect(await t.digest.run()).toEqual({ sent: 0, failed: 1 });
    expect(t.prisma.tables['user']?.[0]?.['weeklyDigestSentAt']).toBeNull();
  });
});
