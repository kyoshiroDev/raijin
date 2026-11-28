import { RISK_ENGINE_VERSION } from '@raijin/shared-risk-engine';
import {
  DEFAULT_OUTCOME_THRESHOLDS,
  DEFAULT_RETENTION_POLICY,
  FOLLOW_UP_HORIZONS,
  FOLLOW_UP_WINDOWS,
  RUG_EVENTS,
  engineVariantSchema,
  followUpObservationSchema,
  outcomeThresholdsSchema,
  REFERENCE_VARIANT_ID,
  retentionPolicySchema,
  variantEngineVersion,
} from './contracts';

describe('contrats du suivi des verdicts', () => {
  it('ordonne les horizons et leurs fenêtres', () => {
    const delays = FOLLOW_UP_HORIZONS.map((h) => FOLLOW_UP_WINDOWS[h].afterMs);
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(RUG_EVENTS).not.toContain('TOKEN_DEAD');
  });

  it('valide les valeurs par défaut', () => {
    expect(outcomeThresholdsSchema.parse(DEFAULT_OUTCOME_THRESHOLDS)).toEqual(DEFAULT_OUTCOME_THRESHOLDS);
    expect(retentionPolicySchema.parse(DEFAULT_RETENTION_POLICY)).toEqual(DEFAULT_RETENTION_POLICY);
    // Le suivi à 7 j (+ tolérance) doit être terminé avant toute purge des verdicts.
    const sevenDays = FOLLOW_UP_WINDOWS['7d'];
    expect(DEFAULT_RETENTION_POLICY.verdictRecordsDays * 86_400_000).toBeGreaterThan(sevenDays.afterMs + sevenDays.toleranceMs);
  });

  it('refuse un montant brut non entier et une variante qui usurpe la référence', () => {
    const base = {
      recordId: 'r1',
      horizon: '24h',
      observedAt: '2026-11-23T00:00:00.000Z',
      poolFound: true,
      lpRemoved: false,
      priceUsd: 1,
      liquidityUsd: 10,
      volume24hUsd: 5,
      supplyRaw: '1000',
    };
    expect(followUpObservationSchema.safeParse(base).success).toBe(true);
    expect(followUpObservationSchema.safeParse({ ...base, supplyRaw: '1e9' }).success).toBe(false);
    expect(engineVariantSchema.safeParse({ id: 'reference', label: 'x', overrides: {} }).success).toBe(false);
    expect(engineVariantSchema.safeParse({ id: 'top10-40', label: 'Top 10 à 40 %', overrides: { top10WarnPct: 40 } }).success).toBe(true);
    expect(variantEngineVersion(REFERENCE_VARIANT_ID)).toBe(RISK_ENGINE_VERSION);
    expect(variantEngineVersion('top10-40')).toBe(`${RISK_ENGINE_VERSION}-variante.top10-40`);
  });
});
