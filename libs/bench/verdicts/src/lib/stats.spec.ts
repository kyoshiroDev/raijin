import { MIN_SAMPLE_SIZE, proportion, wilsonInterval } from './stats';

describe('wilsonInterval (95 %)', () => {
  it('valeurs de référence', () => {
    const half = wilsonInterval(5, 10);
    expect(half?.low).toBeCloseTo(0.2366, 4);
    expect(half?.high).toBeCloseTo(0.7634, 4);
    const zero = wilsonInterval(0, 10);
    expect(zero?.low).toBe(0);
    expect(zero?.high).toBeCloseTo(0.2775, 4);
    const all = wilsonInterval(10, 10);
    expect(all?.high).toBe(1);
    expect(all?.low).toBeCloseTo(0.7225, 4);
    const big = wilsonInterval(81, 100);
    expect(big?.low).toBeCloseTo(0.7222, 4);
    expect(big?.high).toBeCloseTo(0.8749, 4);
  });

  it('n = 0 : pas d’intervalle ; entrées invalides refusées', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(() => wilsonInterval(3, 2)).toThrow(RangeError);
    expect(() => wilsonInterval(-1, 2)).toThrow(RangeError);
    expect(() => wilsonInterval(1.5, 2)).toThrow(RangeError);
    expect(() => wilsonInterval(1, 2, 0)).toThrow(RangeError);
  });
});

describe('proportion', () => {
  it('porte l’effectif, l’intervalle et le drapeau d’échantillon', () => {
    expect(MIN_SAMPLE_SIZE).toBe(30);
    const p = proportion(12, 40);
    expect(p).toMatchObject({ successes: 12, total: 40, value: 0.3, insufficient: false });
    expect(p.low).toBeLessThan(0.3);
    expect(p.high).toBeGreaterThan(0.3);
    expect(proportion(29, 29).insufficient).toBe(true);
    expect(proportion(0, 30).insufficient).toBe(false);
    expect(proportion(3, 9, 5).insufficient).toBe(false);
  });

  it('n = 0 : valeur et bornes nulles, insuffisant', () => {
    expect(proportion(0, 0)).toEqual({ successes: 0, total: 0, value: null, low: null, high: null, insufficient: true });
    expect(() => proportion(1, 2, 0)).toThrow(RangeError);
  });
});
