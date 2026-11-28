import { isSolanaAddress } from '@raijin/shared-util';
import { followUpObservationSchema, verdictRecordSchema } from './contracts';
import { classifyObservation, resolveOutcomes } from './outcome';
import { DEMO_VARIANTS, SIMULATION_PROFILES, createPrng, simulateHistory } from './simulation';
import { resolveVariant } from './variant';

describe('createPrng', () => {
  it('déterministe, dans [0, 1[', () => {
    const a = createPrng(7);
    const b = createPrng(7);
    const values = Array.from({ length: 100 }, () => a());
    expect(values).toEqual(Array.from({ length: 100 }, () => b()));
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(createPrng(8)()).not.toBe(values[0]);
  });
});

describe('simulateHistory', () => {
  const history = simulateHistory(42, 400);

  it('même graine → mêmes données ; autre graine → autres données', () => {
    expect(simulateHistory(42, 50)).toEqual(simulateHistory(42, 50));
    expect(simulateHistory(43, 50).records[20]?.mint).not.toBe(simulateHistory(42, 50).records[20]?.mint);
    expect(history.simulated).toBe(true);
  });

  it('verdicts et observations conformes aux contrats, mints valides', () => {
    for (const record of history.records) {
      expect(verdictRecordSchema.safeParse(record).success).toBe(true);
      expect(isSolanaAddress(record.mint)).toBe(true);
      expect(record.verdictAt).toBe(record.facts.observedAt);
    }
    for (const observation of history.observations.slice(0, 200)) {
      expect(followUpObservationSchema.safeParse(observation).success).toBe(true);
    }
  });

  it('couvre tous les verdicts, événements, issues, et les observations manquantes ou hors fenêtre', () => {
    expect(new Set(history.records.map((r) => r.verdict))).toEqual(new Set(['safe', 'warn', 'danger']));
    const byId = new Map(history.records.map((r) => [r.id, r]));
    const classifications = history.observations.map((o) => classifyObservation(byId.get(o.recordId) as never, o));
    expect(classifications.some((c) => c === null)).toBe(true);
    const events = new Set(classifications.flatMap((c) => c?.events ?? []));
    expect(events).toEqual(new Set(['LP_REMOVED', 'PRICE_CRASH_90', 'MINT_USED', 'TOKEN_DEAD']));
    expect(new Set(classifications.map((c) => c?.status))).toEqual(new Set(['rug', 'dead', 'alive', 'unknown', undefined]));
    expect(history.observations.length).toBeLessThan(history.records.length * 3);
    expect(resolveOutcomes(history.records, history.observations, '7d').missingAtHorizon).toBeGreaterThan(0);
  });

  it('issues cohérentes sans être parfaites : plus de rugs parmi les Danger, mais des rugs parmi les Sain', () => {
    const outcomes = resolveOutcomes(history.records, history.observations, '7d').byRecord;
    const rugRate = (verdict: string) => {
      const group = history.records.filter((r) => r.verdict === verdict && outcomes.get(r.id)?.status !== 'unknown');
      return group.filter((r) => outcomes.get(r.id)?.status === 'rug').length / group.length;
    };
    expect(rugRate('danger')).toBeGreaterThan(rugRate('warn'));
    expect(rugRate('warn')).toBeGreaterThan(rugRate('safe'));
    expect(rugRate('safe')).toBeGreaterThan(0);
  });

  it('les premiers verdicts parcourent tous les profils', () => {
    const first = simulateHistory(1, SIMULATION_PROFILES.length).records;
    expect(first.filter((r) => r.verdict === 'danger')).toHaveLength(3);
    expect(first.some((r) => r.reasonCodes.includes('DATA_UNAVAILABLE'))).toBe(true);
  });

  it('paramètres validés', () => {
    expect(simulateHistory(0, 0).records).toEqual([]);
    expect(simulateHistory(5, 3, { start: '2026-01-01T00:00:00.000Z', spacingHours: 1 }).records[0]?.verdictAt.startsWith('2026-01-01')).toBe(true);
    expect(() => simulateHistory(-1, 1)).toThrow(RangeError);
    expect(() => simulateHistory(1.5, 1)).toThrow(RangeError);
    expect(() => simulateHistory(1, 10_001)).toThrow(RangeError);
    expect(() => simulateHistory(1, 1, { spacingHours: 0 })).toThrow(RangeError);
    expect(() => simulateHistory(1, 1, { start: 'hier' })).toThrow(RangeError);
  });

  it('variantes de démonstration valides', () => {
    expect(DEMO_VARIANTS.map((v) => resolveVariant(v).version)).toEqual(['1.0.0-variante.top10-40', '1.0.0-variante.liquidite-20k']);
  });
});
