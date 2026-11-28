// Pure display helpers for an alert row (outcome badge, outcome line and price cells).
import { formatPrice, formatSignedPercentFr, formatUpdatedAgo } from '../utils/format';
import type { AlertLogRow } from './alert-log';

export type AlertStatus = 'target' | 'stop' | 'open' | 'ended';

/** Icons of the outcome badge (names of the app's icon set; the app checks them against `IconName`). */
export type AlertIcon = 'arrow-up' | 'arrow-down' | 'clock' | 'check';

/** Exit plan of the « Jeune calme » alerts (backend YOUNG_CALM_RULES): target ×2, stop ×0.7. */
export const ALERT_TARGET_MULTIPLE = 2;
export const ALERT_STOP_MULTIPLE = 0.7;

export interface AlertPlan {
  target: number;
  stop: number;
}

/**
 * Target / stop of an alert: the stored columns first (alert_log.target_price / stop_price, whatever plan was used at
 * the time); a missing one is filled with the current ×2 / ×0.7 rule. Null when the entry price is unknown.
 */
export function alertPlan(row: Pick<AlertLogRow, 'entry_price' | 'target_price' | 'stop_price'>): AlertPlan | null {
  const entry = row.entry_price;
  if (entry === null || !(entry > 0)) return null;
  return { target: row.target_price ?? entry * ALERT_TARGET_MULTIPLE, stop: row.stop_price ?? entry * ALERT_STOP_MULTIPLE };
}

export interface AlertStatusView {
  label: string;
  /** Pill colours (theme tokens); the label and icon carry the meaning, never the colour alone. */
  className: string;
  icon: AlertIcon;
}

export const ALERT_STATUS: Record<AlertStatus, AlertStatusView> = {
  target: { label: 'Objectif touché', className: 'bg-bull/15 text-bull', icon: 'arrow-up' },
  stop: { label: 'Stop touché', className: 'bg-bear/15 text-bear', icon: 'arrow-down' },
  open: { label: 'En cours', className: 'bg-surface-2 text-muted', icon: 'clock' },
  ended: { label: 'Suivi terminé', className: 'bg-surface-2 text-muted', icon: 'check' },
};

/** First hit wins (even after the end of tracking); otherwise « Suivi terminé » once tracking_until is past. */
export function alertStatus(row: Pick<AlertLogRow, 'first_hit' | 'tracking_until'>, now: number): AlertStatus {
  if (row.first_hit) return row.first_hit;
  const until = row.tracking_until ? Date.parse(row.tracking_until) : Number.NaN;
  return Number.isFinite(until) && now > until ? 'ended' : 'open';
}

export interface AlertCell {
  label: string;
  value: string;
  /** Second line (% from entry, age of the price). */
  sub: string | null;
  tone: 'bull' | 'bear' | null;
}

const pctFrom = (price: number | null, entry: number | null): string | null =>
  price !== null && entry !== null ? formatSignedPercentFr((price / entry - 1) * 100) : null;

const joinParts = (...parts: (string | null)[]): string | null => parts.filter((p) => p !== null).join(' · ') || null;

/** « il y a 3 min » / « à l’instant »; null when unknown. */
export function priceAge(at: string | null, now: number): string | null {
  if (!at || !Number.isFinite(Date.parse(at))) return null;
  return formatUpdatedAgo(at, now, '').trim();
}

/** Six cells: price at alert, highest, lowest, current, target, stop. */
export function alertCells(row: AlertLogRow, now: number): AlertCell[] {
  const entry = row.entry_price;
  const plan = alertPlan(row);
  const target = plan?.target ?? row.target_price;
  const stop = plan?.stop ?? row.stop_price;
  return [
    { label: 'Prix à l’alerte', value: formatPrice(entry), sub: null, tone: null },
    { label: 'Plus haut', value: formatPrice(row.max_price), sub: pctFrom(row.max_price, entry), tone: null },
    { label: 'Plus bas', value: formatPrice(row.min_price), sub: pctFrom(row.min_price, entry), tone: null },
    { label: 'Prix actuel', value: formatPrice(row.last_price), sub: joinParts(pctFrom(row.last_price, entry), priceAge(row.last_price_at, now)), tone: null },
    { label: 'Objectif', value: formatPrice(target), sub: pctFrom(target, entry), tone: 'bull' },
    { label: 'Stop', value: formatPrice(stop), sub: pctFrom(stop, entry), tone: 'bear' },
  ];
}

const MULTIPLE_FR = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** « ×1,10 » (price / entry, 2 decimals); null when either price is unknown. */
export function formatMultiple(price: number | null, entry: number | null): string | null {
  if (price === null || entry === null || !(entry > 0)) return null;
  const m = price / entry;
  return Number.isFinite(m) ? `×${MULTIPLE_FR.format(m)}` : null;
}

const priceWithMultiple = (price: number | null, entry: number): string => {
  const multiple = formatMultiple(price, entry);
  return multiple === null ? formatPrice(price) : `${formatPrice(price)} (${multiple})`;
};

/**
 * « $2.000 → plus haut $2.200 (×1,10) → actuel $2.100 (×1,05) » from the alert's own columns
 * (entry_price, max_price, last_price). Null when the plan was not stored (legacy row).
 */
export function alertOutcomeLine(row: Pick<AlertLogRow, 'entry_price' | 'max_price' | 'last_price'>): string | null {
  const entry = row.entry_price;
  if (entry === null) return null;
  return `${formatPrice(entry)} → plus haut ${priceWithMultiple(row.max_price, entry)} → actuel ${priceWithMultiple(row.last_price, entry)}`;
}
