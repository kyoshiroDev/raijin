// Display helpers of the laboratory (pure, French formatting).
import { formatPercentFr, formatSignedPercentFr, formatSignedSol, formatSolAmount } from '../utils/format';
import type { DataVersion, LabMetrics } from './backtest';

const DECIMAL_2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INTEGER = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const DATE_FR = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

/** « 42 % » from a 0–1 share; '–' when unknown. */
export function formatShare(f: number | null): string {
  return f === null || !Number.isFinite(f) ? '–' : `${INTEGER.format(f * 100)} %`;
}

/** « 1 440 »; '–' when unknown. */
export function formatInt(n: number | null): string {
  return n === null || !Number.isFinite(n) ? '–' : INTEGER.format(n);
}

/** « 1,85 »; '–' when undefined (no losing trade, or no trade). */
export function formatProfitFactor(n: number | null): string {
  return n === null || !Number.isFinite(n) ? '–' : DECIMAL_2.format(n);
}

/** « [+1,2 % ; +8,4 %] »; '–' when a bound is missing. */
export function formatCi(low: number | null, high: number | null): string {
  return low === null || high === null ? '–' : `[${formatSignedPercentFr(low)} ; ${formatSignedPercentFr(high)}]`;
}

/** « 18 nov., 03:40 » (Paris); '–' when missing. */
export function formatLabDate(iso: string | null): string {
  if (!iso) return '–';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? DATE_FR.format(ms) : '–';
}

/** Max drawdown (positive number = SOL lost from the peak): « −0,35 SOL », « aucune ». */
export function formatDrawdown(sol: number | null): string {
  if (sol === null || !Number.isFinite(sol)) return '–';
  const loss = Math.abs(sol);
  return loss === 0 ? 'aucune' : `−${formatSolAmount(loss)} SOL`;
}

/** Profit factor; null with trades and no losing trade = infinite. */
function profitFactorText(m: LabMetrics): string {
  return m.profitFactor === null && m.trades > 0 && m.avgLossPct === null ? '∞ (aucune perte)' : formatProfitFactor(m.profitFactor);
}

/** « 1 min pour 20 % des détections, 5 min pour 40 %, 15 min seulement pour 30 %, aucune bougie pour 10 %. » */
export function resolutionText(d: DataVersion): string {
  const parts = [
    `1 min pour ${formatShare(d.share1m)} des détections`,
    `5 min pour ${formatShare(d.share5m)}`,
    `15 min seulement pour ${formatShare(d.share15mOnly)}`,
  ];
  if (d.shareNone !== null && d.shareNone > 0) parts.push(`aucune bougie pour ${formatShare(d.shareNone)}`);
  return `Résolution la plus fine des bougies : ${parts.join(', ')}.`;
}

export interface MetricLine {
  key: string;
  label: string;
  train: string;
  test: string;
  /** Sign of the test value for colouring (signed rows only). */
  testSign: -1 | 0 | 1 | null;
}

const sign = (n: number | null | undefined): -1 | 0 | 1 | null => (n == null || !Number.isFinite(n) ? null : n > 0 ? 1 : n < 0 ? -1 : 0);

/** Train vs test rows of a variant card. */
export function metricLines(train: LabMetrics | null, test: LabMetrics | null): MetricLine[] {
  const line = (key: string, label: string, f: (m: LabMetrics) => string, signed?: (m: LabMetrics) => number | null): MetricLine => ({
    key,
    label,
    train: train ? f(train) : '–',
    test: test ? f(test) : '–',
    testSign: signed && test ? sign(signed(test)) : null,
  });
  return [
    line('trades', 'Trades', (m) => formatInt(m.trades)),
    line('win', 'Taux de gain', (m) => (m.winRate === null ? '–' : formatPercentFr(m.winRate * 100))),
    line('net', 'Gain moyen net', (m) => formatSignedPercentFr(m.avgNetPct), (m) => m.avgNetPct),
    line('sol', 'En SOL (mise 0,1)', (m) => formatSignedSol(m.avgNetSol), (m) => m.avgNetSol),
    line('pf', 'Profit factor', profitFactorText),
    line('dd', 'Perte max depuis sommet', (m) => formatDrawdown(m.maxDrawdownSol)),
    line('streak', 'Pire série perdante', (m) => (m.worstLosingStreak === null ? '–' : `${formatInt(m.worstLosingStreak)} trades`)),
  ];
}
