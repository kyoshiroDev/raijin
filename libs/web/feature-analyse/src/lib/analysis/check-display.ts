import type { AnalysisCheck, CheckMetric, CheckStatus } from '@raijin/shared-contracts';
import {
  formatCompactAmount,
  formatExactAmount,
  formatPercent,
  isAllowedHttpsUrl,
  truncateMiddle,
} from '@raijin/shared-util';
import type { RjIconName } from '@raijin/web-ui';
import { CHECK_STATUS_LABELS, EXTERNAL_LINK_HOSTS } from './labels';

export interface CheckStatusDisplay {
  readonly label: string;
  readonly icon: RjIconName;
  /** Couleur du texte et de l'icône (jamais seule : toujours avec l'icône et le mot). */
  readonly text: string;
  /** Pastille de l'icône. */
  readonly chip: string;
}

/** Statut d'un contrôle : icône + mot, couleur fonctionnelle. */
export const CHECK_STATUS_DISPLAY: Readonly<Record<CheckStatus, CheckStatusDisplay>> = {
  ok: { label: CHECK_STATUS_LABELS.ok, icon: 'circleCheck', text: 'text-safe', chip: 'border-safe/30 bg-safe/10 text-safe' },
  warn: { label: CHECK_STATUS_LABELS.warn, icon: 'warn', text: 'text-warn', chip: 'border-warn/30 bg-warn/10 text-warn' },
  danger: { label: CHECK_STATUS_LABELS.danger, icon: 'danger', text: 'text-danger', chip: 'border-danger/30 bg-danger/10 text-danger' },
  unavailable: {
    label: CHECK_STATUS_LABELS.unavailable,
    icon: 'unavailable',
    text: 'text-ink-muted',
    chip: 'border-line-strong bg-surface-raised text-ink-muted',
  },
};

export interface FormattedMetric {
  /** Valeur affichée (compacte). */
  readonly text: string;
  /** Valeur exacte, pour l'attribut `title` et les lecteurs d'écran. */
  readonly exact: string;
  /** Valeur absente : affichée en gris. */
  readonly missing: boolean;
  /** Valeur chiffrée ou adresse : police mono. */
  readonly mono: boolean;
}

const NBSP = '\u00a0';
const exactNumber = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });

function plain(value: number): string {
  return exactNumber.format(value).replace(/\u202f/g, NBSP);
}

function duration(value: number, unit: 'days' | 'hours'): FormattedMetric {
  const short = unit === 'days' ? 'j' : 'h';
  const long = unit === 'days' ? (value >= 2 ? 'jours' : 'jour') : value >= 2 ? 'heures' : 'heure';
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return { text: `${plain(rounded)}${NBSP}${short}`, exact: `${plain(value)}${NBSP}${long}`, missing: false, mono: true };
}

/** Formate une valeur de contrôle selon son unité (montants compacts, valeur exacte en `title`). */
export function formatMetric(metric: CheckMetric): FormattedMetric {
  const { value, unit } = metric;
  if (value === null) {
    return { text: 'Indisponible', exact: 'Valeur indisponible', missing: true, mono: false };
  }
  if (typeof value === 'boolean') {
    return { text: value ? 'Oui' : 'Non', exact: value ? 'Oui' : 'Non', missing: false, mono: false };
  }
  if (typeof value === 'string') {
    return unit === 'address'
      ? { text: truncateMiddle(value), exact: value, missing: false, mono: true }
      : { text: value, exact: value, missing: false, mono: false };
  }
  switch (unit) {
    case 'usd':
      return { text: formatCompactAmount(value, '$'), exact: formatExactAmount(value, '$'), missing: false, mono: true };
    case 'percent':
      return { text: formatPercent(value / 100), exact: `${plain(value)}${NBSP}%`, missing: false, mono: true };
    case 'sol':
      return { text: `${formatCompactAmount(value, '')}${NBSP}SOL`, exact: formatExactAmount(value, 'SOL'), missing: false, mono: true };
    case 'days':
    case 'hours':
      return duration(value, unit);
    case 'count':
    default:
      return { text: formatCompactAmount(value, ''), exact: plain(value), missing: false, mono: true };
  }
}

/** Lien de source affichable : `https://` et domaine de la liste blanche, sinon `null`. */
export function safeSourceUrl(url: string | null): string | null {
  return url !== null && isAllowedHttpsUrl(url, EXTERNAL_LINK_HOSTS) ? url : null;
}

/** Nombre de contrôles par statut, dans l'ordre d'affichage (statuts absents omis). */
export function statusCounts(checks: readonly AnalysisCheck[]): { status: CheckStatus; count: number }[] {
  const order: CheckStatus[] = ['danger', 'warn', 'ok', 'unavailable'];
  return order
    .map((status) => ({ status, count: checks.filter((check) => check.status === status).length }))
    .filter((entry) => entry.count > 0);
}

/** Nom affichable du token (texte non fiable, rendu uniquement par interpolation). */
export function tokenDisplayName(token: { name: string | null; symbol: string | null }, mint: string): string {
  return token.name || token.symbol || truncateMiddle(mint);
}
