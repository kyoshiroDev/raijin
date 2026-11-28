import type { RiskAssessment, RiskFacts } from '@raijin/shared-contracts';

/**
 * Signature du moteur : fonction pure et déterministe (mêmes faits → même sortie), sans I/O,
 * sans horloge (l'âge se calcule à partir de `facts.observedAt`). Les seuils sont fournis par la
 * fabrique du moteur (implémentée par solana-data), ce qui permet au banc d'évaluer une variante
 * sur l'historique des faits persistés. Contrats : `@raijin/shared-contracts` (`analysis/risk`).
 */
export type EvaluateRisk = (facts: RiskFacts) => RiskAssessment;
