import {
  ANALYSIS_CHECK_IDS,
  type AnalysisCheckId,
  type CheckStatus,
  type RiskAssessment,
  type RiskCheckOutcome,
  type RiskFacts,
  type RiskReason,
  type RiskReasonCode,
  type Verdict,
} from '@raijin/shared-contracts';
import { resolveRiskEngineConfig, type RiskEngineConfig } from './config';
import type { EvaluateRisk } from './contract';

const HOUR_MS = 3_600_000;

/**
 * Vrai si les faits permettent un verdict : les autorités mint/freeze (deux des quatre contrôles
 * critiques) doivent être connues. Sinon l'API répond `UPSTREAM_UNAVAILABLE` plutôt que d'afficher
 * un verdict (le moteur, lui, ne renvoie jamais Sain dans ce cas). Voir docs/SCORING.md, règle D1.
 */
export function canIssueVerdict(facts: RiskFacts): boolean {
  return facts.mintAccount !== null;
}

/** Âge en heures à `observedAt` ; une date future (donnée hostile ou horloge décalée) compte pour 0. */
function ageHours(observedAt: string, date: string): number {
  return Math.max(0, (Date.parse(observedAt) - Date.parse(date)) / HOUR_MS);
}

function isAvailable(checkId: AnalysisCheckId, facts: RiskFacts): boolean {
  switch (checkId) {
    case 'mint_authority':
    case 'freeze_authority':
      return facts.mintAccount !== null;
    case 'liquidity':
      return (
        facts.liquidity !== null &&
        (facts.liquidity.usd !== null ||
          facts.liquidity.lpBurnedOrLockedPct !== null ||
          facts.liquidity.lpRemoved !== null)
      );
    case 'holder_concentration':
      return facts.holders !== null;
    case 'sell_simulation':
      return facts.sellSimulation !== null;
    case 'metadata_mutable':
      return facts.metadata !== null;
    case 'token_age':
      return facts.age !== null && (facts.age.tokenCreatedAt !== null || facts.age.poolCreatedAt !== null);
    case 'creator_history':
      return facts.creator !== null;
    case 'rugcheck':
      return facts.rugcheck !== null;
  }
}

/** Collecte des raisons (sans doublon par contrôle). */
class ReasonList {
  readonly items: RiskReason[] = [];

  add(checkId: AnalysisCheckId, code: RiskReasonCode, status: 'warn' | 'danger', critical = false): void {
    if (!this.items.some((reason) => reason.checkId === checkId && reason.code === code)) {
      this.items.push({ checkId, code, status, critical });
    }
  }
}

function authorityRules(facts: RiskFacts, config: RiskEngineConfig, reasons: ReasonList): void {
  const account = facts.mintAccount;
  if (account === null) return;
  const knownIssuer = config.knownIssuerMints.includes(facts.mint);

  if (account.mintAuthorityActive) {
    if (knownIssuer) reasons.add('mint_authority', 'MINT_AUTHORITY_ACTIVE', 'warn');
    else reasons.add('mint_authority', 'MINT_AUTHORITY_ACTIVE', 'danger', true);
  }
  if (account.freezeAuthorityActive) {
    if (knownIssuer) reasons.add('freeze_authority', 'FREEZE_AUTHORITY_KNOWN_ISSUER', 'warn');
    else reasons.add('freeze_authority', 'FREEZE_AUTHORITY_ACTIVE', 'danger', true);
  }
  // Délégué permanent : peut transférer ou brûler les tokens de n'importe quel holder (pire qu'un freeze).
  if (account.extensions.permanentDelegate) {
    if (knownIssuer) reasons.add('freeze_authority', 'TOKEN2022_PERMANENT_DELEGATE', 'warn');
    else reasons.add('freeze_authority', 'TOKEN2022_PERMANENT_DELEGATE', 'danger', true);
  }
}

function liquidityRules(facts: RiskFacts, config: RiskEngineConfig, reasons: ReasonList): void {
  const liquidity = facts.liquidity;
  if (liquidity === null) return;
  if (liquidity.lpRemoved === true) {
    reasons.add('liquidity', 'LIQUIDITY_REMOVED', 'danger', true);
    return;
  }
  if (liquidity.usd !== null && liquidity.usd < config.liquidityLowUsd) {
    reasons.add('liquidity', 'LIQUIDITY_LOW', 'warn');
  }
  const poolCreatedAt = facts.age?.poolCreatedAt ?? null;
  const lockCheckApplies =
    poolCreatedAt === null || ageHours(facts.observedAt, poolCreatedAt) < config.lpLockCheckMaxPoolAgeDays * 24;
  if (
    lockCheckApplies &&
    liquidity.lpBurnedOrLockedPct !== null &&
    liquidity.lpBurnedOrLockedPct < config.lpBurnedOrLockedMinPct
  ) {
    reasons.add('liquidity', 'LP_NOT_BURNED_OR_LOCKED', 'warn');
  }
}

function holderRules(facts: RiskFacts, config: RiskEngineConfig, reasons: ReasonList): void {
  const holders = facts.holders;
  if (holders === null) return;
  if (holders.top10Pct > config.top10WarnPct) {
    reasons.add('holder_concentration', 'TOP10_CONCENTRATION_HIGH', 'warn');
  }
  if (holders.maxSingleHolderPct > config.singleHolderWarnPct) {
    reasons.add('holder_concentration', 'SINGLE_HOLDER_ABOVE_THRESHOLD', 'warn');
  }
}

function sellRules(facts: RiskFacts, config: RiskEngineConfig, reasons: ReasonList): void {
  const sell = facts.sellSimulation;
  if (sell !== null) {
    if (!sell.routeFound) {
      reasons.add('sell_simulation', 'SELL_NO_ROUTE', 'danger', true);
    } else {
      if (sell.implicitTaxPct !== null) {
        if (sell.implicitTaxPct >= config.sellTaxCriticalPct) {
          reasons.add('sell_simulation', 'SELL_TAX_HIGH', 'danger', true);
        } else if (sell.implicitTaxPct > config.sellTaxWarnPct) {
          reasons.add('sell_simulation', 'SELL_TAX_HIGH', 'warn');
        }
      }
      if (sell.priceImpactPct !== null && sell.priceImpactPct > config.priceImpactWarnPct) {
        reasons.add('sell_simulation', 'SELL_PRICE_IMPACT_HIGH', 'warn');
      }
    }
  }

  const extensions = facts.mintAccount?.extensions;
  if (extensions === undefined) return;
  if (extensions.nonTransferable) {
    reasons.add('sell_simulation', 'TOKEN2022_NON_TRANSFERABLE', 'danger', true);
  }
  if (extensions.transferFeeBps !== null) {
    if (extensions.transferFeeBps >= config.transferFeeCriticalBps) {
      reasons.add('sell_simulation', 'TOKEN2022_TRANSFER_FEE', 'danger', true);
    } else if (extensions.transferFeeBps > config.transferFeeWarnBps) {
      reasons.add('sell_simulation', 'TOKEN2022_TRANSFER_FEE', 'warn');
    }
  }
  if (extensions.transferHook) {
    reasons.add('sell_simulation', 'TOKEN2022_TRANSFER_HOOK', 'warn');
  }
}

function otherRules(facts: RiskFacts, config: RiskEngineConfig, reasons: ReasonList): void {
  if (facts.metadata?.mutable) {
    reasons.add('metadata_mutable', 'METADATA_MUTABLE', 'warn');
  }

  const age = facts.age;
  if (age !== null) {
    if (age.tokenCreatedAt !== null && ageHours(facts.observedAt, age.tokenCreatedAt) < config.tokenVeryNewHours) {
      reasons.add('token_age', 'TOKEN_VERY_NEW', 'warn');
    }
    if (age.poolCreatedAt !== null && ageHours(facts.observedAt, age.poolCreatedAt) < config.poolVeryNewHours) {
      reasons.add('token_age', 'POOL_VERY_NEW', 'warn');
    }
  }

  if (facts.creator !== null && facts.creator.tokensDeadOrRugged >= config.creatorDeadTokensWarn) {
    reasons.add('creator_history', 'CREATOR_MANY_DEAD_TOKENS', 'warn');
  }

  const rugcheck = facts.rugcheck;
  if (rugcheck !== null) {
    if (rugcheck.rugged === true) {
      reasons.add('rugcheck', 'RUGCHECK_RUGGED', 'danger', true);
    } else if (rugcheck.risks.some((risk) => risk.level === 'danger')) {
      reasons.add('rugcheck', 'RUGCHECK_DANGER', 'warn');
    } else if (rugcheck.risks.some((risk) => risk.level === 'warn')) {
      reasons.add('rugcheck', 'RUGCHECK_WARN', 'warn');
    }
  }
}

function checkStatus(reasons: readonly RiskReason[]): CheckStatus {
  return reasons.some((reason) => reason.status === 'danger') ? 'danger' : 'warn';
}

/**
 * Fabrique du moteur : seuils fournis une fois, évaluation pure et déterministe ensuite.
 * Règles et justifications : docs/SCORING.md.
 */
export function createRiskEngine(partialConfig: Partial<RiskEngineConfig> = {}): EvaluateRisk {
  const config = resolveRiskEngineConfig(partialConfig);
  const notEvaluated: ReadonlySet<AnalysisCheckId> = new Set(config.notEvaluated);

  return (facts: RiskFacts): RiskAssessment => {
    const list = new ReasonList();
    authorityRules(facts, config, list);
    liquidityRules(facts, config, list);
    holderRules(facts, config, list);
    sellRules(facts, config, list);
    otherRules(facts, config, list);

    const reasons: RiskReason[] = [];
    const checks: RiskCheckOutcome[] = ANALYSIS_CHECK_IDS.map((id) => {
      // Critiques d'abord, puis signaux modérés (ordre stable d'insertion à statut égal).
      const own = list.items
        .filter((reason) => reason.checkId === id)
        .sort((a, b) => Number(b.critical) - Number(a.critical));
      if (own.length > 0) {
        reasons.push(...own);
        return { id, status: checkStatus(own), reasonCodes: own.map((reason) => reason.code) };
      }
      if (isAvailable(id, facts)) {
        return { id, status: 'ok', reasonCodes: [] };
      }
      // Règle D3 : contrôle non demandé par le profil → « non évalué » (aucune raison DATA_UNAVAILABLE).
      if (notEvaluated.has(id)) {
        return { id, status: 'unavailable', reasonCodes: [] };
      }
      reasons.push({ checkId: id, code: 'DATA_UNAVAILABLE', status: 'unavailable', critical: false });
      return { id, status: 'unavailable', reasonCodes: ['DATA_UNAVAILABLE'] };
    });

    return {
      engineVersion: config.version,
      verdict: decideVerdict(facts, config, reasons, checks, notEvaluated),
      reasons,
      checks,
    };
  };
}

function decideVerdict(
  facts: RiskFacts,
  config: RiskEngineConfig,
  reasons: readonly RiskReason[],
  checks: readonly RiskCheckOutcome[],
  notEvaluated: ReadonlySet<AnalysisCheckId>,
): Verdict {
  if (reasons.some((reason) => reason.critical)) return 'danger';
  const score = reasons
    .filter((reason) => reason.status === 'warn')
    .reduce((sum, reason) => sum + (config.reasonWeights[reason.code] ?? 1), 0);
  // D2 ne compte que les contrôles demandés (D3 : les non évalués sont exclus).
  const unavailable = checks.filter((check) => check.status === 'unavailable' && !notEvaluated.has(check.id)).length;
  if (!canIssueVerdict(facts)) return 'warn';
  if (unavailable >= config.unavailableChecksBlockSafe) return 'warn';
  if (score >= config.cautionScoreThreshold) return 'warn';
  return 'safe';
}

/** Profondeur d'une évaluation (scan de wallet : « contrôle rapide (6/9) »). */
export interface AssessmentDepth {
  /** `light` si le moteur avait des contrôles non demandés (règle D3), sinon `full`. */
  readonly coverage: 'full' | 'light';
  /** Contrôles réellement évalués (statut ok, warn ou danger), sur 9. */
  readonly checksEvaluated: number;
  /** Contrôles non demandés par le profil et sans donnée (D3). */
  readonly notEvaluated: AnalysisCheckId[];
  /** Contrôles demandés mais indisponibles (source en panne, clé absente) : comptés par D2. */
  readonly unavailable: AnalysisCheckId[];
}

/**
 * Profondeur de `assessment`, avec la liste `notEvaluated` du moteur qui l'a produite
 * (`LIGHT_PROFILE_NOT_EVALUATED` pour le scan de wallet, vide pour une analyse complète).
 */
export function assessmentDepth(assessment: RiskAssessment, notEvaluated: readonly AnalysisCheckId[] = []): AssessmentDepth {
  const skipped = new Set(notEvaluated);
  const missing = assessment.checks.filter((check) => check.status === 'unavailable');
  return {
    coverage: skipped.size > 0 ? 'light' : 'full',
    checksEvaluated: assessment.checks.length - missing.length,
    notEvaluated: missing.filter((check) => skipped.has(check.id)).map((check) => check.id),
    unavailable: missing.filter((check) => !skipped.has(check.id)).map((check) => check.id),
  };
}

/** Moteur avec les seuils par défaut. */
export const evaluateRisk: EvaluateRisk = createRiskEngine();
