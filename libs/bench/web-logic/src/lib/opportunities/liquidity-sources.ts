// Cross-source liquidity shown by the liquidity info panel.
// Used sources: DexScreener and GeckoTerminal (median). Jupiter: shown in this tooltip only (archived column, may be
// null), never used in a calculation or a label.
import type { TokenRow } from '../models/token';
import { retainedLiquidity } from './token-display';

export type LiquiditySourceId = 'dex' | 'gecko' | 'jup';

export interface LiquiditySource {
  id: LiquiditySourceId;
  label: string;
  /** null = unknown (missing, zero or not finite). */
  value: number | null;
  /** 'scored': enters the effective liquidity; 'control': shown for comparison only (Jupiter). */
  role: 'scored' | 'control';
  /** A scored source with a usable value: part of the median. */
  used: boolean;
}

export interface LiquiditySummary {
  /** Liquidity displayed: liquidity_effective_usd, else the median of DexScreener / GeckoTerminal. */
  effective: number;
  /** DexScreener, GeckoTerminal, then Jupiter (control). */
  sources: LiquiditySource[];
  /** 'median' (both scored sources usable), 'single' (one), 'none'. */
  method: 'median' | 'single' | 'none';
  /** Divergence in PERCENT (column is a fraction), null when unknown. */
  divergencePct: number | null;
  /** Divergence above 50 %. */
  incoherent: boolean;
}

export const INCOHERENT_DIVERGENCE = 0.5;

type LiquidityColumns = Pick<
  TokenRow,
  'liquidity_usd' | 'liquidity_jup_usd' | 'liquidity_dex_usd' | 'liquidity_gecko_usd' | 'liquidity_effective_usd' | 'liquidity_divergence'
>;

const usable = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

export function effectiveLiquidity(t: LiquidityColumns): number {
  const e = t.liquidity_effective_usd;
  return typeof e === 'number' && Number.isFinite(e) && e >= 0 ? e : retainedLiquidity(t);
}

export function liquiditySummary(t: LiquidityColumns): LiquiditySummary {
  const dex = usable(t.liquidity_dex_usd) ?? usable(t.liquidity_usd);
  const gecko = usable(t.liquidity_gecko_usd);
  const sources: LiquiditySource[] = [
    { id: 'dex', label: 'DexScreener', value: dex, role: 'scored', used: dex !== null },
    { id: 'gecko', label: 'GeckoTerminal', value: gecko, role: 'scored', used: gecko !== null },
    { id: 'jup', label: 'Jupiter', value: usable(t.liquidity_jup_usd), role: 'control', used: false },
  ];
  const usedCount = sources.filter((s) => s.used).length;
  const d = t.liquidity_divergence;
  const divergence = typeof d === 'number' && Number.isFinite(d) && d >= 0 ? d : null;
  return {
    effective: effectiveLiquidity(t),
    sources,
    method: usedCount === 2 ? 'median' : usedCount === 1 ? 'single' : 'none',
    divergencePct: divergence === null ? null : divergence * 100,
    incoherent: divergence !== null && divergence > INCOHERENT_DIVERGENCE,
  };
}

/** One-line explanation of how the displayed value was obtained. */
export function liquidityMethodText(summary: LiquiditySummary): string {
  switch (summary.method) {
    case 'median':
      return 'Valeur retenue : médiane de DexScreener et GeckoTerminal.';
    case 'single': {
      const used = summary.sources.find((s) => s.used);
      return `Valeur retenue : ${used?.label ?? 'une seule source'} (seule source exploitable).`;
    }
    default:
      return 'Aucune source exploitable.';
  }
}

/** Field label: says when the value is a median of two sources or comes from GeckoTerminal alone. */
export function liquidityLabel(summary: LiquiditySummary): string {
  if (summary.method === 'median') return 'Liquidité (médiane 2 sources)';
  const used = summary.sources.find((s) => s.used);
  return used && used.id !== 'dex' ? `Liquidité (${used.label})` : 'Liquidité';
}
