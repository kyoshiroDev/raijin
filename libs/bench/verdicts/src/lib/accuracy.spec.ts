import type { HorizonOutcome } from './outcome';
import { computeAccuracy, signalPower } from './accuracy';
import { scored } from './testing/records';

type Status = HorizonOutcome['status'];

function outcomesOf(entries: Array<[string, Status]>, horizon: HorizonOutcome['horizon'] = '24h'): Map<string, HorizonOutcome> {
  return new Map(entries.map(([id, status]) => [id, { horizon, status, events: [] }]));
}

function assign(items: Array<{ id: string }>, status: Status): Array<[string, Status]> {
  return items.map((item) => [item.id, status]);
}

describe('computeAccuracy', () => {
  // 40 Danger (30 rugs), 50 Sain (2 rugs, 3 morts), 20 Prudence (6 rugs, 4 morts), 5 inconnus, 2 sans issue.
  const dangerRug = scored('dr', 30, 'danger');
  const dangerAlive = scored('da', 10, 'danger');
  const safeRug = scored('sr', 2, 'safe');
  const safeDead = scored('sd', 3, 'safe');
  const safeAlive = scored('sa', 45, 'safe');
  const warnRug = scored('wr', 6, 'warn');
  const warnDead = scored('wd', 4, 'warn');
  const warnAlive = scored('wa', 10, 'warn');
  const unknown = scored('u', 5, 'danger');
  const missing = scored('m', 2, 'safe');
  const items = [...dangerRug, ...dangerAlive, ...safeRug, ...safeDead, ...safeAlive, ...warnRug, ...warnDead, ...warnAlive, ...unknown, ...missing];
  const outcomes = outcomesOf([
    ...assign(dangerRug, 'rug'),
    ...assign(dangerAlive, 'alive'),
    ...assign(safeRug, 'rug'),
    ...assign(safeDead, 'dead'),
    ...assign(safeAlive, 'alive'),
    ...assign(warnRug, 'rug'),
    ...assign(warnDead, 'dead'),
    ...assign(warnAlive, 'alive'),
    ...assign(unknown, 'unknown'),
  ]);

  it('classe positive rug : précision, rappel, faux Sain, Prudence, effectifs', () => {
    const report = computeAccuracy(items, outcomes, { horizon: '24h' });
    expect(report.positive).toBe('rug');
    expect(report.counts).toEqual({ records: 117, evaluated: 110, unknown: 5, missing: 2, positives: 38 });
    expect(report.matrix).toEqual({ safe: { rug: 2, dead: 3, alive: 45 }, warn: { rug: 6, dead: 4, alive: 10 }, danger: { rug: 30, dead: 0, alive: 10 } });
    expect(report.dangerPrecision).toMatchObject({ successes: 30, total: 40, value: 0.75, insufficient: false });
    expect(report.dangerRecall).toMatchObject({ successes: 30, total: 38, insufficient: false });
    expect(report.falseSafeRate).toMatchObject({ successes: 2, total: 50, value: 0.04 });
    expect(report.cautionPositiveRate).toMatchObject({ successes: 6, total: 20, insufficient: true });
    expect(report.baseRate).toMatchObject({ successes: 38, total: 110 });
  });

  it('classe positive rug ∪ mort', () => {
    const report = computeAccuracy(items, outcomes, { horizon: '24h', positive: 'rugOrDead' });
    expect(report.counts.positives).toBe(45);
    expect(report.falseSafeRate).toMatchObject({ successes: 5, total: 50 });
    expect(report.dangerRecall).toMatchObject({ successes: 30, total: 45 });
  });

  it('n = 0 : aucune valeur, tout insuffisant', () => {
    const report = computeAccuracy([], new Map(), { horizon: '7d' });
    expect(report.dangerPrecision.value).toBeNull();
    expect(report.dangerRecall.insufficient).toBe(true);
  });

  it('refuse une issue d’un autre horizon', () => {
    expect(() => computeAccuracy(dangerRug, outcomesOf(assign(dangerRug, 'rug'), '7d'), { horizon: '24h' })).toThrow(RangeError);
  });
});

describe('signalPower', () => {
  // 20 porteurs de TOP10 (10 rugs), 80 autres (10 rugs) ; 5 porteurs de METADATA_MUTABLE (0 rug).
  const top10 = scored('t', 20, 'warn', ['TOP10_CONCENTRATION_HIGH'], ['holder_concentration']);
  const mutable = scored('mm', 5, 'safe', ['METADATA_MUTABLE'], ['metadata_mutable']);
  const others = scored('o', 75, 'safe');
  const items = [...top10, ...mutable, ...others];
  const outcomes = outcomesOf([
    ...top10.map((item, i): [string, Status] => [item.id, i < 10 ? 'rug' : 'alive']),
    ...assign(mutable, 'alive'),
    ...others.map((item, i): [string, Status] => [item.id, i < 10 ? 'rug' : 'alive']),
  ]);

  it('taux avec / sans, lift, classement à partir de 10 porteurs', () => {
    const report = signalPower(items, outcomes, { horizon: '24h' });
    expect(report.evaluated).toBe(100);
    expect(report.baseRate.value).toBeCloseTo(0.2);
    const [first, second] = report.byReason;
    expect(first).toMatchObject({ kind: 'reason', signal: 'TOP10_CONCENTRATION_HIGH', support: 20, ranked: true });
    expect(first?.withSignal).toMatchObject({ successes: 10, total: 20, insufficient: true });
    expect(first?.withoutSignal).toMatchObject({ successes: 10, total: 80 });
    expect(first?.lift).toBeCloseTo(2.5);
    expect(second).toMatchObject({ signal: 'METADATA_MUTABLE', support: 5, ranked: false, lift: null });
    expect(report.byReason).toHaveLength(2);
    expect(report.byCheck.map((row) => row.signal)).toEqual(['holder_concentration', 'metadata_mutable']);
  });

  it('support minimal configurable ; taux global nul → lift nul', () => {
    const lowSupport = signalPower(items, outcomes, { horizon: '24h', minSupport: 5 });
    expect(lowSupport.byReason.find((row) => row.signal === 'METADATA_MUTABLE')).toMatchObject({ ranked: true, lift: 0 });
    const noRug = signalPower(top10, outcomesOf(assign(top10, 'alive')), { horizon: '24h' });
    expect(noRug.byReason[0]?.lift).toBeNull();
    expect(() => signalPower(items, outcomes, { horizon: '24h', minSupport: 0 })).toThrow(RangeError);
  });

  it('classement par lift puis par support', () => {
    const a = scored('a', 10, 'warn', ['LIQUIDITY_LOW']);
    const b = scored('b', 12, 'warn', ['POOL_VERY_NEW']);
    const report = signalPower([...a, ...b], outcomesOf([...assign(a, 'rug'), ...assign(b, 'rug')]), { horizon: '24h' });
    expect(report.byReason.map((row) => row.signal)).toEqual(['POOL_VERY_NEW', 'LIQUIDITY_LOW']);
  });
});
