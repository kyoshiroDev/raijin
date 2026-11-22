import { testConfig } from '@raijin/api-core';
import { adminHealthSchema } from '@raijin/shared-contracts';
import { HealthService, last24h, snakeCase, toAdminAlert } from './health.service';
import { jobState, type JobRunRow } from './job-health';
import { quotasWithBudgets } from './quotas';

const NOW = new Date('2026-11-22T06:00:00.000Z');

const run = (id: string, status: JobRunRow['status'], minutesAgo: number, error: string | null = null): JobRunRow => ({
  id,
  job: 'purge',
  status,
  startedAt: new Date(NOW.getTime() - minutesAgo * 60_000),
  durationMs: 120,
  error,
});

describe('État des jobs', () => {
  it('série d’échecs depuis le dernier succès, premier échec (déduplication), code seulement', () => {
    const state = jobState('purge', [run('r4', 'RUNNING', 1), run('r3', 'FAILED', 10, 'ECONNRESET'), run('r2', 'FAILED', 20, 'P1001'), run('r1', 'SUCCESS', 30)]);
    expect(state).toMatchObject({ consecutiveFailures: 2, firstFailureId: 'r2', lastStatus: 'running', lastErrorCode: 'ECONNRESET', lastDurationMs: 120 });
    expect(state.lastSuccessAt?.toISOString()).toBe(new Date(NOW.getTime() - 30 * 60_000).toISOString());
  });

  it('aucune exécution : tout à null ; code d’erreur douteux remplacé', () => {
    expect(jobState('purge', [])).toMatchObject({ lastRunAt: null, lastStatus: null, consecutiveFailures: 0, firstFailureId: null });
    expect(jobState('purge', [run('r1', 'FAILED', 1, 'message avec espaces https://x')]).lastErrorCode).toBe('UNKNOWN');
  });
});

describe('Quotas', () => {
  it('plafonds Jupiter / RugCheck de la configuration, niveau au seuil (80 %)', () => {
    const quotas = quotasWithBudgets(
      {
        quotas: [
          { service: 'helius', period: 'day', used: 85, limit: 100, ratio: 0.85, level: 'warning' },
          { service: 'jupiter', period: 'day', used: 900, limit: null, ratio: null, level: 'ok' },
          { service: 'rugcheck', period: 'day', used: 10, limit: null, ratio: null, level: 'ok' },
        ],
      },
      { jupiterDailyCallBudget: 1000, rugcheckDailyCallBudget: null },
      0.8,
    );
    expect(quotas[1]).toMatchObject({ service: 'jupiter', limit: 1000, ratio: 0.9, level: 'warning' });
    expect(quotas[2]).toMatchObject({ limit: null, ratio: null, level: 'ok' });
    expect(quotas[0]?.level).toBe('warning');
  });
});

describe('Santé : utilitaires', () => {
  it('clés des services en snake_case, fenêtre de 24 h au prorata', () => {
    expect(snakeCase('googleServiceAccount')).toBe('google_service_account');
    const zero = { api_requests: 0, api_errors_5xx: 0, emails_sent: 0, emails_failed: 0 };
    // 06:00 UTC : 25 % du jour écoulé → 75 % de la veille.
    expect(last24h({ ...zero, api_requests: 100 }, { ...zero, api_requests: 400 }, NOW, 'api_requests')).toBe(400);
    expect(last24h(null, null, NOW, 'emails_sent')).toBe(0);
  });

  it('ligne AdminAlert hors contrat ignorée', () => {
    const row = { id: '0196f2a1-7c3e-7b2a-9c1d-2e3f4a5b6c7d', kind: 'job_failing', subject: 'purge', level: 'critical', details: { consecutiveFailures: 3 }, createdAt: NOW, notifiedAt: null, resolvedAt: null };
    expect(toAdminAlert(row)?.subject).toBe('purge');
    expect(toAdminAlert({ ...row, subject: 'Pas Valide !' })).toBeNull();
  });

  it('réponse complète conforme au contrat, services sans aucune valeur', async () => {
    const config = testConfig({ PUSH_PROVIDER: 'fake' });
    const prisma = { pushSubscription: { count: jest.fn(async () => 2) }, adminAlert: { findMany: jest.fn(async () => []) }, $queryRaw: jest.fn(async () => [{ size: 123456n }]) };
    const service = new HealthService(
      prisma as never,
      { states: async () => [jobState('purge', [run('r1', 'SUCCESS', 5)])] } as never,
      { read: async () => ({ api_requests: 10, api_errors_5xx: 1, emails_sent: 2, emails_failed: 0 }) } as never,
      { snapshot: async () => ({ quotas: [{ service: 'helius', period: 'day', used: 1, limit: 10, ratio: 0.1, level: 'ok' }] }) } as never,
      { isConfigured: () => false } as never,
      { mode: () => 'simulation' } as never,
      { configured: true } as never,
      config,
    );
    const health = await service.health(NOW);
    expect(adminHealthSchema.safeParse(health).success).toBe(true);
    expect(health.database.sizeBytes).toBe(123456);
    expect(health.push.provider).toBe('fake');
    expect(health.services['stripe']).toBe('not_configured');
    expect(health.services['ga4_data_api']).toBe('not_configured');
    expect(Object.values(health.services).every((value) => value === 'configured' || value === 'not_configured')).toBe(true);
    expect(health.api.errorRate).toBeCloseTo(health.api.serverErrors / health.api.requests);
  });
});
