import { RISK_FACTS_VERSION, type RiskFacts } from '@raijin/shared-contracts';
import { DEFAULT_RISK_ENGINE_CONFIG, RISK_ENGINE_VERSION, evaluateRisk, resolveRiskEngineConfig } from '@raijin/shared-risk-engine';
import type { EngineVariant, VerdictRecord } from './contracts';
import type { HorizonOutcome } from './outcome';
import {
  OVERRIDABLE_CONFIG_KEYS,
  configFingerprint,
  fnv1a32,
  replayVariants,
  resolveReference,
  resolveVariant,
  stableStringify,
  toScoredVerdict,
} from './variant';
import { createPrng, simulateFacts } from './simulation';
import { MINT, VERDICT_AT, makeRecord } from './testing/records';

const TOP10_40: EngineVariant = { id: 'top10-40', label: 'Top 10 à 40 %', overrides: { top10WarnPct: 40 } };

describe('empreinte FNV-1a', () => {
  it('vecteurs de référence FNV-1a 32 bits', () => {
    expect(fnv1a32('')).toBe('811c9dc5');
    expect(fnv1a32('a')).toBe('e40c292c');
    expect(fnv1a32('foobar')).toBe('bf9cf968');
  });

  it('encode en UTF-8 (2, 3 et 4 octets)', () => {
    expect(fnv1a32('é')).not.toBe(fnv1a32('e'));
    expect(fnv1a32('€')).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a32('⚡️🛡')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('JSON stable : clés triées à toute profondeur, tableaux dans l’ordre, undefined omis', () => {
    expect(stableStringify({ b: 1, a: { d: [2, 1], c: null }, e: undefined })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
  });

  it('indépendante de l’ordre des clés, sensible au contenu', () => {
    const config = resolveRiskEngineConfig();
    const reordered = Object.fromEntries(Object.entries(config).reverse()) as typeof config;
    expect(configFingerprint(reordered)).toBe(configFingerprint(config));
    expect(configFingerprint({ ...config, top10WarnPct: 31 })).not.toBe(configFingerprint(config));
  });
});

describe('resolveVariant', () => {
  it('version -variante.<id>, config validée, empreinte', () => {
    const variant = resolveVariant(TOP10_40);
    expect(variant.version).toBe(`${RISK_ENGINE_VERSION}-variante.top10-40`);
    expect(variant.config.top10WarnPct).toBe(40);
    expect(variant.config.version).toBe(variant.version);
    expect(variant.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(variant.fingerprint).not.toBe(resolveReference().fingerprint);
  });

  it('même identifiant, contenus différents : empreintes différentes', () => {
    expect(resolveVariant({ ...TOP10_40, overrides: { top10WarnPct: 35 } }).fingerprint).not.toBe(resolveVariant(TOP10_40).fingerprint);
  });

  it('poids de raisons fusionnés avec ceux par défaut', () => {
    const variant = resolveVariant({ id: 'meta', label: 'Métadonnées', overrides: {}, reasonWeights: { METADATA_MUTABLE: 1 } });
    expect(variant.config.reasonWeights.METADATA_MUTABLE).toBe(1);
    expect(variant.config.reasonWeights.RUGCHECK_WARN).toBe(DEFAULT_RISK_ENGINE_CONFIG.reasonWeights.RUGCHECK_WARN);
  });

  it('refuse une clé inconnue, une clé non numérique et l’identifiant réservé', () => {
    expect(OVERRIDABLE_CONFIG_KEYS).toContain('top10WarnPct');
    expect(OVERRIDABLE_CONFIG_KEYS).not.toContain('version');
    expect(() => resolveVariant({ id: 'x', label: 'x', overrides: { top10WarnPctt: 40 } })).toThrow(/Surcharge inconnue/);
    expect(() => resolveVariant({ id: 'x', label: 'x', overrides: { version: 2 } })).toThrow(/Surcharge inconnue/);
    expect(() => resolveVariant({ id: 'reference', label: 'x', overrides: {} })).toThrow();
    expect(() => resolveVariant({ id: 'x', label: 'x', overrides: { top10WarnPct: -1 } })).toThrow();
  });

  it('référence : configuration par défaut et version publiée', () => {
    const reference = resolveReference();
    expect(reference).toMatchObject({ id: 'reference', version: RISK_ENGINE_VERSION });
    expect(reference.config.top10WarnPct).toBe(DEFAULT_RISK_ENGINE_CONFIG.top10WarnPct);
  });
});

function recordWith(id: string, facts: RiskFacts): VerdictRecord {
  const assessment = evaluateRisk(facts);
  const scoredVerdict = toScoredVerdict(id, assessment);
  return makeRecord({ id, facts, verdict: assessment.verdict, reasonCodes: scoredVerdict.reasonCodes, flaggedChecks: scoredVerdict.flaggedChecks });
}

describe('replayVariants', () => {
  const concentrated = (seed: number) => {
    const facts = simulateFacts('established', MINT, VERDICT_AT, createPrng(seed));
    return { ...facts, holders: { top10Pct: 35, maxSingleHolderPct: 5, excludedAccounts: 2 } };
  };
  const records = [
    recordWith('c-rug', concentrated(1)),
    recordWith('c-alive', concentrated(2)),
    recordWith('c-unknown', concentrated(3)),
    recordWith('healthy', simulateFacts('established', MINT, VERDICT_AT, createPrng(4))),
    recordWith('danger', simulateFacts('honeypot', MINT, VERDICT_AT, createPrng(5))),
  ];
  const outcomes = new Map<string, HorizonOutcome>([
    ['c-rug', { horizon: '72h', status: 'rug', events: ['LP_REMOVED'] }],
    ['c-alive', { horizon: '72h', status: 'alive', events: [] }],
    ['c-unknown', { horizon: '72h', status: 'unknown', events: [] }],
    ['healthy', { horizon: '72h', status: 'alive', events: [] }],
    ['danger', { horizon: '72h', status: 'rug', events: ['PRICE_CRASH_90'] }],
  ]);

  it('variante identique à la référence : aucun changement', () => {
    const report = replayVariants(records, outcomes, [{ id: 'same', label: 'Identique', overrides: {} }], '72h');
    const [same] = report.variants;
    expect(same?.changes).toMatchObject({ changed: 0, improved: 0, degraded: 0, unscored: 0 });
    expect(same?.delta).toEqual({ dangerPrecision: 0, dangerRecall: 0, falseSafeRate: 0, cautionPositiveRate: 0 });
    expect(same?.accuracy.matrix).toEqual(report.reference.accuracy.matrix);
  });

  it('top10WarnPct à 40 : les tokens concentrés passent de Prudence à Sain (corrigé, dégradé, non jugé)', () => {
    expect(records.map((r) => r.verdict)).toEqual(['warn', 'warn', 'warn', 'safe', 'danger']);
    const report = replayVariants(records, outcomes, [TOP10_40], '72h');
    expect(report.replayed).toBe(5);
    expect(report.skippedFactsVersion).toBe(0);
    expect(report.reference.version).toBe(RISK_ENGINE_VERSION);
    const [variant] = report.variants;
    expect(variant?.version).toBe('1.0.0-variante.top10-40');
    expect(variant?.overrides).toEqual({ top10WarnPct: 40 });
    expect(variant?.changes.matrix.warn).toEqual({ safe: 3, warn: 0, danger: 0 });
    expect(variant?.changes.matrix.danger.danger).toBe(1);
    expect(variant?.changes).toMatchObject({ changed: 3, improved: 1, degraded: 1, unscored: 1 });
    // Un rug de plus parmi les Sain : faux Sain 0/1 → 1/3.
    expect(variant?.accuracy.falseSafeRate).toMatchObject({ successes: 1, total: 3 });
    expect(variant?.delta.falseSafeRate).toBeCloseTo(1 / 3);
    expect(variant?.delta.cautionPositiveRate).toBeNull();
  });

  it('variante plus sévère : un token sain qui survit passe en Prudence = dégradé', () => {
    const strict: EngineVariant = { id: 'strict', label: 'Strict', overrides: { cautionScoreThreshold: 0 } };
    const report = replayVariants(records, outcomes, [strict], '72h');
    expect(report.variants[0]?.changes).toMatchObject({ changed: 1, degraded: 1 });
  });

  it('écarte et compte les faits d’une autre version ; refuse les identifiants en double', () => {
    const old = { ...records[0], id: 'old', facts: { ...records[0]?.facts, version: RISK_FACTS_VERSION + 1 } } as unknown as VerdictRecord;
    const report = replayVariants([...records, old], outcomes, [], '72h');
    expect(report.skippedFactsVersion).toBe(1);
    expect(report.replayed).toBe(5);
    expect(() => replayVariants(records, outcomes, [TOP10_40, TOP10_40], '72h')).toThrow(/double/);
  });

  it('positif rug ∪ mort et verdict sans issue', () => {
    const partial = new Map([...outcomes].filter(([id]) => id !== 'c-rug'));
    const report = replayVariants(records, partial, [TOP10_40], '72h', { positive: 'rugOrDead', minSample: 1 });
    expect(report.positive).toBe('rugOrDead');
    expect(report.variants[0]?.changes.unscored).toBe(2);
    expect(report.reference.accuracy.counts.missing).toBe(1);
  });
});
