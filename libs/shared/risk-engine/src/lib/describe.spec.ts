import {
  ANALYSIS_CHECK_IDS,
  RISK_REASON_CODES,
  analysisCheckSchema,
  type RiskAssessment,
} from '@raijin/shared-contracts';
import { REASON_SENTENCES, OK_SENTENCES, buildCheckMetrics, explainVerdict, summarizeCheck } from './describe';
import { evaluateRisk } from './engine';
import { emptyFacts, freshPumpFacts, healthyFacts, usdcFacts } from './testing/facts.fixtures';

const FORBIDDEN = /(acheter|achète|vends|investis|garanti|gain|profit|rentab|vous )/i;

describe('phrases', () => {
  it('une phrase par code de raison et par contrôle, ≤ 200 caractères, ton factuel', () => {
    for (const code of RISK_REASON_CODES) {
      expect(REASON_SENTENCES[code].length).toBeGreaterThan(10);
      expect(REASON_SENTENCES[code].length).toBeLessThanOrEqual(200);
      expect(REASON_SENTENCES[code]).not.toMatch(FORBIDDEN);
    }
    for (const id of ANALYSIS_CHECK_IDS) {
      expect(OK_SENTENCES[id].length).toBeLessThanOrEqual(200);
      expect(OK_SENTENCES[id]).not.toMatch(FORBIDDEN);
    }
  });

  it('summarizeCheck : raison principale, sinon phrase ok', () => {
    expect(summarizeCheck({ id: 'mint_authority', status: 'ok', reasonCodes: [] })).toBe(OK_SENTENCES.mint_authority);
    expect(summarizeCheck({ id: 'liquidity', status: 'danger', reasonCodes: ['LIQUIDITY_REMOVED', 'LIQUIDITY_LOW'] })).toBe(
      REASON_SENTENCES.LIQUIDITY_REMOVED,
    );
  });
});

describe('explainVerdict', () => {
  it.each([
    ['sain', healthyFacts(), /^Aucun signal critique ni modéré sur les contrôles disponibles\.$/],
    ['sain avec 1 indisponible', healthyFacts({ rugcheck: null }), /1 contrôle indisponible\.$/],
    ['danger', healthyFacts({ sellSimulation: { routeFound: false, priceImpactPct: null, implicitTaxPct: null, testAmountUsd: 100 } }), /^Signal critique détecté\. Aucune route de vente/],
    ['prudence 1 contrôle', healthyFacts({ holders: { top10Pct: 50, maxSingleHolderPct: 1, excludedAccounts: 0 } }), /^1 contrôle demande ton attention/],
    ['prudence plusieurs', freshPumpFacts(), /^\d+ contrôles demandent ton attention/],
    ['prudence par manque de données', emptyFacts(), /^Trop de contrôles .* 9 contrôles indisponibles\.$/],
  ])('%s', (_name, facts, expected) => {
    const text = explainVerdict(evaluateRisk(facts));
    expect(text).toMatch(expected);
    expect(text.length).toBeLessThanOrEqual(280);
  });

  it('danger sans raison critique (entrée incohérente) reste lisible', () => {
    const assessment: RiskAssessment = { ...evaluateRisk(healthyFacts()), verdict: 'danger' };
    expect(explainVerdict(assessment)).toBe('Signal critique détecté.');
  });
});

describe('buildCheckMetrics', () => {
  it.each([
    ['sain', healthyFacts()],
    ['usdc', usdcFacts()],
    ['pump', freshPumpFacts()],
    ['vide', emptyFacts()],
  ])('%s : contrôles complets valides selon le contrat', (_name, facts) => {
    const assessment = evaluateRisk(facts);
    for (const outcome of assessment.checks) {
      const parsed = analysisCheckSchema.parse({
        id: outcome.id,
        status: outcome.status,
        summary: summarizeCheck(outcome),
        metrics: buildCheckMetrics(outcome.id, facts),
        sources: [{ id: 'helius', name: 'Helius', url: null }],
        reasonCodes: outcome.reasonCodes,
      });
      expect(parsed.metrics.length).toBeLessThanOrEqual(8);
    }
  });

  it('valeurs chiffrées arrondies et unités', () => {
    const facts = freshPumpFacts();
    expect(buildCheckMetrics('liquidity', facts)).toContainEqual({ key: 'liquidity_usd', label: 'Liquidité (médiane)', value: 1684, unit: 'usd' });
    expect(buildCheckMetrics('token_age', facts)[0]).toEqual({ key: 'token_age', label: 'Âge du token', value: 0.9, unit: 'hours' });
    expect(buildCheckMetrics('token_age', healthyFacts())[0]).toMatchObject({ unit: 'days' });
    expect(buildCheckMetrics('creator_history', facts)).toContainEqual(expect.objectContaining({ key: 'tokens_dead_or_rugged', value: 9 }));
  });

  it('valeurs nulles et frais de transfert', () => {
    const facts = healthyFacts({
      liquidity: { usd: null, samples: [], lpBurnedOrLockedPct: null, lpRemoved: null },
      sellSimulation: { routeFound: true, priceImpactPct: null, implicitTaxPct: null, testAmountUsd: 100 },
      age: { tokenCreatedAt: null, poolCreatedAt: null },
      mintAccount: {
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
        tokenProgram: 'token-2022',
        extensions: { transferFeeBps: 250, permanentDelegate: false, transferHook: false, nonTransferable: false },
      },
    });
    expect(buildCheckMetrics('liquidity', facts).map((m) => m.value)).toEqual([null, null, 0]);
    expect(buildCheckMetrics('sell_simulation', facts)).toContainEqual(expect.objectContaining({ key: 'transfer_fee_pct', value: 2.5 }));
    expect(buildCheckMetrics('sell_simulation', facts)).toContainEqual(expect.objectContaining({ key: 'implicit_tax_pct', value: null }));
    expect(buildCheckMetrics('token_age', facts)[0]).toMatchObject({ value: null, unit: 'days' });
  });

  it('aucune valeur quand le groupe de faits manque', () => {
    for (const id of ANALYSIS_CHECK_IDS) {
      expect(buildCheckMetrics(id, emptyFacts())).toEqual([]);
    }
  });
});
