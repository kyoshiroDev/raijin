import { RISK_ENGINE_VERSION } from '@raijin/shared-risk-engine';
import { buildQualityReport } from './report';
import { DEMO_VARIANTS, simulateHistory } from './simulation';
import { makeRecord } from './testing/records';

describe('buildQualityReport', () => {
  const history = simulateHistory(42, 300);
  const report = buildQualityReport(history, DEMO_VARIANTS);

  it('un bloc par horizon, période, découpage chronologique et effectifs', () => {
    expect(report.simulated).toBe(true);
    expect(report.engineVersion).toBe(RISK_ENGINE_VERSION);
    expect(report.records).toBe(300);
    expect(report.observations).toBe(history.observations.length);
    expect(report.horizons.map((h) => h.horizon)).toEqual(['24h', '72h', '7d']);
    expect(report.minSample).toBe(30);
    expect(report.minSupport).toBe(10);
    expect(report.period?.from).toBe(history.records[0]?.verdictAt);
    expect(Date.parse(report.calibrationPeriod?.to as string)).toBeLessThanOrEqual(Date.parse(report.validationPeriod?.from as string));
    for (const horizon of report.horizons) {
      expect(horizon.accuracy.counts.records).toBe(300);
      expect(horizon.accuracyRugOrDead.positive).toBe('rugOrDead');
      expect(horizon.replay.replayed).toBe(90);
      expect(horizon.replay.variants.map((v) => v.id)).toEqual(['top10-40', 'liquidite-20k']);
      expect(horizon.coverage.orphans).toBe(0);
    }
  });

  it('les verdicts d’une autre version du moteur sont exclus des métriques et comptés', () => {
    const records = [makeRecord({ id: 'old', engineVersion: '0.9.0' }), makeRecord({ id: 'new' })];
    const small = buildQualityReport({ simulated: false, records, observations: [] }, [], { calibrationRatio: 0.5, minSample: 5, minSupport: 2 });
    expect(small.otherEngineVersions).toBe(1);
    expect(small.horizons[0]?.accuracy.counts.records).toBe(1);
    expect(small.horizons[0]?.accuracy.dangerPrecision.insufficient).toBe(true);
    expect(small.simulated).toBe(false);
  });
});
