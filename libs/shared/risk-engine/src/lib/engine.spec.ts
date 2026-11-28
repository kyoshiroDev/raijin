import {
  ANALYSIS_CHECK_IDS,
  riskAssessmentSchema,
  riskFactsSchema,
  type RiskFacts,
  type RiskReasonCode,
  type Verdict,
} from '@raijin/shared-contracts';
import { DEFAULT_RISK_ENGINE_CONFIG, resolveRiskEngineConfig } from './config';
import { canIssueVerdict, createRiskEngine, evaluateRisk } from './engine';
import { RISK_ENGINE_VERSION } from './shared-risk-engine';
import { emptyFacts, freshPumpFacts, healthyFacts, usdcFacts } from './testing/facts.fixtures';

const extensions = { transferFeeBps: null, permanentDelegate: false, transferHook: false, nonTransferable: false };
const healthy = healthyFacts();

function withMintAccount(patch: Partial<NonNullable<RiskFacts['mintAccount']>>): RiskFacts {
  return healthyFacts({
    mintAccount: { mintAuthorityActive: false, freezeAuthorityActive: false, tokenProgram: 'token-2022', extensions, ...patch },
  });
}

function check(facts: RiskFacts, id: (typeof ANALYSIS_CHECK_IDS)[number]) {
  const assessment = evaluateRisk(facts);
  const outcome = assessment.checks.find((c) => c.id === id);
  if (!outcome) throw new Error('contrôle manquant');
  return outcome;
}

describe('createRiskEngine : sortie conforme au contrat', () => {
  it.each([
    ['sain', healthy],
    ['usdc', usdcFacts()],
    ['pump frais', freshPumpFacts()],
    ['vide', emptyFacts()],
  ])('%s : faits et sortie valident les schémas, 9 contrôles dans l’ordre', (_name, facts) => {
    expect(riskFactsSchema.parse(facts)).toEqual(facts);
    const assessment = riskAssessmentSchema.parse(evaluateRisk(facts));
    expect(assessment.checks.map((c) => c.id)).toEqual([...ANALYSIS_CHECK_IDS]);
    expect(assessment.engineVersion).toBe(RISK_ENGINE_VERSION);
  });

  it('est déterministe et ne modifie pas les faits', () => {
    const facts = freshPumpFacts();
    const snapshot = JSON.stringify(facts);
    expect(evaluateRisk(facts)).toEqual(evaluateRisk(facts));
    expect(JSON.stringify(facts)).toBe(snapshot);
  });
});

describe('verdict par scénario', () => {
  const cases: Array<[string, RiskFacts, Verdict, RiskReasonCode[]]> = [
    ['token établi sain', healthy, 'safe', []],
    ['mint actif', withMintAccount({ mintAuthorityActive: true }), 'danger', ['MINT_AUTHORITY_ACTIVE']],
    ['freeze actif', withMintAccount({ freezeAuthorityActive: true }), 'danger', ['FREEZE_AUTHORITY_ACTIVE']],
    ['délégué permanent', withMintAccount({ extensions: { ...extensions, permanentDelegate: true } }), 'danger', ['TOKEN2022_PERMANENT_DELEGATE']],
    ['non transférable', withMintAccount({ extensions: { ...extensions, nonTransferable: true } }), 'danger', ['TOKEN2022_NON_TRANSFERABLE']],
    ['frais de transfert 60 %', withMintAccount({ extensions: { ...extensions, transferFeeBps: 6_000 } }), 'danger', ['TOKEN2022_TRANSFER_FEE']],
    ['frais de transfert 3 %', withMintAccount({ extensions: { ...extensions, transferFeeBps: 300 } }), 'warn', ['TOKEN2022_TRANSFER_FEE']],
    ['frais de transfert nuls', withMintAccount({ extensions: { ...extensions, transferFeeBps: 0 } }), 'safe', []],
    ['transfer hook', withMintAccount({ extensions: { ...extensions, transferHook: true } }), 'warn', ['TOKEN2022_TRANSFER_HOOK']],
    ['honeypot : aucune route', healthyFacts({ sellSimulation: { routeFound: false, priceImpactPct: null, implicitTaxPct: null, testAmountUsd: 100 } }), 'danger', ['SELL_NO_ROUTE']],
    ['taxe de vente 80 %', healthyFacts({ sellSimulation: { routeFound: true, priceImpactPct: 1, implicitTaxPct: 80, testAmountUsd: 100 } }), 'danger', ['SELL_TAX_HIGH']],
    ['taxe de vente 15 %', healthyFacts({ sellSimulation: { routeFound: true, priceImpactPct: 1, implicitTaxPct: 15, testAmountUsd: 100 } }), 'warn', ['SELL_TAX_HIGH']],
    ['impact prix 12 %', healthyFacts({ sellSimulation: { routeFound: true, priceImpactPct: 12, implicitTaxPct: null, testAmountUsd: 100 } }), 'warn', ['SELL_PRICE_IMPACT_HIGH']],
    ['LP retirée', healthyFacts({ liquidity: { usd: 12, samples: [], lpBurnedOrLockedPct: 0, lpRemoved: true } }), 'danger', ['LIQUIDITY_REMOVED']],
    ['liquidité faible', healthyFacts({ liquidity: { usd: 4_000, samples: [], lpBurnedOrLockedPct: 100, lpRemoved: false } }), 'warn', ['LIQUIDITY_LOW']],
    ['LP non verrouillée, pool récent', healthyFacts({ liquidity: { usd: 50_000, samples: [], lpBurnedOrLockedPct: 20, lpRemoved: false }, age: { tokenCreatedAt: null, poolCreatedAt: '2026-11-10T00:00:00.000Z' } }), 'warn', ['LP_NOT_BURNED_OR_LOCKED']],
    ['LP non verrouillée, âge du pool inconnu', healthyFacts({ liquidity: { usd: 50_000, samples: [], lpBurnedOrLockedPct: 20, lpRemoved: false }, age: null }), 'warn', ['LP_NOT_BURNED_OR_LOCKED']],
    ['LP non verrouillée, pool de plus de 30 jours (L3)', healthyFacts({ liquidity: { usd: 50_000, samples: [], lpBurnedOrLockedPct: 20, lpRemoved: false } }), 'safe', []],
    ['top 10 concentré', healthyFacts({ holders: { top10Pct: 45, maxSingleHolderPct: 8, excludedAccounts: 0 } }), 'warn', ['TOP10_CONCENTRATION_HIGH']],
    ['holder > 10 %', healthyFacts({ holders: { top10Pct: 25, maxSingleHolderPct: 10.5, excludedAccounts: 0 } }), 'warn', ['SINGLE_HOLDER_ABOVE_THRESHOLD']],
    ['holder exactement 10 %', healthyFacts({ holders: { top10Pct: 25, maxSingleHolderPct: 10, excludedAccounts: 0 } }), 'safe', []],
    ['token très récent', healthyFacts({ age: { tokenCreatedAt: '2026-11-21T20:00:00.000Z', poolCreatedAt: null } }), 'warn', ['TOKEN_VERY_NEW']],
    ['pool très récent', healthyFacts({ age: { tokenCreatedAt: null, poolCreatedAt: '2026-11-22T01:00:00.000Z' } }), 'warn', ['POOL_VERY_NEW']],
    ['date future (hostile)', healthyFacts({ age: { tokenCreatedAt: '2030-01-01T00:00:00.000Z', poolCreatedAt: null } }), 'warn', ['TOKEN_VERY_NEW']],
    ['créateur à tokens morts', healthyFacts({ creator: { address: null, tokensLaunched: 5, tokensDeadOrRugged: 3 } }), 'warn', ['CREATOR_MANY_DEAD_TOKENS']],
    ['RugCheck : rug', healthyFacts({ rugcheck: { scoreNormalised: 90, rugged: true, risks: [] } }), 'danger', ['RUGCHECK_RUGGED']],
    ['RugCheck : danger', healthyFacts({ rugcheck: { scoreNormalised: 50, rugged: null, risks: [{ name: 'x', level: 'danger' }] } }), 'warn', ['RUGCHECK_DANGER']],
    ['RugCheck : attention seule (poids 0,25)', healthyFacts({ rugcheck: { scoreNormalised: 7, rugged: false, risks: [{ name: 'Mutable metadata', level: 'warn' }] } }), 'safe', ['RUGCHECK_WARN']],
    ['RugCheck : info seule', healthyFacts({ rugcheck: { scoreNormalised: 1, rugged: false, risks: [{ name: 'i', level: 'info' }] } }), 'safe', []],
    ['métadonnées modifiables seules (poids 0,5)', healthyFacts({ metadata: { mutable: true } }), 'safe', ['METADATA_MUTABLE']],
    ['USDC : émetteur connu', usdcFacts(), 'warn', ['MINT_AUTHORITY_ACTIVE', 'FREEZE_AUTHORITY_KNOWN_ISSUER', 'METADATA_MUTABLE']],
    ['pump.fun frais', freshPumpFacts(), 'warn', ['LIQUIDITY_LOW', 'TOP10_CONCENTRATION_HIGH', 'SINGLE_HOLDER_ABOVE_THRESHOLD', 'SELL_PRICE_IMPACT_HIGH', 'TOKEN_VERY_NEW', 'POOL_VERY_NEW', 'CREATOR_MANY_DEAD_TOKENS', 'RUGCHECK_DANGER']],
  ];

  it.each(cases)('%s → %s', (_name, facts, verdict, codes) => {
    const assessment = evaluateRisk(facts);
    expect(assessment.verdict).toBe(verdict);
    expect(assessment.reasons.map((r) => r.code).filter((c) => c !== 'DATA_UNAVAILABLE')).toEqual(codes);
  });

  it('émetteur connu : délégué permanent en attention, non critique', () => {
    const facts = { ...usdcFacts(), mint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo' };
    facts.mintAccount = {
      mintAuthorityActive: false,
      freezeAuthorityActive: true,
      tokenProgram: 'token-2022',
      extensions: { ...extensions, permanentDelegate: true },
    };
    const assessment = evaluateRisk(facts);
    expect(assessment.verdict).toBe('warn');
    expect(assessment.reasons.find((r) => r.code === 'TOKEN2022_PERMANENT_DELEGATE')).toEqual({
      checkId: 'freeze_authority',
      code: 'TOKEN2022_PERMANENT_DELEGATE',
      status: 'warn',
      critical: false,
    });
  });

  it('LP retirée masque les signaux de liquidité secondaires', () => {
    const outcome = check(healthyFacts({ liquidity: { usd: 3, samples: [], lpBurnedOrLockedPct: 0, lpRemoved: true } }), 'liquidity');
    expect(outcome).toEqual({ id: 'liquidity', status: 'danger', reasonCodes: ['LIQUIDITY_REMOVED'] });
  });

  it('les raisons critiques passent avant les modérées dans un contrôle', () => {
    const facts = withMintAccount({ extensions: { ...extensions, transferHook: true, nonTransferable: true } });
    facts.sellSimulation = { routeFound: true, priceImpactPct: 9, implicitTaxPct: null, testAmountUsd: 100 };
    const outcome = check(facts, 'sell_simulation');
    expect(outcome.status).toBe('danger');
    expect(outcome.reasonCodes[0]).toBe('TOKEN2022_NON_TRANSFERABLE');
    expect(outcome.reasonCodes).toEqual(['TOKEN2022_NON_TRANSFERABLE', 'SELL_PRICE_IMPACT_HIGH', 'TOKEN2022_TRANSFER_HOOK']);
  });
});

describe('données manquantes', () => {
  it('aucune donnée : jamais Sain, autorités inconnues, 9 contrôles indisponibles', () => {
    const facts = emptyFacts();
    const assessment = evaluateRisk(facts);
    expect(canIssueVerdict(facts)).toBe(false);
    expect(assessment.verdict).toBe('warn');
    expect(assessment.checks.every((c) => c.status === 'unavailable' && c.reasonCodes[0] === 'DATA_UNAVAILABLE')).toBe(true);
    expect(assessment.reasons).toHaveLength(9);
  });

  it('autorités indisponibles seules : Prudence (D1)', () => {
    const facts = healthyFacts({ mintAccount: null });
    expect(evaluateRisk(facts).verdict).toBe('warn');
  });

  it('2 contrôles indisponibles : Sain possible ; 3 : Prudence (D2)', () => {
    expect(evaluateRisk(healthyFacts({ creator: null, rugcheck: null })).verdict).toBe('safe');
    expect(evaluateRisk(healthyFacts({ creator: null, rugcheck: null, holders: null })).verdict).toBe('warn');
  });

  it('un signal critique l’emporte sur les données manquantes', () => {
    const facts = { ...emptyFacts(), sellSimulation: { routeFound: false, priceImpactPct: null, implicitTaxPct: null, testAmountUsd: 100 } };
    expect(evaluateRisk(facts).verdict).toBe('danger');
  });

  it.each([
    ['liquidité sans valeur exploitable', healthyFacts({ liquidity: { usd: null, samples: [], lpBurnedOrLockedPct: null, lpRemoved: null } }), 'liquidity'],
    ['âge sans date', healthyFacts({ age: { tokenCreatedAt: null, poolCreatedAt: null } }), 'token_age'],
    ['métadonnées', healthyFacts({ metadata: null }), 'metadata_mutable'],
    ['revente', healthyFacts({ sellSimulation: null }), 'sell_simulation'],
  ] as const)('%s → indisponible', (_name, facts, id) => {
    expect(check(facts, id).status).toBe('unavailable');
  });

  it('liquidité partielle (LP inconnue) reste évaluable', () => {
    expect(check(healthyFacts({ liquidity: { usd: 50_000, samples: [], lpBurnedOrLockedPct: null, lpRemoved: null } }), 'liquidity').status).toBe('ok');
    expect(check(healthyFacts({ liquidity: { usd: null, samples: [], lpBurnedOrLockedPct: null, lpRemoved: false } }), 'liquidity').status).toBe('ok');
  });

  it('extensions Token-2022 évaluées même sans devis de vente', () => {
    const facts = withMintAccount({ extensions: { ...extensions, transferHook: true } });
    facts.sellSimulation = null;
    expect(check(facts, 'sell_simulation')).toEqual({ id: 'sell_simulation', status: 'warn', reasonCodes: ['TOKEN2022_TRANSFER_HOOK'] });
  });
});

describe('configuration (variantes du banc)', () => {
  it('seuils personnalisés et version de variante', () => {
    const variant = createRiskEngine({ version: '1.0.0-variante.a', top10WarnPct: 50, singleHolderWarnPct: 20 });
    const facts = healthyFacts({ holders: { top10Pct: 45, maxSingleHolderPct: 15, excludedAccounts: 0 } });
    expect(variant(facts)).toMatchObject({ verdict: 'safe', engineVersion: '1.0.0-variante.a' });
    expect(evaluateRisk(facts).verdict).toBe('warn');
  });

  it('poids : un signal à poids 0 ne déclenche pas Prudence, un seuil abaissé oui', () => {
    const facts = healthyFacts({ holders: { top10Pct: 45, maxSingleHolderPct: 5, excludedAccounts: 0 } });
    expect(createRiskEngine({ reasonWeights: { TOP10_CONCENTRATION_HIGH: 0 } })(facts).verdict).toBe('safe');
    expect(createRiskEngine({ cautionScoreThreshold: 0.5 })(healthyFacts({ metadata: { mutable: true } })).verdict).toBe('warn');
  });

  it('émetteurs connus configurables', () => {
    const engine = createRiskEngine({ knownIssuerMints: [] });
    expect(engine(usdcFacts()).verdict).toBe('danger');
  });

  it('fusionne les poids avec les valeurs par défaut', () => {
    const config = resolveRiskEngineConfig({ reasonWeights: { LIQUIDITY_LOW: 2 } });
    expect(config.reasonWeights).toMatchObject({ LIQUIDITY_LOW: 2, METADATA_MUTABLE: 0.5 });
    expect(resolveRiskEngineConfig()).toEqual(DEFAULT_RISK_ENGINE_CONFIG);
  });

  it.each([
    [{ version: 'v2' }, /Version/],
    [{ top10WarnPct: -1 }, /top10WarnPct/],
    [{ liquidityLowUsd: Number.NaN }, /liquidityLowUsd/],
    [{ reasonWeights: { LIQUIDITY_LOW: -2 } }, /LIQUIDITY_LOW/],
  ])('refuse une configuration invalide %#', (partial, message) => {
    expect(() => createRiskEngine(partial)).toThrow(message);
  });
});
