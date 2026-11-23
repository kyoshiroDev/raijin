import type { Verdict } from '@raijin/shared-contracts';
import { FOLLOW_UP_WINDOWS, type FollowUpHorizon, type FollowUpObservation, type VerdictRecord } from '../contracts';
import { createPrng, simulateFacts } from '../simulation';

/** Jeux construits à la main pour les tests (aucune donnée réelle). */
export const VERDICT_AT = '2026-11-01T00:00:00.000Z';
export const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

export function makeRecord(overrides: Partial<VerdictRecord> = {}): VerdictRecord {
  const verdictAt = overrides.verdictAt ?? VERDICT_AT;
  return {
    id: 'r1',
    mint: MINT,
    verdictAt,
    engineVersion: '1.0.0',
    verdict: 'safe',
    reasonCodes: [],
    flaggedChecks: [],
    baseline: { priceUsd: 1, liquidityUsd: 10_000, supplyRaw: '1000000000' },
    facts: simulateFacts('established', MINT, verdictAt, createPrng(1)),
    ...overrides,
  };
}

/** Observation au milieu de la fenêtre de `horizon` (ou décalée de `offsetMs` depuis son ouverture). */
export function makeObservation(
  record: Pick<VerdictRecord, 'id' | 'verdictAt'>,
  horizon: FollowUpHorizon,
  overrides: Partial<FollowUpObservation> = {},
  offsetMs?: number,
): FollowUpObservation {
  const window = FOLLOW_UP_WINDOWS[horizon];
  const at = Date.parse(record.verdictAt) + window.afterMs + (offsetMs ?? window.toleranceMs / 2);
  return {
    recordId: record.id,
    horizon,
    observedAt: new Date(at).toISOString(),
    poolFound: true,
    lpRemoved: false,
    priceUsd: 1,
    liquidityUsd: 10_000,
    volume24hUsd: 5_000,
    supplyRaw: '1000000000',
    ...overrides,
  };
}

/** `count` verdicts identiques (identifiants `prefix-i`) pour bâtir une matrice à la main. */
export function scored(prefix: string, count: number, verdict: Verdict, reasonCodes: VerdictRecord['reasonCodes'] = [], flaggedChecks: VerdictRecord['flaggedChecks'] = []) {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, verdict, reasonCodes, flaggedChecks }));
}
