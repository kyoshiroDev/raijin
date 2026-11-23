import { FOLLOW_UP_WINDOWS, type OutcomeClassification } from './contracts';
import { classifyObservation, isInWindow, resolveOutcomeAt, resolveOutcomes } from './outcome';
import { makeObservation, makeRecord } from './testing/records';

const HOUR = 3_600_000;

describe('isInWindow', () => {
  const record = makeRecord();

  it('accepte les bornes de chaque fenêtre et refuse au-delà', () => {
    for (const horizon of ['24h', '72h', '7d'] as const) {
      const { toleranceMs } = FOLLOW_UP_WINDOWS[horizon];
      expect(isInWindow(record, makeObservation(record, horizon, {}, 0))).toBe(true);
      expect(isInWindow(record, makeObservation(record, horizon, {}, toleranceMs))).toBe(true);
      expect(isInWindow(record, makeObservation(record, horizon, {}, toleranceMs + 1))).toBe(false);
      expect(isInWindow(record, makeObservation(record, horizon, {}, -1))).toBe(false);
    }
  });

  it('fenêtres : 24 h + 6 h, 72 h + 12 h, 7 j + 24 h', () => {
    expect(isInWindow(record, makeObservation(record, '24h', {}, 6 * HOUR))).toBe(true);
    expect(isInWindow(record, makeObservation(record, '72h', {}, 12 * HOUR))).toBe(true);
    expect(isInWindow(record, makeObservation(record, '7d', {}, 24 * HOUR))).toBe(true);
  });

  it('refuse une date illisible', () => {
    expect(isInWindow({ verdictAt: 'pas une date' }, makeObservation(record, '24h'))).toBe(false);
  });
});

describe('classifyObservation', () => {
  const record = makeRecord();
  const classify = (overrides: Parameters<typeof makeObservation>[2]) => classifyObservation(record, makeObservation(record, '24h', overrides));

  it('alive quand rien ne bouge', () => {
    expect(classify({})).toEqual({ recordId: 'r1', horizon: '24h', status: 'alive', events: [] });
  });

  it('LP_REMOVED : drapeau de collecte, ou liquidité ≤ 10 % (pile au seuil)', () => {
    expect(classify({ lpRemoved: true })?.events).toEqual(['LP_REMOVED']);
    expect(classify({ liquidityUsd: 1_000 })?.events).toEqual(['LP_REMOVED']);
    expect(classify({ liquidityUsd: 1_000.01 })?.events).toEqual([]);
    expect(classify({ liquidityUsd: 1_000 })?.status).toBe('rug');
  });

  it('LP_REMOVED ignore une chute de liquidité si la liquidité au verdict était < 1 000 $', () => {
    const tiny = makeRecord({ baseline: { priceUsd: 1, liquidityUsd: 999, supplyRaw: null } });
    const result = classifyObservation(tiny, makeObservation(tiny, '24h', { liquidityUsd: 10, volume24hUsd: 5_000 }));
    expect(result?.events).toEqual(['TOKEN_DEAD']);
    expect(result?.status).toBe('dead');
  });

  it('PRICE_CRASH_90 : prix ≤ 10 % du prix au verdict, pile au seuil', () => {
    expect(classify({ priceUsd: 0.1 })?.events).toEqual(['PRICE_CRASH_90']);
    expect(classify({ priceUsd: 0.1000001 })?.events).toEqual([]);
  });

  it('PRICE_CRASH_90 ignoré si le prix au verdict est inconnu ou nul', () => {
    for (const priceUsd of [null, 0]) {
      const r = makeRecord({ baseline: { priceUsd, liquidityUsd: 10_000, supplyRaw: null } });
      expect(classifyObservation(r, makeObservation(r, '24h', { priceUsd: 0 }))?.events).toEqual([]);
    }
  });

  it('MINT_USED : supply comparée en bigint (au-delà de 2^53)', () => {
    const big = makeRecord({ baseline: { priceUsd: 1, liquidityUsd: 10_000, supplyRaw: '18446744073709551614' } });
    expect(classifyObservation(big, makeObservation(big, '24h', { supplyRaw: '18446744073709551615' }))?.events).toEqual(['MINT_USED']);
    expect(classifyObservation(big, makeObservation(big, '24h', { supplyRaw: '18446744073709551614' }))?.events).toEqual([]);
    expect(classify({ supplyRaw: '999999999' })?.events).toEqual([]);
    expect(classify({ supplyRaw: null })?.events).toEqual([]);
  });

  it('TOKEN_DEAD : pas de pool, liquidité < 1 000 $ ou volume < 100 $ (seuils exclus)', () => {
    expect(classify({ poolFound: false })?.status).toBe('dead');
    expect(classify({ volume24hUsd: 99.99 })?.status).toBe('dead');
    expect(classify({ volume24hUsd: 100 })?.status).toBe('alive');
    const low = makeRecord({ baseline: { priceUsd: 1, liquidityUsd: 500, supplyRaw: null } });
    expect(classifyObservation(low, makeObservation(low, '24h', { liquidityUsd: 999 }))?.status).toBe('dead');
    expect(classifyObservation(low, makeObservation(low, '24h', { liquidityUsd: 1_000 }))?.status).toBe('alive');
  });

  it('rug prime sur dead, événements dans l’ordre canonique', () => {
    const result = classify({ lpRemoved: true, priceUsd: 0.01, supplyRaw: '2000000000', poolFound: false });
    expect(result?.status).toBe('rug');
    expect(result?.events).toEqual(['LP_REMOVED', 'PRICE_CRASH_90', 'MINT_USED', 'TOKEN_DEAD']);
  });

  it('unknown si prix et liquidité sont inconnus sans événement ; un événement reste constaté', () => {
    const empty = { priceUsd: null, liquidityUsd: null, volume24hUsd: null, poolFound: null, lpRemoved: null, supplyRaw: null };
    expect(classify(empty)?.status).toBe('unknown');
    expect(classify({ ...empty, lpRemoved: true })?.status).toBe('rug');
    expect(classify({ ...empty, poolFound: false })?.status).toBe('dead');
    expect(classify({ ...empty, priceUsd: 2 })?.status).toBe('alive');
  });

  it('hors fenêtre : null (écartée) ; autre verdict : erreur', () => {
    expect(classifyObservation(record, makeObservation(record, '24h', {}, 7 * HOUR))).toBeNull();
    expect(() => classifyObservation(record, makeObservation({ id: 'r2', verdictAt: record.verdictAt }, '24h'))).toThrow(RangeError);
  });

  it('seuils configurables et validés', () => {
    const observation = makeObservation(record, '24h', { priceUsd: 0.4 });
    expect(classifyObservation(record, observation, { crashDropPct: 50, liquidityBaselineMinUsd: 1_000, deadLiquidityUsd: 1_000, deadVolume24hUsd: 100 })?.events).toEqual([
      'PRICE_CRASH_90',
    ]);
    expect(() => classifyObservation(record, observation, { crashDropPct: 0, liquidityBaselineMinUsd: 0, deadLiquidityUsd: 0, deadVolume24hUsd: 0 })).toThrow();
  });
});

describe('resolveOutcomeAt (cumulatif)', () => {
  const at = (horizon: OutcomeClassification['horizon'], status: OutcomeClassification['status'], events: OutcomeClassification['events'] = []): OutcomeClassification => ({
    recordId: 'r1',
    horizon,
    status,
    events,
  });

  it('un rug à 24 h reste un rug à 72 h et 7 j, même si le token semble vivant ensuite', () => {
    const list = [at('24h', 'rug', ['PRICE_CRASH_90']), at('72h', 'alive'), at('7d', 'alive')];
    for (const horizon of ['24h', '72h', '7d'] as const) {
      expect(resolveOutcomeAt(horizon, list)).toEqual({ horizon, status: 'rug', events: ['PRICE_CRASH_90'] });
    }
  });

  it('n’anticipe pas : un rug à 7 j n’existe pas à 24 h', () => {
    const list = [at('24h', 'alive'), at('7d', 'rug', ['LP_REMOVED'])];
    expect(resolveOutcomeAt('24h', list).status).toBe('alive');
    expect(resolveOutcomeAt('72h', list).status).toBe('unknown');
    expect(resolveOutcomeAt('7d', list).status).toBe('rug');
  });

  it('union des événements, mort puis rug → rug', () => {
    const list = [at('24h', 'dead', ['TOKEN_DEAD']), at('72h', 'rug', ['MINT_USED'])];
    expect(resolveOutcomeAt('24h', list).status).toBe('dead');
    expect(resolveOutcomeAt('72h', list)).toEqual({ horizon: '72h', status: 'rug', events: ['MINT_USED', 'TOKEN_DEAD'] });
    expect(resolveOutcomeAt('7d', list).status).toBe('rug');
  });

  it('sans observation, ou avec une observation inexploitable : unknown', () => {
    expect(resolveOutcomeAt('7d', [])).toEqual({ horizon: '7d', status: 'unknown', events: [] });
    expect(resolveOutcomeAt('24h', [at('24h', 'unknown')]).status).toBe('unknown');
  });

  it('refuse de mélanger plusieurs verdicts', () => {
    expect(() => resolveOutcomeAt('24h', [at('24h', 'alive'), { ...at('24h', 'alive'), recordId: 'r2' }])).toThrow(RangeError);
  });
});

describe('resolveOutcomes', () => {
  it('compte hors fenêtre, orphelines et manquantes ; chaque verdict a une issue', () => {
    const a = makeRecord({ id: 'a' });
    const b = makeRecord({ id: 'b' });
    const observations = [
      makeObservation(a, '24h', { lpRemoved: true }),
      makeObservation(a, '72h', {}, 13 * HOUR),
      makeObservation({ id: 'zz', verdictAt: a.verdictAt }, '24h'),
      makeObservation(b, '72h'),
    ];
    const at72 = resolveOutcomes([a, b], observations, '72h');
    expect(at72.outOfWindow).toBe(1);
    expect(at72.orphans).toBe(1);
    expect(at72.missingAtHorizon).toBe(1);
    expect(at72.byRecord.get('a')?.status).toBe('rug');
    expect(at72.byRecord.get('b')?.status).toBe('alive');
    expect(resolveOutcomes([a, b], observations, '7d').byRecord.get('b')?.status).toBe('unknown');
  });
});
