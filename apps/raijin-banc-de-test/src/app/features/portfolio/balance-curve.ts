// Balance curve of a virtual book (pure): initial_sol, then + pnl_sol of every closed position, in closing order.
import { roundSol, type PaperPosition, type PaperWallet } from '../../shared/models/paper';
import { formatSolAmount } from '../../shared/utils/format';

export interface CurvePoint {
  /** ISO date of the point (the reset / creation for the first one; may be null when unknown). */
  at: string | null;
  balanceSol: number;
  /** P&L of the trade that produced this point (0 for the starting point). */
  pnlSol: number;
  symbol: string;
}

/** Starting point + one point per closed trade (trades must be in closing order, see closedTrades). */
export function balanceCurve(trades: readonly PaperPosition[], wallet: Pick<PaperWallet, 'initial_sol' | 'reset_at' | 'created_at'>): CurvePoint[] {
  const points: CurvePoint[] = [{ at: wallet.reset_at ?? wallet.created_at, balanceSol: wallet.initial_sol, pnlSol: 0, symbol: '' }];
  let balance = wallet.initial_sol;
  for (const p of trades) {
    const pnl = p.pnl_sol ?? 0;
    balance = roundSol(balance + pnl);
    points.push({ at: p.closed_at, balanceSol: balance, pnlSol: pnl, symbol: p.symbol });
  }
  return points;
}

export interface CurveGeometry {
  /** SVG path of the line. */
  line: string;
  /** Closed SVG path of the area under the line (down to the starting balance). */
  area: string;
  /** y of the starting balance. */
  baseY: number;
  min: number;
  max: number;
  last: { x: number; y: number };
}

/** Maps the points into a `width × height` box (x = trade index, y = balance), with `pad` px of margin. */
export function curveGeometry(points: readonly CurvePoint[], width: number, height: number, pad = 6): CurveGeometry | null {
  if (points.length === 0) return null;
  const values = points.map((p) => p.balanceSol);
  const start = values[0];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(Math.abs(start!) * 0.1, 0.01);
  const lo = max - min === 0 ? start! - span / 2 : min;
  const x = (i: number) => (points.length === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (points.length - 1));
  const y = (v: number) => pad + (1 - (v - lo) / span) * (height - 2 * pad);
  const r = (n: number) => Math.round(n * 10) / 10;
  const coords = values.map((v, i) => `${r(x(i))},${r(y(v))}`);
  const line = `M${coords.join(' L')}`;
  const baseY = r(y(start!));
  const area = `${line} L${r(x(values.length - 1))},${baseY} L${r(x(0))},${baseY} Z`;
  return { line, area, baseY, min, max, last: { x: r(x(values.length - 1)), y: r(y(values[values.length - 1]!)) } };
}

/** Accessible summary of the curve (aria-label). */
export function curveSummary(points: readonly CurvePoint[]): string {
  if (points.length <= 1) return `Courbe du solde : ${formatSolAmount(points[0]?.balanceSol ?? 0)} SOL, aucun trade clôturé pour l’instant.`;
  const values = points.map((p) => p.balanceSol);
  const first = values[0];
  const last = values[values.length - 1];
  const n = points.length - 1;
  return (
    `Courbe du solde : de ${formatSolAmount(first)} SOL à ${formatSolAmount(last)} SOL sur ${n} trade${n > 1 ? 's' : ''} clôturé${n > 1 ? 's' : ''}, ` +
    `plus haut ${formatSolAmount(Math.max(...values))} SOL, plus bas ${formatSolAmount(Math.min(...values))} SOL.`
  );
}
