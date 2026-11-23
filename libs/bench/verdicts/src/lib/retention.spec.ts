import { DEFAULT_RETENTION_POLICY } from './contracts';
import { assessStorage, purgeCutoffs, shouldNotifyStorage } from './retention';

describe('purgeCutoffs', () => {
  it('30 j / 365 j / 30 j avant `now` par défaut', () => {
    expect(purgeCutoffs(new Date('2026-11-23T12:00:00.000Z'))).toEqual({
      detailedSnapshotsBefore: '2026-10-24T12:00:00.000Z',
      verdictRecordsBefore: '2025-11-23T12:00:00.000Z',
      jobRunsBefore: '2026-10-24T12:00:00.000Z',
    });
  });

  it('politique validée, date invalide refusée', () => {
    expect(purgeCutoffs(new Date('2026-01-31T00:00:00.000Z'), { ...DEFAULT_RETENTION_POLICY, jobRunsDays: 7 }).jobRunsBefore).toBe('2026-01-24T00:00:00.000Z');
    expect(() => purgeCutoffs(new Date('2026-01-31T00:00:00.000Z'), { ...DEFAULT_RETENTION_POLICY, verdictRecordsDays: 10 })).toThrow();
    expect(() => purgeCutoffs(new Date('invalide'))).toThrow(RangeError);
  });
});

describe('assessStorage', () => {
  it('bornes 0,8 et 0,95 incluses', () => {
    expect(assessStorage(0, 100)).toEqual({ ratio: 0, level: 'ok' });
    expect(assessStorage(79.99, 100).level).toBe('ok');
    expect(assessStorage(80, 100).level).toBe('warn');
    expect(assessStorage(94.99, 100).level).toBe('warn');
    expect(assessStorage(95, 100).level).toBe('critical');
    expect(assessStorage(120, 100)).toEqual({ ratio: 1.2, level: 'critical' });
  });

  it('allocation nulle ou négative, usage négatif refusés', () => {
    expect(() => assessStorage(1, 0)).toThrow(RangeError);
    expect(() => assessStorage(1, -5)).toThrow(RangeError);
    expect(() => assessStorage(1, Number.NaN)).toThrow(RangeError);
    expect(() => assessStorage(-1, 10)).toThrow(RangeError);
  });
});

describe('shouldNotifyStorage', () => {
  it('seulement à la montée, jamais en répétition ni à la baisse', () => {
    expect(shouldNotifyStorage(null, 'ok')).toBe(false);
    expect(shouldNotifyStorage(null, 'warn')).toBe(true);
    expect(shouldNotifyStorage('ok', 'warn')).toBe(true);
    expect(shouldNotifyStorage('warn', 'warn')).toBe(false);
    expect(shouldNotifyStorage('warn', 'critical')).toBe(true);
    expect(shouldNotifyStorage('ok', 'critical')).toBe(true);
    expect(shouldNotifyStorage('critical', 'critical')).toBe(false);
    expect(shouldNotifyStorage('critical', 'warn')).toBe(false);
  });
});
