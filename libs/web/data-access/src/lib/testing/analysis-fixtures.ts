import {
  DATA_SOURCE_NAMES,
  type AnalysisCheck,
  type AnalysisResponse,
  type AnalysisResult,
  type DataSourceId,
  type QuotaInfo,
} from '@raijin/shared-contracts';

/**
 * Résultats d'analyse d'exemple, conformes à `analysisResultSchema` (vérifié par un test).
 * Servent aux specs, aux captures et à l'API simulée tant que l'API réelle n'est pas branchée.
 * Les mints sont fictifs (32 octets aléatoires encodés en base58).
 */
export const FAKE_MINTS = {
  safe: '4CtcQ22W5fYyXJzJcRBTQbr2xmgxcGGTx6WM4bYtNDp9',
  warn: 'EF3mFcXAoqFH4xam6WRUvHxUhHQWgkJYRHGtSBH3zBTR',
  danger: '3zfyvh8vPbpCys6RWALBZHZYd9TNQniFCY2H8LukNRCH',
  degraded: '4ajVfUTrtcSat6U7vtpCTU4MM98oob4yqSwkg97RfZiq',
  creator: '92szaoSfeTQtot2WrbK4HSCYcVt6P6NdoHLpfohws8Fo',
} as const;

export type FakeAnalysisScenario = 'safe' | 'warn' | 'danger' | 'degraded';

function source(id: DataSourceId, mint: string): AnalysisCheck['sources'][number] {
  const urls: Partial<Record<DataSourceId, string>> = {
    helius: `https://solscan.io/token/${mint}`,
    solana_rpc: `https://explorer.solana.com/address/${mint}`,
    dexscreener: `https://dexscreener.com/solana/${mint}`,
    geckoterminal: `https://www.geckoterminal.com/solana/tokens/${mint}`,
    jupiter: `https://jup.ag/tokens/${mint}`,
    rugcheck: `https://rugcheck.xyz/tokens/${mint}`,
  };
  return { id, name: DATA_SOURCE_NAMES[id], url: urls[id] ?? null };
}

function check(
  mint: string,
  id: AnalysisCheck['id'],
  status: AnalysisCheck['status'],
  summary: string,
  metrics: AnalysisCheck['metrics'],
  sources: readonly DataSourceId[],
  reasonCodes: AnalysisCheck['reasonCodes'] = [],
): AnalysisCheck {
  return { id, status, summary, metrics, sources: sources.map((s) => source(s, mint)), reasonCodes };
}

function safeChecks(mint: string): AnalysisCheck[] {
  return [
    check(mint, 'mint_authority', 'ok', 'L’autorité de mint est révoquée : personne ne peut créer de nouveaux tokens.', [
      { key: 'mint_authority_active', label: 'Autorité de mint active', value: false, unit: null },
    ], ['helius']),
    check(mint, 'freeze_authority', 'ok', 'L’autorité de freeze est révoquée : personne ne peut bloquer ton solde.', [
      { key: 'freeze_authority_active', label: 'Autorité de freeze active', value: false, unit: null },
      { key: 'permanent_delegate', label: 'Délégué permanent', value: false, unit: null },
    ], ['helius']),
    check(mint, 'liquidity', 'ok', 'La liquidité est confortable et la LP est brûlée à 100 %.', [
      { key: 'liquidity_usd', label: 'Liquidité (médiane)', value: 1_284_530, unit: 'usd' },
      { key: 'lp_locked_pct', label: 'LP brûlée ou verrouillée', value: 100, unit: 'percent' },
      { key: 'liquidity_samples', label: 'Sources de liquidité', value: 2, unit: 'count' },
    ], ['dexscreener', 'geckoterminal']),
    check(mint, 'holder_concentration', 'ok', 'Le top 10 détient 18,4 % de l’offre, aucun wallet au-dessus de 10 %.', [
      { key: 'top10_pct', label: 'Part du top 10', value: 18.4, unit: 'percent' },
      { key: 'max_holder_pct', label: 'Plus gros wallet', value: 4.1, unit: 'percent' },
      { key: 'excluded_accounts', label: 'Comptes exclus (LP, programmes)', value: 3, unit: 'count' },
    ], ['helius']),
    check(mint, 'sell_simulation', 'ok', 'Un devis de vente existe, avec un impact prix faible et sans taxe cachée.', [
      { key: 'route_found', label: 'Route de vente trouvée', value: true, unit: null },
      { key: 'test_amount_usd', label: 'Montant simulé', value: 100, unit: 'usd' },
      { key: 'price_impact_pct', label: 'Impact prix', value: 0.12, unit: 'percent' },
      { key: 'implicit_tax_pct', label: 'Taxe implicite', value: 0, unit: 'percent' },
    ], ['jupiter']),
    check(mint, 'metadata_mutable', 'ok', 'Les métadonnées sont figées : le nom et le logo ne peuvent plus changer.', [
      { key: 'metadata_mutable', label: 'Métadonnées modifiables', value: false, unit: null },
    ], ['helius']),
    check(mint, 'token_age', 'ok', 'Le token et son pool existent depuis plus de 6 mois.', [
      { key: 'token_age', label: 'Âge du token', value: 214.5, unit: 'days' },
      { key: 'pool_age', label: 'Âge du pool', value: 212, unit: 'days' },
    ], ['helius', 'dexscreener']),
    check(mint, 'creator_history', 'ok', 'Le créateur n’a lancé aucun autre token connu.', [
      { key: 'creator_address', label: 'Créateur', value: FAKE_MINTS.creator, unit: 'address' },
      { key: 'tokens_launched', label: 'Autres tokens lancés', value: 0, unit: 'count' },
    ], ['helius']),
    check(mint, 'rugcheck', 'ok', 'RugCheck ne signale aucun risque majeur (source complémentaire).', [
      { key: 'rugcheck_score', label: 'Score RugCheck (0 = sûr)', value: 1, unit: null },
      { key: 'rugcheck_risks', label: 'Risques signalés', value: 0, unit: 'count' },
    ], ['rugcheck']),
  ];
}

function baseResult(mint: string, name: string | null, symbol: string | null): Omit<AnalysisResult, 'verdict' | 'explanation' | 'checks' | 'degraded'> {
  return {
    mint,
    token: { mint, name, symbol, decimals: 6, tokenProgram: 'spl-token', untrusted: true },
    engineVersion: '1.0.0',
    analyzedAt: '2026-11-22T14:03:00.000Z',
    cached: false,
  };
}

/** Résultat d'exemple pour un scénario (Sain, Prudence, Danger, partiel). */
export function fakeAnalysis(scenario: FakeAnalysisScenario = 'safe', overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  const mint = overrides.mint ?? FAKE_MINTS[scenario];
  const checks = safeChecks(mint);
  let result: AnalysisResult;
  switch (scenario) {
    case 'safe':
      result = {
        ...baseResult(mint, 'Kitsune Inu', 'KITSU'),
        verdict: 'safe',
        explanation: 'Raijin n’a détecté aucun signal de risque sur les 9 contrôles.',
        checks,
        degraded: false,
      };
      break;
    case 'warn':
      checks[3] = check(mint, 'holder_concentration', 'warn', 'Le top 10 détient 62,3 % de l’offre et un wallet en possède 14,8 %.', [
        { key: 'top10_pct', label: 'Part du top 10', value: 62.3, unit: 'percent' },
        { key: 'max_holder_pct', label: 'Plus gros wallet', value: 14.8, unit: 'percent' },
        { key: 'excluded_accounts', label: 'Comptes exclus (LP, programmes)', value: 2, unit: 'count' },
      ], ['helius'], ['TOP10_CONCENTRATION_HIGH', 'SINGLE_HOLDER_ABOVE_THRESHOLD']);
      checks[5] = check(mint, 'metadata_mutable', 'warn', 'Le créateur peut encore modifier le nom, le symbole et le logo.', [
        { key: 'metadata_mutable', label: 'Métadonnées modifiables', value: true, unit: null },
      ], ['helius'], ['METADATA_MUTABLE']);
      checks[6] = check(mint, 'token_age', 'warn', 'Le pool a moins de 2 jours : peu d’historique pour juger.', [
        { key: 'token_age', label: 'Âge du token', value: 41.2, unit: 'hours' },
        { key: 'pool_age', label: 'Âge du pool', value: 38.5, unit: 'hours' },
      ], ['helius', 'dexscreener'], ['POOL_VERY_NEW']);
      checks[2] = check(mint, 'liquidity', 'ok', 'La liquidité suffit pour de petits montants et la LP est brûlée.', [
        { key: 'liquidity_usd', label: 'Liquidité (médiane)', value: 48_210, unit: 'usd' },
        { key: 'lp_locked_pct', label: 'LP brûlée ou verrouillée', value: 100, unit: 'percent' },
        { key: 'liquidity_samples', label: 'Sources de liquidité', value: 2, unit: 'count' },
      ], ['dexscreener', 'geckoterminal']);
      result = {
        ...baseResult(mint, 'Raiden Frog', 'RFROG'),
        verdict: 'warn',
        explanation: '62 % de l’offre est dans 10 wallets et les métadonnées restent modifiables.',
        checks,
        degraded: false,
        cached: true,
      };
      break;
    case 'danger':
      checks[0] = check(mint, 'mint_authority', 'danger', 'L’autorité de mint est active : le créateur peut imprimer des tokens à volonté.', [
        { key: 'mint_authority_active', label: 'Autorité de mint active', value: true, unit: null },
      ], ['helius'], ['MINT_AUTHORITY_ACTIVE']);
      checks[2] = check(mint, 'liquidity', 'warn', 'La liquidité est faible et la LP n’est ni brûlée ni verrouillée.', [
        { key: 'liquidity_usd', label: 'Liquidité (médiane)', value: 3_412.5, unit: 'usd' },
        { key: 'lp_locked_pct', label: 'LP brûlée ou verrouillée', value: 0, unit: 'percent' },
        { key: 'liquidity_samples', label: 'Sources de liquidité', value: 1, unit: 'count' },
      ], ['dexscreener'], ['LIQUIDITY_LOW', 'LP_NOT_BURNED_OR_LOCKED']);
      checks[4] = check(mint, 'sell_simulation', 'danger', 'Aucune route de vente trouvée : tu risques de ne pas pouvoir revendre.', [
        { key: 'route_found', label: 'Route de vente trouvée', value: false, unit: null },
        { key: 'test_amount_usd', label: 'Montant simulé', value: 100, unit: 'usd' },
        { key: 'price_impact_pct', label: 'Impact prix', value: null, unit: 'percent' },
        { key: 'implicit_tax_pct', label: 'Taxe implicite', value: null, unit: 'percent' },
      ], ['jupiter'], ['SELL_NO_ROUTE']);
      checks[7] = check(mint, 'creator_history', 'danger', 'Le créateur a déjà lancé 14 tokens, dont 9 ont subi un rug.', [
        { key: 'creator_address', label: 'Créateur', value: FAKE_MINTS.creator, unit: 'address' },
        { key: 'tokens_launched', label: 'Autres tokens lancés', value: 14, unit: 'count' },
        { key: 'tokens_rugged', label: 'Tokens avec rug', value: 9, unit: 'count' },
      ], ['helius'], ['CREATOR_PRIOR_RUGS']);
      checks[8] = check(mint, 'rugcheck', 'danger', 'RugCheck classe ce token à risque élevé (source complémentaire).', [
        { key: 'rugcheck_score', label: 'Score RugCheck (0 = sûr)', value: 87, unit: null },
        { key: 'rugcheck_risks', label: 'Risques signalés', value: 5, unit: 'count' },
      ], ['rugcheck'], ['RUGCHECK_DANGER']);
      result = {
        ...baseResult(mint, 'Pepe Thunder', 'PTHND'),
        verdict: 'danger',
        explanation: 'L’autorité de mint est encore active et aucune route de vente n’a été trouvée.',
        checks,
        degraded: false,
      };
      break;
    case 'degraded':
      checks[7] = check(mint, 'creator_history', 'unavailable', 'Source indisponible : l’historique du créateur n’a pas pu être vérifié.', [
        { key: 'creator_address', label: 'Créateur', value: null, unit: 'address' },
        { key: 'tokens_launched', label: 'Autres tokens lancés', value: null, unit: 'count' },
      ], ['helius'], ['DATA_UNAVAILABLE']);
      checks[8] = check(mint, 'rugcheck', 'unavailable', 'Source indisponible : RugCheck n’a pas répondu à temps.', [], ['rugcheck'], ['DATA_UNAVAILABLE']);
      checks[4] = check(mint, 'sell_simulation', 'unavailable', 'Source indisponible : le devis de vente n’a pas pu être obtenu.', [], ['jupiter'], ['DATA_UNAVAILABLE']);
      result = {
        ...baseResult(mint, null, null),
        verdict: 'warn',
        explanation: 'Aucun signal sur les contrôles disponibles, mais 3 sources manquent : Raijin ne peut pas conclure à Sain.',
        checks,
        degraded: true,
      };
      break;
  }
  return { ...result, ...overrides };
}

/** Quota d'exemple (visiteur anonyme, 3 analyses par jour). */
export function fakeQuota(overrides: Partial<QuotaInfo> = {}): QuotaInfo {
  return {
    kind: 'analysis',
    subject: 'anonymous',
    plan: null,
    limit: 3,
    used: 1,
    remaining: 2,
    resetsAt: '2026-11-23T00:00:00.000Z',
    ...overrides,
  };
}

/** Réponse de `POST /analyses` d'exemple. */
export function fakeAnalysisResponse(scenario: FakeAnalysisScenario = 'safe', quota: Partial<QuotaInfo> = {}): AnalysisResponse {
  return { analysis: fakeAnalysis(scenario), quota: fakeQuota(quota) };
}
