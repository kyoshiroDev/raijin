// Display helpers of the portfolio screen (pure).
import type { LegStatus, PositionStatus } from '../models/paper';

export const STATUS_LABEL: Record<PositionStatus, string> = {
  pending: 'En attente',
  open: 'Ouverte',
  closed: 'Clôturée',
  expired: 'Expirée',
  cancelled: 'Annulée',
};

export const STATUS_CLASS: Record<PositionStatus, string> = {
  pending: 'bg-surface-2 text-muted',
  open: 'bg-info/15 text-info',
  closed: 'bg-surface-2 text-fg',
  expired: 'bg-surface-2 text-muted',
  cancelled: 'bg-surface-2 text-muted',
};

export const LEG_LABEL: Record<LegStatus, string> = {
  open: 'ouverte',
  tp_hit: 'TP touché',
  sl_hit: 'SL',
  breakeven_hit: 'breakeven',
};

export const LEG_CLASS: Record<LegStatus, string> = {
  open: 'bg-info/15 text-info',
  tp_hit: 'bg-bull/15 text-bull',
  sl_hit: 'bg-bear/15 text-bear',
  breakeven_hit: 'bg-warn/15 text-warn',
};

const DATE_FR = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Paris',
});

/** « 17 nov., 18:58 » (Paris time); '–' when missing or invalid. */
export function formatDateTimeFr(iso: string | null | undefined): string {
  if (!iso) return '–';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? DATE_FR.format(ms) : '–';
}

/** Text colour of a signed amount. */
export function pnlClass(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v === 0) return 'text-muted';
  return v > 0 ? 'text-bull' : 'text-bear';
}
