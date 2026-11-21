// 7-day simulated result of the user's single alerts (pure, no API call).
// Per single alert with an entry price: first_hit 'target' → target/entry − 1, 'stop' → stop/entry − 1,
// otherwise mark-to-market last_price/entry − 1 (« en cours »). The round-trip cost is subtracted:
// estimated for the stake from entry_roundtrip_pct (0.1 SOL quote), or assumed at 3 % when unknown.
import { formatSignedPercentFr } from '../../shared/utils/format';
import { DEFAULT_STAKE_SOL, formatSol, isValidStake } from '../../shared/utils/stake';
import { estimateRoundtripPct } from '../opportunities/roundtrip';
import type { AlertLogRow } from './alert-log';
import { alertPlan } from './alert-view';

export const SIMULATION_WINDOW_MS = 7 * 24 * 3_600_000;
/** Round-trip cost assumed (PERCENT) when the alert has no quote. */
export const ASSUMED_ROUNDTRIP_PCT = 3;

export type SimulatedOutcome = 'target' | 'stop' | 'open';

export interface SimulatedTrade {
  id: number;
  outcome: SimulatedOutcome;
  stakeSol: number;
  /** Price return before costs (fraction, e.g. 0.2). */
  grossReturn: number;
  /** Round-trip cost subtracted (PERCENT). */
  costPct: number;
  /** True when the cost was assumed (no quote stored with the alert). */
  costAssumed: boolean;
  /** grossReturn − costPct / 100. */
  netReturn: number;
  pnlSol: number;
}

export interface AlertSimulation {
  /** Every alert (single and grouped) sent in the window. */
  alerts: number;
  /** Single alerts with an entry price (the simulated ones). */
  trades: SimulatedTrade[];
  targets: number;
  stops: number;
  open: number;
  pnlSol: number;
  /** Mean net return in PERCENT; null without any trade. */
  avgNetPct: number | null;
  /** At least one cost was assumed at 3 %. */
  feesAssumed: boolean;
  /** Stake used when every trade used the same one, otherwise null (mixed fallbacks). */
  stakeSol: number | null;
}

export interface SimulationOptions {
  now: number;
  /** The user's stake (UserPreferences.stakeSol()); invalid/null → alert_log.stake_sol → 0.05 SOL (DEFAULT_STAKE_SOL). */
  stakeSol: number | null;
}

export function isInWindow(sentAt: string, now: number, windowMs = SIMULATION_WINDOW_MS): boolean {
  const t = Date.parse(sentAt);
  return Number.isFinite(t) && t <= now && now - t <= windowMs;
}

function stakeFor(row: AlertLogRow, userStake: number | null): number {
  if (isValidStake(userStake)) return userStake;
  if (isValidStake(row.stake_sol)) return row.stake_sol;
  return DEFAULT_STAKE_SOL;
}

/** Null for grouped alerts and for alerts without an entry price. */
export function simulateAlert(row: AlertLogRow, userStake: number | null): SimulatedTrade | null {
  const entry = row.entry_price;
  if (row.kind !== 'single' || entry === null) return null;
  // Server values first; the ×2 / ×0.7 rule only fills a missing column.
  const plan = alertPlan(row);
  const target = plan?.target ?? entry;
  const stop = plan?.stop ?? entry;
  const outcome: SimulatedOutcome = row.first_hit ?? 'open';
  const exit = outcome === 'target' ? target : outcome === 'stop' ? stop : (row.last_price ?? entry);
  const grossReturn = exit / entry - 1;
  const stakeSol = stakeFor(row, userStake);
  const estimated = estimateRoundtripPct({ roundtrip_cost_pct: row.entry_roundtrip_pct, roundtrip_fee_pct: null }, stakeSol);
  const costPct = estimated ?? ASSUMED_ROUNDTRIP_PCT;
  const netReturn = grossReturn - costPct / 100;
  return { id: row.id, outcome, stakeSol, grossReturn, costPct, costAssumed: estimated === null, netReturn, pnlSol: stakeSol * netReturn };
}

export function simulateAlerts(rows: readonly AlertLogRow[], opts: SimulationOptions): AlertSimulation {
  const inWindow = rows.filter((r) => isInWindow(r.sent_at, opts.now));
  const trades = inWindow.map((r) => simulateAlert(r, opts.stakeSol)).filter((t): t is SimulatedTrade => t !== null);
  const count = (o: SimulatedOutcome) => trades.filter((t) => t.outcome === o).length;
  const stakes = new Set(trades.map((t) => t.stakeSol));
  return {
    alerts: inWindow.length,
    trades,
    targets: count('target'),
    stops: count('stop'),
    open: count('open'),
    pnlSol: trades.reduce((sum, t) => sum + t.pnlSol, 0),
    avgNetPct: trades.length ? (trades.reduce((sum, t) => sum + t.netReturn, 0) / trades.length) * 100 : null,
    feesAssumed: trades.some((t) => t.costAssumed),
    stakeSol: stakes.size === 1 ? [...stakes][0] : null,
  };
}

const SIGNED_SOL = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 3 });

/** « +0,012 SOL » / « −0,3 SOL » (U+2212) / « 0 SOL ». */
export function formatSignedSol(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  if (!Number.isFinite(rounded) || rounded === 0) return '0 SOL';
  return `${rounded > 0 ? '+' : '−'}${SIGNED_SOL.format(Math.abs(rounded))} SOL`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** « 7 derniers jours : 5 alertes · 2 objectifs · 1 stop · résultat simulé pour ma mise : +0,012 SOL (frais inclus) » */
export function simulationHeadline(s: AlertSimulation): string {
  return [
    `7 derniers jours : ${plural(s.alerts, 'alerte', 'alertes')}`,
    plural(s.targets, 'objectif', 'objectifs'),
    plural(s.stops, 'stop', 'stops'),
    `résultat simulé pour ma mise : ${formatSignedSol(s.pnlSol)} (frais inclus)`,
  ].join(' · ');
}

/** Detail line: per-outcome counts, average net %, stake and fee assumption. */
export function simulationDetail(s: AlertSimulation): string {
  if (s.trades.length === 0) return 'Aucune alerte simple avec un prix d’entrée sur la période.';
  const parts = [
    `${plural(s.trades.length, 'alerte simulée', 'alertes simulées')} : ${s.targets} objectif · ${s.stops} stop · ${s.open} en cours`,
    `moyenne nette ${formatSignedPercentFr(s.avgNetPct)}`,
    s.stakeSol !== null ? `mise ${formatSol(s.stakeSol)} SOL par alerte` : 'mise par alerte',
    s.feesAssumed ? 'frais aller-retour inclus (frais estimés à 3 % quand inconnus)' : 'frais aller-retour inclus',
  ];
  return parts.join(' · ');
}
