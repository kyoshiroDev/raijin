import {
  ANALYSIS_CHECK_IDS,
  ANALYSIS_CHECK_LABELS,
  ANALYSIS_ERROR_CODES,
  ANALYSIS_ERROR_MESSAGES,
  DATA_SOURCE_IDS,
  DATA_SOURCE_NAMES,
  TOKEN_SYMBOL_MAX_LENGTH,
  analysisRequestSchema,
  analysisResponseSchema,
  analysisResultSchema,
  apiErrorCodeSchema,
  dataSourceRefSchema,
  mintParamSchema,
  quotaInfoSchema,
  riskAssessmentSchema,
  riskFactsSchema,
  tokenMetadataSchema,
  type AnalysisResult,
  type RiskFacts,
} from '../../index';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const NOW = '2026-11-22T10:00:00.000Z';

function buildResult(): AnalysisResult {
  return {
    mint: MINT,
    token: { mint: MINT, name: 'USD Coin', symbol: 'USDC', decimals: 6, tokenProgram: 'spl-token', untrusted: true },
    verdict: 'safe',
    explanation: 'Aucun signal critique détecté.',
    checks: ANALYSIS_CHECK_IDS.map((id) => ({
      id,
      status: 'ok' as const,
      summary: 'RAS.',
      metrics: [{ key: 'liquidity_usd', label: 'Liquidité', value: 12400, unit: 'usd' as const }],
      sources: [{ id: 'dexscreener' as const, name: 'DexScreener', url: `https://dexscreener.com/solana/${MINT}` }],
      reasonCodes: [],
    })),
    engineVersion: '1.0.0',
    analyzedAt: NOW,
    cached: false,
    degraded: false,
  };
}

describe('catalogues', () => {
  it('a 9 contrôles, chacun avec un libellé', () => {
    expect(ANALYSIS_CHECK_IDS).toHaveLength(9);
    expect(Object.keys(ANALYSIS_CHECK_LABELS).sort()).toEqual([...ANALYSIS_CHECK_IDS].sort());
  });

  it('nomme chaque source', () => {
    expect(Object.keys(DATA_SOURCE_NAMES).sort()).toEqual([...DATA_SOURCE_IDS].sort());
  });

  it('enregistre les codes d’analyse parmi les codes API, avec un message', () => {
    for (const code of ANALYSIS_ERROR_CODES) {
      expect(apiErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(ANALYSIS_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
    }
  });
});

describe('analysisRequestSchema', () => {
  it('accepte une adresse ou un lien et retire les espaces', () => {
    expect(analysisRequestSchema.parse({ input: `  ${MINT} ` })).toEqual({ input: MINT });
  });

  it('refuse vide, trop long et champs inconnus', () => {
    expect(analysisRequestSchema.safeParse({ input: '  ' }).success).toBe(false);
    expect(analysisRequestSchema.safeParse({ input: 'x'.repeat(257) }).success).toBe(false);
    expect(analysisRequestSchema.safeParse({ input: MINT, admin: true }).success).toBe(false);
  });

  it('valide le paramètre :mint', () => {
    expect(mintParamSchema.safeParse({ mint: MINT }).success).toBe(true);
    expect(mintParamSchema.safeParse({ mint: '<script>' }).success).toBe(false);
  });
});

describe('dataSourceRefSchema', () => {
  it('accepte un lien https vers un domaine autorisé, ou null', () => {
    expect(dataSourceRefSchema.safeParse({ id: 'rugcheck', name: 'RugCheck', url: `https://rugcheck.xyz/tokens/${MINT}` }).success).toBe(true);
    expect(dataSourceRefSchema.safeParse({ id: 'helius', name: 'Helius', url: null }).success).toBe(true);
  });

  it.each(['http://dexscreener.com/', 'javascript:alert(1)', 'https://evil.com/', 'https://mainnet.helius-rpc.com/?api-key=x'])(
    'refuse %j',
    (url) => {
      expect(dataSourceRefSchema.safeParse({ id: 'dexscreener', name: 'DexScreener', url }).success).toBe(false);
    },
  );
});

describe('tokenMetadataSchema', () => {
  it('nettoie et borne le nom et le symbole (texte non fiable)', () => {
    const zeroWidth = String.fromCodePoint(0x200b);
    const parsed = tokenMetadataSchema.parse({
      mint: MINT,
      name: `  Fake${zeroWidth} USDC  `,
      symbol: 'S'.repeat(40),
      decimals: 6,
      tokenProgram: 'token-2022',
      untrusted: true,
    });
    expect(parsed.name).toBe('Fake USDC');
    expect(Array.from(parsed.symbol ?? '')).toHaveLength(TOKEN_SYMBOL_MAX_LENGTH);
  });

  it('exige le marqueur untrusted', () => {
    expect(
      tokenMetadataSchema.safeParse({ mint: MINT, name: null, symbol: null, decimals: null, tokenProgram: null, untrusted: false }).success,
    ).toBe(false);
  });
});

describe('analysisResultSchema', () => {
  it('accepte un résultat complet', () => {
    expect(analysisResultSchema.safeParse(buildResult()).success).toBe(true);
  });

  it('refuse des contrôles manquants ou dans le désordre', () => {
    const missing = buildResult();
    missing.checks = missing.checks.slice(1);
    expect(analysisResultSchema.safeParse(missing).success).toBe(false);

    const shuffled = buildResult();
    shuffled.checks = [...shuffled.checks].reverse();
    expect(analysisResultSchema.safeParse(shuffled).success).toBe(false);
  });

  it('refuse un mint incohérent entre résultat et métadonnées', () => {
    const result = buildResult();
    result.token = { ...result.token, mint: 'So11111111111111111111111111111111111111112' };
    expect(analysisResultSchema.safeParse(result).success).toBe(false);
  });

  it('se combine avec le quota dans la réponse', () => {
    const quota = {
      kind: 'analysis',
      subject: 'user',
      plan: 'FREE',
      limit: 5,
      used: 1,
      remaining: 4,
      resetsAt: '2026-11-23T00:00:00.000Z',
    };
    expect(quotaInfoSchema.safeParse(quota).success).toBe(true);
    expect(analysisResponseSchema.safeParse({ analysis: buildResult(), quota }).success).toBe(true);
    expect(quotaInfoSchema.safeParse({ ...quota, plan: null, limit: null, remaining: null, subject: 'anonymous' }).success).toBe(true);
  });
});

describe('contrat du risk-engine', () => {
  const facts: RiskFacts = {
    version: 1,
    mint: MINT,
    observedAt: NOW,
    mintAccount: {
      mintAuthorityActive: false,
      freezeAuthorityActive: true,
      tokenProgram: 'spl-token',
      extensions: { transferFeeBps: null, permanentDelegate: false, transferHook: false, nonTransferable: false },
    },
    metadata: { mutable: true },
    liquidity: { usd: 1000, samples: [{ source: 'dexscreener', usd: 1000 }], lpBurnedOrLockedPct: 100, lpRemoved: false },
    holders: { top10Pct: 35, maxSingleHolderPct: 8, excludedAccounts: 2 },
    sellSimulation: { routeFound: true, priceImpactPct: 1.2, implicitTaxPct: 0, testAmountUsd: 50 },
    age: { tokenCreatedAt: '2026-11-20T10:00:00.000Z', poolCreatedAt: null },
    creator: null,
    rugcheck: { scoreNormalised: 12, rugged: false, risks: [{ name: 'Mutable metadata', level: 'warn' }] },
  };

  it('accepte des faits normalisés, groupes indisponibles à null', () => {
    expect(riskFactsSchema.safeParse(facts).success).toBe(true);
  });

  it('refuse des pourcentages hors bornes et une version inconnue', () => {
    expect(riskFactsSchema.safeParse({ ...facts, holders: { ...facts.holders, top10Pct: 120 } }).success).toBe(false);
    expect(riskFactsSchema.safeParse({ ...facts, version: 2 }).success).toBe(false);
  });

  it('valide une sortie du moteur à 9 contrôles', () => {
    const assessment = {
      engineVersion: '1.0.0',
      verdict: 'danger',
      reasons: [{ checkId: 'freeze_authority', code: 'FREEZE_AUTHORITY_ACTIVE', status: 'danger', critical: true }],
      checks: ANALYSIS_CHECK_IDS.map((id) => ({ id, status: 'ok', reasonCodes: [] })),
    };
    expect(riskAssessmentSchema.safeParse(assessment).success).toBe(true);
    expect(riskAssessmentSchema.safeParse({ ...assessment, checks: assessment.checks.slice(2) }).success).toBe(false);
    expect(riskAssessmentSchema.safeParse({ ...assessment, engineVersion: 'latest' }).success).toBe(false);
  });
});
