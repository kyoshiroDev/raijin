import type { TokenAmount, TokenMetadata, WalletTokenAssessment, WalletUnavailableReason } from '@raijin/shared-contracts';
import { formatCompactAmount, formatExactAmount, truncateMiddle } from '@raijin/shared-util';

const NBSP = '\u00a0';
/** Plus grand u64 : approbation « illimitée » (montant maximal). */
const U64_MAX = '18446744073709551615';
/** Nombre total de contrôles d'une analyse complète. */
export const TOTAL_CHECKS = 9;

/** Nom affiché d'un token (texte non fiable, rendu par interpolation) ou adresse tronquée. */
export function tokenLabel(token: Pick<TokenMetadata, 'name' | 'symbol'> | null, mint: string): string {
  return token?.name || token?.symbol || truncateMiddle(mint, 4, 4);
}

/** Symbole affiché à côté du nom (seulement si le nom existe aussi). */
export function tokenSymbol(token: Pick<TokenMetadata, 'name' | 'symbol'> | null): string | null {
  return token?.name && token.symbol ? token.symbol : null;
}

/** Le créateur a publié un nom ou un symbole. */
export function hasName(token: Pick<TokenMetadata, 'name' | 'symbol'> | null): boolean {
  return Boolean(token?.name || token?.symbol);
}

/**
 * Montant décimal exact (chaîne `ui` du contrat) au format français, sans perte de précision :
 * `"1234567.891"` → `1 234 567,891`.
 */
export function formatExactUi(ui: string): string {
  const [integer = '0', fraction = ''] = ui.split('.');
  const grouped = integer.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return fraction ? `${grouped},${fraction}` : grouped;
}

export interface AmountDisplay {
  /** Texte court (`1,2 M`), ou `Illimité` pour une approbation maximale. */
  readonly short: string;
  /** Valeur exacte (attribut `title`). */
  readonly exact: string;
  readonly unlimited: boolean;
}

/** Montant de token : compact à l'écran, exact en `title`. */
export function formatAmount(amount: TokenAmount, symbol: string | null = null): AmountDisplay {
  const suffix = symbol ? `${NBSP}${symbol}` : '';
  const exact = `${formatExactUi(amount.ui)}${suffix}`;
  if (amount.raw === U64_MAX) return { short: 'Illimité', exact: `${exact} (montant maximal)`, unlimited: true };
  const value = Number(amount.ui);
  if (value > 0 && value < 0.1) return { short: `<${NBSP}0,1${suffix}`, exact, unlimited: false };
  return { short: `${formatCompactAmount(value, '')}${suffix}`, exact, unlimited: false };
}

export interface UsdDisplay {
  readonly short: string;
  readonly exact: string | null;
}

/** Valeur indicative en USD ; `null` = prix inconnu. */
export function formatUsd(value: number | null): UsdDisplay {
  if (value === null) return { short: 'Inconnue', exact: null };
  if (value > 0 && value < 0.01) return { short: `<${NBSP}0,01${NBSP}$`, exact: formatExactAmount(value, '$') };
  return { short: `≈${NBSP}${formatCompactAmount(value, '$')}`, exact: formatExactAmount(value, '$') };
}

/** Profondeur du verdict : « Contrôle rapide (6/9) » ou « Analyse complète (9/9) ». */
export function coverageText(assessment: Extract<WalletTokenAssessment, { status: 'analyzed' }>): string {
  const depth = `(${assessment.checksEvaluated}/${TOTAL_CHECKS})`;
  return assessment.coverage === 'light' ? `Contrôle rapide ${depth}` : `Analyse complète ${depth}`;
}

const UNAVAILABLE_TEXTS: Readonly<Record<WalletUnavailableReason, string>> = {
  upstream: 'Une source de données n’a pas répondu pour ce token. Ouvre son analyse complète pour réessayer.',
  timeout: 'Le scan a atteint sa durée maximale avant d’analyser ce token. Ouvre son analyse complète.',
  budget: 'La capacité d’analyse du jour est atteinte pour les scans. Ouvre son analyse complète.',
  unanalyzable: 'Raijin ne sait pas analyser ce compte (format de token non pris en charge).',
};

/** Libellé court (icône + mot) et explication d'un token sans verdict. */
export function assessmentStatus(assessment: Exclude<WalletTokenAssessment, { status: 'analyzed' }>, analyzedMax: number): { label: string; text: string } {
  if (assessment.status === 'unavailable') return { label: 'Indisponible', text: UNAVAILABLE_TEXTS[assessment.reason] };
  if (assessment.reason === 'dust') {
    return { label: 'Non analysé', text: 'Valeur très faible (poussière) : Raijin ne l’analyse pas dans le scan.' };
  }
  const limit = analyzedMax > 0 ? `les ${analyzedMax} tokens de plus forte valeur` : 'les tokens de plus forte valeur';
  return { label: 'Non analysé', text: `Le scan analyse ${limit}. Ouvre son analyse complète pour celui-ci.` };
}

/** « 3 tokens », « 1 token », « 0 token ». */
export function plural(count: number, word: string, pluralWord = `${word}s`): string {
  return `${count}${NBSP}${count > 1 ? pluralWord : word}`;
}

let timeFormat: Intl.DateTimeFormat | null = null;

/** Heure du scan : « 22 nov. à 11:00 ». */
export function formatScanTime(iso: string): string {
  timeFormat ??= new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return timeFormat.format(new Date(iso)).replace(/\u202f/g, NBSP);
}
