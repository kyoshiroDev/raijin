import type { CollectedFacts } from '@raijin/api-analysis';
import type { AnalysisResult, RiskAssessment, RiskFacts, WalletTokenAssessment } from '@raijin/shared-contracts';
import {
  assessmentDepth,
  createRiskEngine,
  explainVerdict,
  LIGHT_PROFILE_NOT_EVALUATED,
  RISK_ENGINE_VERSION,
} from '@raijin/shared-risk-engine';

type Analyzed = Extract<WalletTokenAssessment, { status: 'analyzed' }>;

/** Moteur du verdict rapide (instance D3 en production, doublure en test). */
export abstract class QuickRiskEngine {
  abstract readonly version: string;
  abstract evaluate(facts: RiskFacts): RiskAssessment;
}

/**
 * Seconde instance du moteur avec `notEvaluated: LIGHT_PROFILE_NOT_EVALUATED` (règle D3,
 * docs/ARCHITECTURE.md §12.4) : devis de vente, créateur et RugCheck, non demandés par le profil
 * `light`, ne comptent pas pour D2. Même version publiée que l'analyse complète.
 */
export class DefaultQuickRiskEngine extends QuickRiskEngine {
  readonly version = RISK_ENGINE_VERSION;
  private readonly evaluateRisk = createRiskEngine({ notEvaluated: LIGHT_PROFILE_NOT_EVALUATED });

  evaluate(facts: RiskFacts): RiskAssessment {
    return this.evaluateRisk(facts);
  }
}

/**
 * Verdict rapide contractuel (`coverage: light`) : phrase du moteur avec la mention « Contrôle
 * rapide (n/9) : … non évalués », contrôles évalués, résultat partiel si un contrôle **demandé**
 * manquait (les contrôles non demandés ne sont pas des indisponibilités).
 */
export function quickAssessment(collected: CollectedFacts, assessment: RiskAssessment, analyzedAt: Date): Analyzed {
  const depth = assessmentDepth(assessment, LIGHT_PROFILE_NOT_EVALUATED);
  return {
    status: 'analyzed',
    verdict: assessment.verdict,
    explanation: explainVerdict(assessment, { notEvaluated: LIGHT_PROFILE_NOT_EVALUATED }),
    coverage: 'light',
    checksEvaluated: depth.checksEvaluated,
    degraded: collected.degraded === true || depth.unavailable.length > 0,
    analyzedAt: analyzedAt.toISOString(),
    fromCache: false,
  };
}

/** Analyse complète récente réutilisée telle quelle (`coverage: full`). */
export function fullAssessment(result: AnalysisResult): Analyzed {
  return {
    status: 'analyzed',
    verdict: result.verdict,
    explanation: result.explanation,
    coverage: 'full',
    checksEvaluated: result.checks.filter((check) => check.status !== 'unavailable').length,
    degraded: result.degraded,
    analyzedAt: result.analyzedAt,
    fromCache: true,
  };
}
