// Pure display helpers shared by the token card, the detail panel and the /token/:mint page.
import type { DataConfidence, TokenRow } from '../models/token';
import { formatAge, formatCount, formatPct, formatPercentFr, formatPrice, formatUsd } from '../utils/format';
import { safeExternalUrl } from '../utils/safe-url';
import { isSolanaAddress } from '../utils/solana-address';

export type Tone = 'bull' | 'bear' | 'warn' | null;

export interface Stat {
  label: string;
  value: string;
  tone?: Tone;
  mono?: boolean;
}

export interface TokenLink {
  label: string;
  href: string;
}

const changeTone = (v: number | null | undefined): Tone => (v == null ? null : v > 0 ? 'bull' : v < 0 ? 'bear' : null);

/** null = unknown, true = mint AND freeze authorities disabled. */
export function authoritiesSafe(t: Pick<TokenRow, 'mint_authority_disabled' | 'freeze_authority_disabled'>): boolean | null {
  const { mint_authority_disabled: m, freeze_authority_disabled: f } = t;
  if (m == null || f == null) return null;
  return m && f;
}

function authorityStat(label: string, disabled: boolean | null): Stat {
  if (disabled == null) return { label, value: 'Inconnue' };
  return disabled ? { label, value: 'Désactivée', tone: 'bull' } : { label, value: 'Active', tone: 'bear' };
}

type LiquidityFields = Pick<TokenRow, 'liquidity_usd'> &
  Partial<Pick<TokenRow, 'liquidity_dex_usd' | 'liquidity_gecko_usd'>>;

const usableLiquidity = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Retained liquidity, used when liquidity_effective_usd is null: median of the usable
 * DexScreener (liquidity_dex_usd, else liquidity_usd) and GeckoTerminal values (2 → mean, 1 → that one, 0 → 0).
 * Mirrors effectiveLiquidity() of the legacy Edge Functions (_shared/consensus.ts, ported to the bench API). Jupiter never enters it (tooltip only).
 */
export function retainedLiquidity(t: LiquidityFields): number {
  const dex = usableLiquidity(t.liquidity_dex_usd) ? t.liquidity_dex_usd : t.liquidity_usd;
  const values = [dex, t.liquidity_gecko_usd].filter(usableLiquidity);
  if (values.length === 0) return 0;
  return values.length === 2 ? (values[0]! + values[1]!) / 2 : values[0]!;
}

/** Market stats of the detail (liquidity is rendered separately by <app-liquidity-info>). */
export function marketStats(t: TokenRow, now = Date.now()): Stat[] {
  return [
    { label: 'Prix', value: formatPrice(t.price_usd), mono: true },
    { label: 'Market cap', value: formatUsd(t.market_cap) },
    { label: 'Volume 24 h', value: formatUsd(t.volume_24h) },
    { label: 'Variation 1 h', value: formatPct(t.change_1h), tone: changeTone(t.change_1h) },
    { label: 'Variation 24 h', value: formatPct(t.change_24h), tone: changeTone(t.change_24h) },
    { label: 'Achats / ventes 1 h', value: `${formatCount(t.buys_1h)} / ${formatCount(t.sells_1h)}` },
    { label: 'Âge de la paire', value: formatAge(t.pair_created_at, now) },
  ];
}

export function securityStats(t: TokenRow): Stat[] {
  const top10 = t.top10_pct;
  const organic = t.organic_score;
  return [
    authorityStat('Autorité de mint', t.mint_authority_disabled),
    authorityStat('Autorité de gel', t.freeze_authority_disabled),
    { label: 'Top 10 holders', value: formatPercentFr(top10) },
    { label: 'Holders', value: formatCount(t.holder_count) },
    { label: 'Score organique', value: organic != null && Number.isFinite(organic) ? `${Math.round(organic)} / 100` : '–' },
  ];
}

export interface ConfidenceInfo {
  label: string;
  tone: 'bull' | 'warn' | 'bear';
  className: string;
}

export const CONFIDENCE_BADGE: Record<DataConfidence, ConfidenceInfo> = {
  high: { label: 'Données fiables', tone: 'bull', className: 'bg-bull/15 text-bull' },
  medium: { label: 'Données partielles', tone: 'warn', className: 'bg-warn/15 text-warn' },
  low: { label: 'Données peu fiables', tone: 'bear', className: 'bg-bear/15 text-bear' },
};

/** null (not enriched yet) → no badge. */
export function confidenceBadge(c: DataConfidence | null | undefined): ConfidenceInfo | null {
  return c ? (CONFIDENCE_BADGE[c] ?? null) : null;
}

const finiteOrNull = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** RugCheck numbers + buy impact (the danger labels are rendered as a list). */
export function rugcheckStats(t: Pick<TokenRow, 'lp_locked_pct' | 'rugcheck_score'>): Stat[] {
  const lp = t.lp_locked_pct;
  const score = t.rugcheck_score;
  return [
    { label: 'LP verrouillée', value: finiteOrNull(lp) ? `${Math.round(Math.min(100, Math.max(0, lp)))} %` : 'Inconnue' },
    { label: 'Score RugCheck', value: finiteOrNull(score) ? `${Math.round(score)}` : 'Inconnu' },
  ];
}

/** RugCheck insiders + creator history (null = unknown, never coloured). */
export function rugcheckHistoryStats(t: Pick<TokenRow, 'insiders_detected' | 'creator_rug_history'>): Stat[] {
  const insiders: Stat =
    t.insiders_detected == null
      ? { label: 'Insiders', value: 'Inconnu' }
      : t.insiders_detected
        ? { label: 'Insiders', value: 'Détectés', tone: 'bear' }
        : { label: 'Insiders', value: 'Aucun détecté', tone: 'bull' };
  const creator: Stat =
    t.creator_rug_history == null
      ? { label: 'Historique du créateur', value: 'Inconnu' }
      : t.creator_rug_history
        ? { label: 'Historique du créateur', value: 'Rugs passés signalés', tone: 'bear' }
        : { label: 'Historique du créateur', value: 'Rien de signalé', tone: 'bull' };
  return [insiders, creator];
}

export function buyImpactLabel(t: Pick<TokenRow, 'buy_impact_pct'>): string {
  return finiteOrNull(t.buy_impact_pct) ? formatPercentFr(Math.max(0, t.buy_impact_pct)) : 'inconnu';
}

/** Links are built only from validated addresses or allowlisted https URLs. Jupiter: token page (read-only), never a swap link. */
export function tokenLinks(t: TokenRow): TokenLink[] {
  const out: TokenLink[] = [];
  if (isSolanaAddress(t.pair_address)) out.push({ label: 'DexScreener', href: `https://dexscreener.com/solana/${t.pair_address}` });
  if (isSolanaAddress(t.mint)) {
    out.push({ label: 'Jupiter', href: `https://jup.ag/tokens/${t.mint}` });
    out.push({ label: 'RugCheck', href: `https://rugcheck.xyz/tokens/${t.mint}` });
  }
  const web = safeExternalUrl(t.website_url, 'website');
  const x = safeExternalUrl(t.x_url, 'x');
  const tg = safeExternalUrl(t.telegram_url, 'telegram');
  if (web) out.push({ label: 'Site web', href: web });
  if (x) out.push({ label: 'X', href: x });
  if (tg) out.push({ label: 'Telegram', href: tg });
  return out;
}

/** « Narratif GTA · n°2 », « Narratif GTA », or null without a narrative. The label is hostile text (already sanitised). */
export function narrativeLabel(t: Pick<TokenRow, 'narrative' | 'narrative_rank'>): string | null {
  if (!t.narrative) return null;
  return t.narrative_rank !== null ? `Narratif ${t.narrative} · n°${t.narrative_rank}` : `Narratif ${t.narrative}`;
}
