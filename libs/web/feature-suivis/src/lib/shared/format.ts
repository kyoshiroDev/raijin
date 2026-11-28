import { ALERT_TYPE_LABELS, VERDICT_LABELS, type Alert, type TokenMetadata } from '@raijin/shared-contracts';
import { formatCompactAmount, truncateMiddle } from '@raijin/shared-util';

const NBSP = '\u00a0';
let shortDate: Intl.DateTimeFormat | null = null;
let fullDate: Intl.DateTimeFormat | null = null;
let decimal: Intl.NumberFormat | null = null;

/** Pourcentage déjà exprimé en % (0–100) : `42.5` → `42,5 %`. */
export function formatPct(value: number): string {
  decimal ??= new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  return `${decimal.format(value)}${NBSP}%`;
}

/** Date complète (attribut `title`) : « 22 nov. 2026 à 11:00 ». */
export function formatFullDate(iso: string): string {
  fullDate ??= new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return fullDate.format(new Date(iso)).replace(/\u202f/g, NBSP);
}

/** Temps écoulé, court et factuel : « à l’instant », « il y a 12 min », « il y a 3 h », « le 18 nov. ». */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes}${NBSP}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours}${NBSP}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return days === 1 ? 'hier' : `il y a ${days}${NBSP}jours`;
  shortDate ??= new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
  return `le ${shortDate.format(new Date(iso))}`;
}

/** Nom affiché d'un token (texte non fiable, rendu par interpolation) ou adresse tronquée. */
export function tokenLabel(token: Pick<TokenMetadata, 'name' | 'symbol'> | null, mint: string): string {
  return token?.name || token?.symbol || truncateMiddle(mint, 4, 4);
}

/** Symbole affiché à côté du nom (seulement si le nom existe aussi). */
export function tokenSymbol(token: Pick<TokenMetadata, 'name' | 'symbol'> | null): string | null {
  return token?.name && token.symbol ? token.symbol : null;
}

export function alertTitle(alert: Alert): string {
  return ALERT_TYPE_LABELS[alert.type];
}

const usd = (value: number | null) => (value === null ? null : formatCompactAmount(value, '$'));

/** Phrase factuelle d'une alerte : ce qui a été mesuré, sans urgence ni conseil. */
export function alertSentence(alert: Alert): string {
  switch (alert.type) {
    case 'lp_removed': {
      const { dropPct, liquidityUsdBefore, liquidityUsdAfter } = alert.payload;
      const before = usd(liquidityUsdBefore);
      const after = usd(liquidityUsdAfter);
      const amounts = before && after ? ` (${before}${NBSP}→${NBSP}${after})` : '';
      return `La liquidité du pool principal a baissé de ${formatPct(dropPct)} par rapport à son plus haut des dernières heures${amounts}.`;
    }
    case 'verdict_degraded':
      return `Le verdict est passé de ${VERDICT_LABELS[alert.payload.from]} à ${VERDICT_LABELS[alert.payload.to]} lors de la dernière revérification.`;
    case 'mint_reactivated':
      return 'L’autorité de mint est de nouveau active : le créateur peut créer de nouveaux tokens.';
    case 'freeze_reactivated':
      return 'L’autorité de freeze est de nouveau active : le créateur peut geler des comptes.';
    case 'holder_sold': {
      const { beforePct, afterPct, soldPctOfPosition } = alert.payload;
      const head = `Un holder qui détenait ${formatPct(beforePct)} de l’offre a cédé ${formatPct(soldPctOfPosition)} de sa position (vente ou transfert)`;
      return afterPct === null ? `${head} : il est sorti du top 20 des holders.` : `${head} : il en détient maintenant ${formatPct(afterPct)}.`;
    }
  }
}
