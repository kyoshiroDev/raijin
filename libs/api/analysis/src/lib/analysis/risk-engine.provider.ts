import type { RiskAssessment, RiskFacts } from '@raijin/shared-contracts';
import { evaluateRisk, RISK_ENGINE_VERSION } from '@raijin/shared-risk-engine';

/** Moteur de verdict injecté (seuils par défaut en production, doublure en test). */
export abstract class RiskEngine {
  abstract readonly version: string;
  abstract evaluate(facts: RiskFacts): RiskAssessment;
}

export class DefaultRiskEngine extends RiskEngine {
  readonly version = RISK_ENGINE_VERSION;

  evaluate(facts: RiskFacts): RiskAssessment {
    return evaluateRisk(facts);
  }
}
