import { randomUUID } from 'node:crypto';
import { testConfig } from '@raijin/api-core';
import type { MailMessage } from '@raijin/api-notifications';
import { MemoryAdminStore } from '../common/admin-store';
import { jobState, type JobRunRow } from '../health/job-health';
import { AdminAlertsJob, adminPushPayload, alertLabel, jobAlertKey, quotaAlertKey } from './admin-alerts.job';

const NOW = new Date('2026-11-22T06:00:00.000Z');

interface AlertRow {
  id: string;
  kind: string;
  subject: string;
  level: string;
  dedupeKey: string;
  details: Record<string, unknown>;
  createdAt: Date;
  notifiedAt: Date | null;
  resolvedAt: Date | null;
}

/** Table `AdminAlert` en mémoire (contrainte d'unicité sur `dedupeKey`). */
function fakePrisma(admins: { id: string; email: string; pushSubscriptions: { endpoint: string; p256dh: string; auth: string }[] }[]) {
  const alerts: AlertRow[] = [];
  const matches = (row: AlertRow, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, condition]) => {
      if (key === 'NOT') return !(condition as { dedupeKey: { endsWith: string } }).dedupeKey || !row.dedupeKey.endsWith((condition as { dedupeKey: { endsWith: string } }).dedupeKey.endsWith);
      if (key === 'createdAt') return row.createdAt < (condition as { lt: Date }).lt;
      if (key === 'id') return (condition as { in: string[] }).in.includes(row.id);
      return (row as unknown as Record<string, unknown>)[key] === condition;
    });
  return {
    alerts,
    adminAlert: {
      createMany: jest.fn(async ({ data }: { data: Omit<AlertRow, 'id' | 'createdAt' | 'notifiedAt' | 'resolvedAt'>[] }) => {
        let count = 0;
        for (const row of data) {
          if (alerts.some((existing) => existing.dedupeKey === row.dedupeKey)) continue;
          alerts.push({ ...row, id: randomUUID(), createdAt: NOW, notifiedAt: null, resolvedAt: null });
          count += 1;
        }
        return { count };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<AlertRow> }) => {
        const rows = alerts.filter((row) => matches(row, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      }),
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => alerts.filter((row) => matches(row, where))),
    },
    user: { findMany: jest.fn(async () => admins) },
  };
}

const failing = (job: string, n: number): JobRunRow[] =>
  Array.from({ length: n }, (_, index) => ({ id: `${job}-f${index}`, job, status: 'FAILED' as const, startedAt: new Date(NOW.getTime() - (index + 1) * 600_000), durationMs: 10, error: 'ECONNRESET' }));

function kit(options: { states: ReturnType<typeof jobState>[]; quotas?: unknown[]; admins?: Parameters<typeof fakePrisma>[0]; mailFails?: boolean }) {
  const admins = options.admins ?? [{ id: 'a1', email: 'admin@raijin.test', pushSubscriptions: [{ endpoint: 'https://fcm.googleapis.com/x', p256dh: 'p', auth: 'a' }] }];
  const prisma = fakePrisma(admins);
  const sent: MailMessage[] = [];
  const mailer = {
    send: jest.fn(async (message: MailMessage) => {
      if (options.mailFails) throw new Error('smtp');
      sent.push(message);
    }),
  };
  const push = { configured: true, publicKey: null, send: jest.fn(async () => ({ status: options.mailFails ? 'failed' : 'sent', code: 'X' })) };
  const job = new AdminAlertsJob(
    prisma as never,
    { states: async () => options.states } as never,
    { quotas: async () => options.quotas ?? [] } as never,
    { register: jest.fn() } as never,
    { track: async (_name: string, task: () => Promise<unknown>) => task() } as never,
    new MemoryAdminStore(),
    mailer as never,
    push as never,
    testConfig(),
  );
  return { job, prisma, sent, mailer, push };
}

describe('Alertes admin', () => {
  it('job en échec 3 fois de suite : une alerte, e-mail + push à l’admin, une seule fois', async () => {
    const t = kit({ states: [jobState('purge', failing('purge', 3)), jobState('trial-tick', failing('trial-tick', 2))] });
    expect(await t.job.run(NOW)).toEqual({ opened: 1, resolved: 0, notified: 1, failed: 0 });
    expect(t.prisma.alerts[0]).toMatchObject({ kind: 'job_failing', subject: 'purge', level: 'critical', dedupeKey: jobAlertKey('purge', 'purge-f2') });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.text).toContain('Purge quotidienne : 3 échecs de suite, dernier code : ECONNRESET.');
    expect(t.sent[0]?.html).not.toMatch(/https?:\/\/(?!localhost)[^"]*api/i);
    expect(t.push.send).toHaveBeenCalledTimes(1);
    // Passage suivant : même incident → rien de nouveau.
    expect(await t.job.run(NOW)).toEqual({ opened: 0, resolved: 0, notified: 0, failed: 0 });
    expect(t.sent).toHaveLength(1);
  });

  it('succès après l’alerte : alerte résolue', async () => {
    const t = kit({ states: [jobState('purge', failing('purge', 3))] });
    await t.job.run(NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const recovered = jobState('purge', [{ id: 'ok', job: 'purge', status: 'SUCCESS', startedAt: later, durationMs: 5, error: null }, ...failing('purge', 3)]);
    const t2 = kit({ states: [recovered] });
    t2.prisma.alerts.push(...t.prisma.alerts);
    expect(((await t2.job.run(later)) as { resolved: number }).resolved).toBe(1);
    expect(t2.prisma.alerts[0]?.resolvedAt).toEqual(later);
  });

  it('quota ≥ 80 % : une alerte par service et par jour, résolue le jour suivant', async () => {
    const quotas = [
      { service: 'helius', period: 'day', used: 850_000, limit: 1_000_000, ratio: 0.85, level: 'warning' },
      { service: 'jupiter', period: 'day', used: 10, limit: null, ratio: null, level: 'ok' },
    ];
    const t = kit({ states: [], quotas });
    expect(((await t.job.run(NOW)) as { opened: number }).opened).toBe(1);
    expect(t.prisma.alerts[0]).toMatchObject({ dedupeKey: quotaAlertKey('helius', '2026-11-22'), level: 'warning', details: { used: 850_000, limit: 1_000_000, ratio: 0.85 } });
    expect(t.sent[0]?.text).toContain('85 %');
    const tomorrow = new Date('2026-11-23T00:10:00Z');
    const t2 = kit({ states: [] });
    t2.prisma.alerts.push(...t.prisma.alerts);
    expect(((await t2.job.run(tomorrow)) as { resolved: number }).resolved).toBe(1);
  });

  it('envoi impossible : notifiedAt reste vide, nouvel essai au passage suivant', async () => {
    const t = kit({ states: [jobState('purge', failing('purge', 3))], mailFails: true });
    expect(await t.job.run(NOW)).toMatchObject({ opened: 1, notified: 0, failed: 1 });
    expect(t.prisma.alerts[0]?.notifiedAt).toBeNull();
  });

  it('aucun compte ADMIN : rien n’est marqué notifié', async () => {
    const t = kit({ states: [jobState('purge', failing('purge', 3))], admins: [] });
    expect(((await t.job.run(NOW)) as { failed: number }).failed).toBe(1);
  });

  it('push : enveloppe du service worker, clic vers la santé, aucune donnée utilisateur', () => {
    const payload = adminPushPayload([{ id: randomUUID(), kind: 'quota_threshold', subject: 'helius', level: 'warning', details: {}, createdAt: NOW.toISOString(), notifiedAt: null, resolvedAt: null }], NOW);
    expect(payload.notification.title.length).toBeLessThanOrEqual(80);
    expect(payload.notification.body).toContain('Helius (crédits, total)');
    expect(payload.notification.data.onActionClick.default.url).toBe('/admin/sante');
    expect(alertLabel({ kind: 'job_failing', subject: 'job-inconnu' })).toBe('job-inconnu');
  });
});
