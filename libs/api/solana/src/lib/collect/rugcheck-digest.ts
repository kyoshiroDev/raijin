import { sanitizeUntrustedText } from '@raijin/shared-util';
import type { RugCheckReport } from '../clients/rugcheck';
import { RUGCHECK_EXCLUDED_TYPES } from '../known-accounts';

/**
 * Condensé d'un rapport RugCheck : seules les données utiles sont gardées (et mises en cache),
 * les textes externes sont nettoyés et bornés dès la collecte (ARCHITECTURE.md §9.8).
 */
export interface RugCheckDigest {
  readonly complete: boolean;
  readonly scoreNormalised: number | null;
  readonly rugged: boolean | null;
  readonly risks: ReadonlyArray<{ readonly name: string; readonly level: 'info' | 'warn' | 'danger' }>;
  /** Part de LP brûlée/verrouillée du marché principal (%), ou `null`. */
  readonly lpBurnedOrLockedPct: number | null;
  readonly marketCount: number;
  /** Adresses de pools (comptes AMM connus de RugCheck + marchés). */
  readonly poolAccounts: readonly string[];
  /** Comptes de token des coffres des marchés (exclus de la concentration). */
  readonly vaultTokenAccounts: readonly string[];
  readonly topHolders: ReadonlyArray<{ readonly address: string; readonly owner: string; readonly pct: number }>;
  readonly creator: string | null;
  readonly creatorTokens: ReadonlyArray<{ readonly mint: string; readonly marketCap: number | null; readonly createdAt: string | null }>;
  readonly pumpBondingCurve: boolean;
  readonly metadata: { readonly mutable: boolean | null; readonly name: string | null; readonly symbol: string | null };
}

const LEVEL_RANK = { danger: 0, warn: 1, info: 2 } as const;

export function clampPct(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function cleanText(value: string | null | undefined, max: number): string | null {
  const cleaned = sanitizeUntrustedText(value ?? '', max);
  return cleaned === '' ? null : cleaned;
}

export function digestRugCheckReport(report: RugCheckReport): RugCheckDigest {
  const markets = report.markets ?? [];
  const ranked = [...markets].sort(
    (a, b) => (b.lp?.baseUSD ?? 0) + (b.lp?.quoteUSD ?? 0) - ((a.lp?.baseUSD ?? 0) + (a.lp?.quoteUSD ?? 0)),
  );
  const main = ranked[0];
  const pumpBondingCurve = markets.some((market) => market.marketType === 'pump_fun');
  let lpPct: number | null;
  if (!report.complete) lpPct = clampPct(report.lpLockedPct);
  else if (main === undefined) lpPct = null;
  // Courbe de liaison pump.fun : la liquidité est détenue par le programme, le créateur ne peut pas la retirer.
  else if (main.marketType === 'pump_fun') lpPct = 100;
  else lpPct = clampPct(main.lp?.lpLockedPct);

  const knownPools = Object.entries(report.knownAccounts ?? {})
    .filter(([, value]) => value.type !== undefined && RUGCHECK_EXCLUDED_TYPES.has(value.type))
    .map(([key]) => key);

  const risks = (report.risks ?? [])
    .map((risk): { name: string; level: 'info' | 'warn' | 'danger' } => ({
      name: cleanText(risk.name, 80) ?? 'Risque sans nom',
      level: risk.level === 'danger' || risk.level === 'warn' ? risk.level : 'info',
    }))
    .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level])
    .slice(0, 20);

  return {
    complete: report.complete,
    scoreNormalised: clampPct(report.score_normalised),
    rugged: report.rugged ?? null,
    risks,
    lpBurnedOrLockedPct: lpPct,
    marketCount: markets.length,
    poolAccounts: [...new Set([...knownPools, ...markets.slice(0, 200).map((market) => market.pubkey)])],
    vaultTokenAccounts: markets
      .slice(0, 200)
      .flatMap((market) => [market.liquidityA, market.liquidityB])
      .filter((value): value is string => typeof value === 'string'),
    topHolders: (report.topHolders ?? []).slice(0, 50).map(({ address, owner, pct }) => ({ address, owner, pct })),
    creator: report.creator ?? null,
    creatorTokens: (report.creatorTokens ?? []).slice(0, 1_000).map(({ mint, marketCap, createdAt }) => ({
      mint,
      marketCap: marketCap ?? null,
      createdAt: createdAt ?? null,
    })),
    pumpBondingCurve,
    metadata: {
      mutable: report.tokenMeta?.mutable ?? null,
      name: cleanText(report.tokenMeta?.name, 64),
      symbol: cleanText(report.tokenMeta?.symbol, 16),
    },
  };
}
