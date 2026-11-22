import { testConfig } from '@raijin/api-core';
import type { Mailer } from '@raijin/api-notifications';
import { of } from 'rxjs';
import { MemoryAdminStore, cached } from '../common/admin-store';
import { addDays, rangeDays, resolveRange } from '../common/range';
import { countMailer, DailyCounters, RequestMetricsInterceptor, dailyCounterKey } from './daily-counters';
import { MetricsAggregateJob } from './metrics-aggregate.job';
import { MetricsCalculator, mrrCents } from './metrics-calculator';
import { MetricsReader } from './metrics-reader';

const NOW = new Date('2026-11-22T02:15:00.000Z');

describe('Périodes (jours UTC)', () => {
  it('7 jours se terminant aujourd’hui, précédente de même longueur', () => {
    expect(resolveRange({ period: '7d' }, NOW)).toEqual({
      period: '7d',
      current: { from: '2026-11-16', to: '2026-11-22' },
      previous: { from: '2026-11-09', to: '2026-11-15' },
      timezone: 'UTC',
    });
    expect(resolveRange({ period: 'today' }, NOW).previous).toEqual({ from: '2026-11-21', to: '2026-11-21' });
    expect(resolveRange({ period: '7d', from: '2026-10-01', to: '2026-10-31' }, NOW)).toMatchObject({
      period: 'custom',
      previous: { from: '2026-08-31', to: '2026-09-30' },
    });
    expect(rangeDays({ from: '2026-02-27', to: '2026-03-02' })).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('Compteurs techniques journaliers', () => {
  it('requêtes et 5xx comptés par l’intercepteur (statut final)', async () => {
    const store = new MemoryAdminStore();
    const counters = new DailyCounters(store);
    counters.now = () => NOW;
    const listeners: Record<string, () => void> = {};
    const response = { statusCode: 200, once: (event: string, fn: () => void) => (listeners[event] = fn) };
    const context = { getType: () => 'http', switchToHttp: () => ({ getResponse: () => response }) };
    const interceptor = new RequestMetricsInterceptor(counters);
    await new Promise((resolve) => interceptor.intercept(context as never, { handle: () => of(1) }).subscribe({ complete: () => resolve(null) }));
    response.statusCode = 503;
    listeners['finish']?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(await counters.read('2026-11-22')).toEqual({ api_requests: 1, api_errors_5xx: 1, emails_sent: 0, emails_failed: 0 });
    expect(dailyCounterKey('2026-11-22')).toBe('admin:counters:2026-11-22');
  });

  it('e-mails envoyés / en échec par décoration du Mailer (une seule fois), erreur relancée', async () => {
    const counters = new DailyCounters(new MemoryAdminStore());
    counters.now = () => NOW;
    const send = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('smtp'));
    const mailer = { send } as unknown as Mailer;
    countMailer(mailer, counters);
    countMailer(mailer, counters);
    await mailer.send({ to: 'a@b.fr', subject: 's', html: 'h', text: 't' });
    await expect(mailer.send({ to: 'a@b.fr', subject: 's', html: 'h', text: 't' })).rejects.toThrow('smtp');
    await new Promise((resolve) => setImmediate(resolve));
    expect(await counters.read('2026-11-22')).toMatchObject({ emails_sent: 1, emails_failed: 1 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('stockage indisponible : lecture nulle, jamais d’exception', async () => {
    const store = new MemoryAdminStore();
    store.readHashes = async () => {
      throw new Error('down');
    };
    expect(await new DailyCounters(store).read('2026-11-22')).toBeNull();
  });

  it('cache JSON : calcul une fois puis relu', async () => {
    const store = new MemoryAdminStore();
    const compute = jest.fn(async () => ({ a: 1 }));
    await cached(store, 'k', 60, compute);
    expect(await cached(store, 'k', 60, compute)).toEqual({ a: 1 });
    expect(compute).toHaveBeenCalledTimes(1);
  });
});

describe('MRR', () => {
  it('mensuels + annuels / 12 aux prix configurés', () => {
    expect(mrrCents(3, 2, { prices: { monthlyCents: 990, yearlyCents: 9900, monthlyId: null, yearlyId: null, currency: 'EUR' } })).toBe(3 * 990 + 1650);
  });
});

function jobKit(dailyMetricCount: number) {
  const executed: { sql: string; values: unknown[] }[] = [];
  const prisma = {
    dailyMetric: { count: jest.fn(async () => dailyMetricCount) },
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      executed.push({ sql: strings.join('?'), values });
      return 1;
    }),
  };
  const calculator = {
    retentionDays: 90,
    compute: jest.fn(async () => new Map<string, number>([['signups', 4], ['pas_au_catalogue', 9], ['checks.jupiter', 2]])),
  } as unknown as MetricsCalculator;
  const registry = { register: jest.fn() };
  const runs = { track: jest.fn(async (_name: string, task: () => Promise<unknown>) => task()) };
  const store = new MemoryAdminStore();
  const job = new MetricsAggregateJob(prisma as never, calculator, registry as never, runs as never, store, testConfig());
  return { job, prisma, calculator, registry, runs, store, executed };
}

describe('Job metrics-aggregate', () => {
  it('déclaré dans la file maintenance avec METRICS_CRON, déclenchable en test', () => {
    const kit = jobKit(1);
    kit.job.onModuleInit();
    expect(kit.registry.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'metrics-aggregate', queue: 'maintenance', scheduler: { pattern: '15 2 * * *', tz: 'UTC' }, manualRun: true }));
  });

  it('passage normal : J-3, J-2, J-1 recalculés, through = J-1 (lu par la purge)', async () => {
    const kit = jobKit(120);
    const result = await kit.job.run(NOW);
    expect(kit.calculator.compute).toHaveBeenCalledTimes(3);
    expect((kit.calculator.compute as jest.Mock).mock.calls.map((call) => call[0])).toEqual(['2026-11-19', '2026-11-20', '2026-11-21']);
    expect(result).toEqual({ through: '2026-11-21', days: 3, rows: 6, catchUp: false });
    expect(kit.runs.track).toHaveBeenCalledWith('metrics-aggregate', expect.any(Function));
  });

  it('premier passage (table vide) : rattrapage de tout l’historique conservé', async () => {
    const kit = jobKit(0);
    const result = await kit.job.run(NOW);
    expect(result).toMatchObject({ days: 90, catchUp: true, through: '2026-11-21' });
    expect((kit.calculator.compute as jest.Mock).mock.calls[0]?.[0]).toBe('2026-08-24');
  });

  it('upsert idempotent ; clé hors catalogue refusée ; aucune donnée personnelle possible', async () => {
    const kit = jobKit(1);
    expect(await kit.job.write('2026-11-21', new Map([['signups', 4], ['email:a@b.fr', 1]]))).toBe(1);
    expect(kit.executed[0]?.sql).toContain('ON CONFLICT ("date", "key") DO UPDATE');
    expect(JSON.stringify(kit.executed[0]?.values)).not.toContain('a@b.fr');
    expect(await kit.job.write('2026-11-21', new Map())).toBe(0);
  });

  it('verrou : un seul passage à la fois', async () => {
    const kit = jobKit(1);
    await kit.store.setIfAbsent('lock:metrics-aggregate', 'autre', 60);
    expect(await kit.job.run(NOW)).toEqual({ locked: true });
  });
});

describe('MetricsReader', () => {
  it('jours agrégés depuis DailyMetric, jours postérieurs calculés en direct (cache 60 s)', async () => {
    const prisma = {
      $queryRaw: jest.fn(async () => [{ through: '2026-11-20' }]),
      dailyMetric: {
        findMany: jest.fn(async () => [
          { date: new Date('2026-11-19T00:00:00Z'), key: 'signups', value: 3 },
          { date: new Date('2026-11-20T00:00:00Z'), key: 'signups', value: 5 },
        ]),
      },
    };
    const compute = jest.fn(async (day: string) => new Map([['signups', day === '2026-11-22' ? 2 : 7]]));
    const reader = new MetricsReader(prisma as never, { compute } as never, new MemoryAdminStore());
    const grid = await reader.grid(['signups'], [{ from: '2026-11-19', to: '2026-11-22' }], new Date('2026-11-22T10:00:00Z'));
    expect([...(grid.get('signups') ?? new Map())].sort()).toEqual([['2026-11-19', 3], ['2026-11-20', 5], ['2026-11-21', 7], ['2026-11-22', 2]]);
    await reader.grid(['signups'], [{ from: '2026-11-22', to: '2026-11-22' }], new Date('2026-11-22T10:00:30Z'));
    expect(compute).toHaveBeenCalledTimes(2);
    const series = reader.series('signups', { from: '2026-11-18', to: '2026-11-19' }, null, grid);
    expect(series).toEqual({ key: 'signups', unit: 'count', points: [{ date: '2026-11-18', value: null }, { date: '2026-11-19', value: 3 }] });
  });
});
