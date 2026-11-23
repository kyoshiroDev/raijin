import {
  ANALYSIS_CHECK_LABELS,
  CHECK_STATUS_LABELS,
  VERDICT_LABELS,
  type AnalysisCheckId,
  type CheckStatus,
  type RiskAssessment,
  type Verdict,
} from '@raijin/shared-contracts';
import { evaluateRisk, explainVerdict, summarizeCheck } from '@raijin/shared-risk-engine';
import { CHECK_SOURCES } from '../checks';
import { DEMO_FACTS, DEMO_TOKEN } from './facts';

export interface DemoCheckView {
  readonly id: AnalysisCheckId;
  readonly label: string;
  readonly status: CheckStatus;
  readonly statusLabel: string;
  readonly summary: string;
  readonly source: string;
}

export interface DemoView {
  readonly tokenName: string;
  readonly verdict: Verdict;
  readonly verdictLabel: string;
  readonly explanation: string;
  readonly checks: readonly DemoCheckView[];
  readonly counts: Readonly<Record<CheckStatus, number>>;
}

/** Vue de la démonstration, calculée par le moteur de production à partir des faits fictifs. */
export function buildDemoView(assessment: RiskAssessment = evaluateRisk(DEMO_FACTS)): DemoView {
  const counts: Record<CheckStatus, number> = { ok: 0, warn: 0, danger: 0, unavailable: 0 };
  const checks = assessment.checks.map((check) => {
    counts[check.status] += 1;
    return {
      id: check.id,
      label: ANALYSIS_CHECK_LABELS[check.id],
      status: check.status,
      statusLabel: CHECK_STATUS_LABELS[check.status],
      summary: summarizeCheck(check),
      source: CHECK_SOURCES[check.id],
    };
  });
  return {
    tokenName: DEMO_TOKEN.name,
    verdict: assessment.verdict,
    verdictLabel: VERDICT_LABELS[assessment.verdict],
    explanation: explainVerdict(assessment),
    checks,
    counts,
  };
}

export const DEMO = buildDemoView();
