import {
  analysisResultSchema,
  DATA_SOURCE_NAMES,
  type AnalysisCheckId,
  type AnalysisResult,
  type DataSourceId,
  type DataSourceRef,
  type RiskAssessment,
} from '@raijin/shared-contracts';
import { buildCheckMetrics, explainVerdict, summarizeCheck } from '@raijin/shared-risk-engine';
import type { CollectedFacts } from '../ports/facts-collector';

/**
 * Liens vers les pages publiques des sources, construits par Raijin à partir de gabarits fixes
 * (jamais une URL fournie par une source) et revalidés par `externalUrlSchema` au parse du résultat.
 * Helius et le RPC public n'ont pas de page publique : lien `null`.
 */
export function sourceUrl(source: DataSourceId, mint: string): string | null {
  const id = encodeURIComponent(mint);
  switch (source) {
    case 'dexscreener':
      return `https://dexscreener.com/solana/${id}`;
    case 'geckoterminal':
      return `https://www.geckoterminal.com/solana/tokens/${id}`;
    case 'jupiter':
      return `https://jup.ag/tokens/${id}`;
    case 'rugcheck':
      return `https://rugcheck.xyz/tokens/${id}`;
    case 'helius':
    case 'solana_rpc':
      return null;
  }
}

/** Sources citées par contrôle ; `rpc` = Helius si la clé est utilisée, sinon RPC public. */
const CHECK_SOURCES: Readonly<Record<AnalysisCheckId, readonly (DataSourceId | 'rpc')[]>> = {
  mint_authority: ['rpc'],
  freeze_authority: ['rpc'],
  liquidity: ['dexscreener', 'geckoterminal'],
  holder_concentration: ['rpc'],
  sell_simulation: ['jupiter'],
  metadata_mutable: ['rpc'],
  token_age: ['rpc', 'dexscreener'],
  creator_history: ['helius'],
  rugcheck: ['rugcheck'],
};

function ref(source: DataSourceId, mint: string): DataSourceRef {
  return { id: source, name: DATA_SOURCE_NAMES[source], url: sourceUrl(source, mint) };
}

/**
 * Assemble le résultat contractuel (faits + verdict du moteur + phrases) et le valide par
 * `analysisResultSchema.parse` : garde de sortie, rien ne sort de l'API hors contrat (le nom et
 * le symbole non fiables y sont nettoyés et bornés).
 */
export function buildAnalysisResult(
  mint: string,
  collected: CollectedFacts,
  assessment: RiskAssessment,
  analyzedAt: Date,
): AnalysisResult {
  const { facts } = collected;
  const heliusUsed = collected.sources.some((source) => source.source === 'helius' && source.status === 'ok');
  const rpc: DataSourceId = heliusUsed ? 'helius' : 'solana_rpc';
  const checks = assessment.checks.map((outcome) => ({
    id: outcome.id,
    status: outcome.status,
    summary: summarizeCheck(outcome),
    metrics: buildCheckMetrics(outcome.id, facts).slice(0, 8),
    sources: collected.checkSources?.[outcome.id]?.length
      ? collected.checkSources[outcome.id].slice(0, 4)
      : CHECK_SOURCES[outcome.id].map((source) => ref(source === 'rpc' ? rpc : source, mint)),
    reasonCodes: outcome.reasonCodes.slice(0, 8),
  }));
  return analysisResultSchema.parse({
    mint,
    token: {
      mint,
      name: collected.token?.name ?? null,
      symbol: collected.token?.symbol ?? null,
      decimals: collected.token?.decimals ?? null,
      tokenProgram: collected.token?.tokenProgram ?? facts.mintAccount?.tokenProgram ?? null,
      untrusted: true,
    },
    verdict: assessment.verdict,
    explanation: explainVerdict(assessment),
    checks,
    engineVersion: assessment.engineVersion,
    analyzedAt: analyzedAt.toISOString(),
    cached: false,
    degraded: collected.degraded === true || checks.some((check) => check.status === 'unavailable'),
  });
}
