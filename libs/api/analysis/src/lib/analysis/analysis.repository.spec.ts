import type { PrismaService } from '@raijin/api-prisma';
import { DefaultRiskEngine } from './risk-engine.provider';
import { buildAnalysisResult } from './result-builder';
import { FIXTURE_MINTS, FixtureFactsCollector } from '../fixtures/fixture-facts-collector';
import { AnalysisRepository, PUBLISHED_ANALYSIS_MAX_AGE_MS } from './analysis.repository';

const NOW = new Date('2026-11-22T12:00:00.000Z');

async function fixture() {
  const collected = await new FixtureFactsCollector({ now: () => NOW }).collectFacts(FIXTURE_MINTS.warn);
  if (!collected) throw new Error('fixture absente');
  return { collected, result: buildAnalysisResult(FIXTURE_MINTS.warn, collected, new DefaultRiskEngine().evaluate(collected.facts), NOW) };
}

function setup() {
  const prisma = {
    tokenAnalysis: { create: jest.fn(async () => ({})), findFirst: jest.fn() },
    productEvent: { create: jest.fn(async () => ({})) },
  };
  return { prisma, repository: new AnalysisRepository(prisma as unknown as PrismaService) };
}

describe('AnalysisRepository', () => {
  it('persiste verdict, contrôles, sources, faits, version du moteur, métadonnées et durée', async () => {
    const { prisma, repository } = setup();
    const { collected, result } = await fixture();
    await repository.save(result, collected, 123.4, 'user-1');
    const [[{ data }]] = prisma.tokenAnalysis.create.mock.calls as unknown as [[{ data: Record<string, unknown> }]];
    expect(data).toMatchObject({
      mint: FIXTURE_MINTS.warn,
      verdict: result.verdict,
      engineVersion: result.engineVersion,
      degraded: false,
      explanation: result.explanation,
      durationMs: 123,
      userId: 'user-1',
    });
    expect(data['checks']).toEqual(result.checks);
    expect(data['facts']).toEqual(collected.facts);
    expect(data['sources']).toEqual(collected.sources);
    expect(data['token']).toEqual(result.token);
  });

  it('échec d’écriture : journalisé, jamais levé', async () => {
    const { prisma, repository } = setup();
    const { collected, result } = await fixture();
    prisma.tokenAnalysis.create.mockRejectedValueOnce(new Error('postgresql://u:p@db'));
    prisma.productEvent.create.mockRejectedValueOnce(new Error('x'));
    await expect(repository.save(result, collected, 1, null)).resolves.toBeUndefined();
    await expect(
      repository.recordEvent({ userId: null, mint: FIXTURE_MINTS.warn, verdict: 'warn', cached: false, degraded: false, engineVersion: '1.0.0', durationMs: 5, subject: 'anonymous' }),
    ).resolves.toBeUndefined();
  });

  it('dernière analyse de moins de 24 h, revalidée par le contrat', async () => {
    const { prisma, repository } = setup();
    const { result } = await fixture();
    prisma.tokenAnalysis.findFirst.mockResolvedValueOnce({
      mint: result.mint,
      verdict: result.verdict,
      checks: result.checks,
      engineVersion: result.engineVersion,
      token: result.token,
      degraded: result.degraded,
      explanation: result.explanation,
      createdAt: NOW,
    });
    await expect(repository.findLatest(FIXTURE_MINTS.warn, NOW)).resolves.toMatchObject({ verdict: result.verdict, cached: true });
    const where = (prisma.tokenAnalysis.findFirst.mock.calls[0] as unknown as [{ where: { createdAt: { gte: Date } } }])[0].where;
    expect(where.createdAt.gte.getTime()).toBe(NOW.getTime() - PUBLISHED_ANALYSIS_MAX_AGE_MS);

    prisma.tokenAnalysis.findFirst.mockResolvedValueOnce(null);
    await expect(repository.findLatest(FIXTURE_MINTS.warn, NOW)).resolves.toBeNull();
    // Ligne antérieure à la phase 3 (sans métadonnées) : hors contrat, ignorée.
    prisma.tokenAnalysis.findFirst.mockResolvedValueOnce({ mint: result.mint, verdict: 'safe', checks: [], engineVersion: '0.0.0', token: null, degraded: false, explanation: null, createdAt: NOW });
    await expect(repository.findLatest(FIXTURE_MINTS.warn, NOW)).resolves.toBeNull();
  });

  it('événement analysis_done', async () => {
    const { prisma, repository } = setup();
    await repository.recordEvent({ userId: null, mint: FIXTURE_MINTS.warn, verdict: 'warn', cached: true, degraded: false, engineVersion: '1.0.0', durationMs: 4.6, subject: 'anonymous' });
    expect(prisma.productEvent.create).toHaveBeenCalledWith({
      data: {
        type: 'analysis_done',
        userId: null,
        properties: { mint: FIXTURE_MINTS.warn, verdict: 'warn', cached: true, degraded: false, engineVersion: '1.0.0', durationMs: 5, subject: 'anonymous' },
      },
    });
  });
});
