import { riskAssessmentSchema, type RiskFacts } from '@raijin/shared-contracts';
import { DEFAULT_RISK_ENGINE_CONFIG, LIGHT_PROFILE_NOT_EVALUATED, resolveRiskEngineConfig } from './config';
import { EXPLANATION_MAX_LENGTH, explainVerdict } from './describe';
import { assessmentDepth, createRiskEngine, evaluateRisk } from './engine';
import { emptyFacts, freshPumpFacts, healthyFacts } from './testing/facts.fixtures';

/** Faits d'un profil `light` (scan de wallet) : devis, créateur et RugCheck non collectés. */
function light(facts: RiskFacts): RiskFacts {
  return { ...facts, sellSimulation: null, creator: null, rugcheck: null };
}

const lightEngine = createRiskEngine({ notEvaluated: LIGHT_PROFILE_NOT_EVALUATED });
const extensions = { transferFeeBps: null, permanentDelegate: false, transferHook: false, nonTransferable: false };

describe('règle D3 : contrôles non évalués (profil light)', () => {
  it('par défaut, aucun contrôle non évalué : D2 bloque Sain avec 3 groupes absents', () => {
    expect(DEFAULT_RISK_ENGINE_CONFIG.notEvaluated).toEqual([]);
    const assessment = evaluateRisk(light(healthyFacts()));
    expect(assessment.verdict).toBe('warn');
    expect(assessment.reasons.filter((reason) => reason.code === 'DATA_UNAVAILABLE')).toHaveLength(3);
  });

  it('moteur light : token sain → Sain en contrôle rapide 6/9, sans raison DATA_UNAVAILABLE', () => {
    const assessment = riskAssessmentSchema.parse(lightEngine(light(healthyFacts())));
    expect(assessment.verdict).toBe('safe');
    expect(assessment.reasons).toEqual([]);
    const skipped = assessment.checks.filter((check) => check.status === 'unavailable');
    expect(skipped.map((check) => check.id)).toEqual(['sell_simulation', 'creator_history', 'rugcheck']);
    expect(skipped.every((check) => check.reasonCodes.length === 0)).toBe(true);
    expect(assessmentDepth(assessment, LIGHT_PROFILE_NOT_EVALUATED)).toEqual({
      coverage: 'light',
      checksEvaluated: 6,
      notEvaluated: ['sell_simulation', 'creator_history', 'rugcheck'],
      unavailable: [],
    });
    expect(explainVerdict(assessment, { notEvaluated: LIGHT_PROFILE_NOT_EVALUATED })).toBe(
      'Aucun signal critique ni modéré sur les contrôles disponibles. Contrôle rapide (6/9) : revente (honeypot), créateur et RugCheck non évalués.',
    );
  });

  it('D2 reste active sur les contrôles demandés : 3 indisponibles en plus → Prudence', () => {
    const facts = { ...light(healthyFacts()), holders: null, metadata: null, age: null };
    const assessment = lightEngine(facts);
    expect(assessment.verdict).toBe('warn');
    const depth = assessmentDepth(assessment, LIGHT_PROFILE_NOT_EVALUATED);
    expect(depth.checksEvaluated).toBe(3);
    expect(depth.unavailable).toEqual(['holder_concentration', 'metadata_mutable', 'token_age']);
    expect(explainVerdict(assessment, { notEvaluated: LIGHT_PROFILE_NOT_EVALUATED })).toContain('3 contrôles indisponibles.');
  });

  it('2 demandés indisponibles (sans clé Helius : holders et métadonnées) → Sain possible, 4/9', () => {
    const assessment = lightEngine({ ...light(healthyFacts()), holders: null, metadata: null });
    expect(assessment.verdict).toBe('safe');
    expect(assessmentDepth(assessment, LIGHT_PROFILE_NOT_EVALUATED).checksEvaluated).toBe(4);
    expect(explainVerdict(assessment, { notEvaluated: LIGHT_PROFILE_NOT_EVALUATED })).toMatch(
      /2 contrôles indisponibles\. Contrôle rapide \(4\/9\)/,
    );
  });

  it('un Danger reste un Danger (mint actif), et les extensions bloquantes restent évaluées', () => {
    const mintActive = light(
      healthyFacts({ mintAccount: { mintAuthorityActive: true, freezeAuthorityActive: false, tokenProgram: 'spl-token', extensions } }),
    );
    expect(lightEngine(mintActive).verdict).toBe('danger');
    const nonTransferable = light(
      healthyFacts({
        mintAccount: {
          mintAuthorityActive: false,
          freezeAuthorityActive: false,
          tokenProgram: 'token-2022',
          extensions: { ...extensions, nonTransferable: true },
        },
      }),
    );
    const assessment = lightEngine(nonTransferable);
    expect(assessment.verdict).toBe('danger');
    expect(assessment.checks.find((check) => check.id === 'sell_simulation')?.status).toBe('danger');
    const depth = assessmentDepth(assessment, LIGHT_PROFILE_NOT_EVALUATED);
    expect(depth.checksEvaluated).toBe(7);
    expect(depth.notEvaluated).toEqual(['creator_history', 'rugcheck']);
    expect(explainVerdict(assessment, { notEvaluated: LIGHT_PROFILE_NOT_EVALUATED })).toContain('créateur et RugCheck non évalués.');
  });

  it('un groupe non demandé mais fourni est évalué normalement', () => {
    const assessment = lightEngine(freshPumpFacts());
    expect(assessmentDepth(assessment, LIGHT_PROFILE_NOT_EVALUATED).checksEvaluated).toBe(9);
    expect(explainVerdict(assessment, { notEvaluated: LIGHT_PROFILE_NOT_EVALUATED })).toMatch(/Contrôle rapide \(9\/9\)\.$/);
  });

  it('D1 inchangée : autorités inconnues → jamais Sain, même en light', () => {
    expect(lightEngine(light(emptyFacts())).verdict).toBe('warn');
  });

  it('profondeur d’une analyse complète', () => {
    expect(assessmentDepth(evaluateRisk(healthyFacts()))).toEqual({ coverage: 'full', checksEvaluated: 9, notEvaluated: [], unavailable: [] });
  });

  it('refuse les autorités mint / freeze et les identifiants inconnus', () => {
    expect(() => resolveRiskEngineConfig({ notEvaluated: ['mint_authority'] })).toThrow(RangeError);
    expect(() => resolveRiskEngineConfig({ notEvaluated: ['freeze_authority'] })).toThrow(RangeError);
    expect(() => resolveRiskEngineConfig({ notEvaluated: ['nope' as never] })).toThrow(/non évaluable/);
  });

  it('explications toujours ≤ 280 caractères (pire cas : danger + note rapide)', () => {
    const allButAuthorities = [
      'liquidity',
      'holder_concentration',
      'sell_simulation',
      'metadata_mutable',
      'token_age',
      'creator_history',
      'rugcheck',
    ] as const;
    const engine = createRiskEngine({ notEvaluated: allButAuthorities });
    const facts: RiskFacts = {
      ...emptyFacts(),
      mintAccount: {
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
        tokenProgram: 'token-2022',
        extensions: { ...extensions, permanentDelegate: true },
      },
    };
    const text = explainVerdict(engine(facts), { notEvaluated: allButAuthorities });
    expect(text.length).toBeLessThanOrEqual(EXPLANATION_MAX_LENGTH);
    expect(text.startsWith('Signal critique détecté. Un délégué permanent')).toBe(true);
    // Garde-fou : une note trop longue est coupée (entrée artificielle, 40 contrôles non évalués).
    const long = engine(facts);
    const padded = { ...long, checks: Array.from({ length: 40 }, () => ({ id: 'creator_history' as const, status: 'unavailable' as const, reasonCodes: [] })) };
    const cut = explainVerdict(padded, { notEvaluated: allButAuthorities });
    expect(cut).toHaveLength(EXPLANATION_MAX_LENGTH);
    expect(cut.endsWith('…')).toBe(true);
  });
});
