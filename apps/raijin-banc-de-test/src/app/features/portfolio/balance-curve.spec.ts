import { describe, expect, it } from 'vitest';
import { balanceCurve, curveGeometry, curveSummary } from './balance-curve';
import { testClosed } from './paper-test-data';

const WALLET = { initial_sol: 1, reset_at: '2026-11-01T00:00:00Z', created_at: null };

describe('balance curve', () => {
  it('starts at initial_sol and adds each closed P&L in closing order', () => {
    const points = balanceCurve([testClosed(1, 0.2, 'tp_hit', { symbol: 'A' }), testClosed(2, -0.3, 'sl_hit', { symbol: 'B' }), testClosed(3, 0.15, 'tp_hit')], WALLET);
    expect(points.map((p) => p.balanceSol)).toEqual([1, 1.2, 0.9, 1.05]);
    expect(points[0]).toEqual({ at: '2026-11-01T00:00:00Z', balanceSol: 1, pnlSol: 0, symbol: '' });
    expect(points[2]).toMatchObject({ pnlSol: -0.3, symbol: 'B' });
  });

  it('maps the points into the SVG box (x by trade, y by balance; the highest point at the top)', () => {
    const points = balanceCurve([testClosed(1, 0.2, 'tp_hit'), testClosed(2, -0.3, 'sl_hit')], WALLET);
    const g = curveGeometry(points, 320, 120, 10);
    expect(g?.line).toBe('M10,76.7 L160,10 L310,110');
    expect(g?.area).toBe('M10,76.7 L160,10 L310,110 L310,76.7 L10,76.7 Z');
    expect(g?.baseY).toBe(76.7);
    expect(g?.min).toBeCloseTo(0.9, 9);
    expect(g?.max).toBeCloseTo(1.2, 9);
    expect(g?.last).toEqual({ x: 310, y: 110 });
  });

  it('draws a flat, centred line when there is a single point', () => {
    const g = curveGeometry(balanceCurve([], WALLET), 320, 120, 10);
    expect(g?.line).toBe('M160,60');
    expect(curveGeometry([], 320, 120)).toBeNull();
  });

  it('summarises the curve for screen readers (start, end, trades, high, low)', () => {
    const points = balanceCurve([testClosed(1, 0.2, 'tp_hit'), testClosed(2, -0.3, 'sl_hit')], WALLET);
    expect(curveSummary(points)).toBe('Courbe du solde : de 1 SOL à 0,9 SOL sur 2 trades clôturés, plus haut 1,2 SOL, plus bas 0,9 SOL.');
    expect(curveSummary(balanceCurve([], WALLET))).toBe('Courbe du solde : 1 SOL, aucun trade clôturé pour l’instant.');
  });
});
