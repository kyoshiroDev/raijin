# shared-risk-engine (`@raijin/shared-risk-engine`)

Moteur de verdict **pur** (TypeScript sans API Node ni Deno, lint bloquant) partagé par l'API Raijin et le banc.
Règles, seuils, justifications et limites : [`docs/SCORING.md`](../../../docs/SCORING.md).

```ts
const assessment = evaluateRisk(facts);                       // seuils par défaut, version RISK_ENGINE_VERSION
const variant = createRiskEngine({ version: '1.0.0-variante.a', top10WarnPct: 40 }); // banc
canIssueVerdict(facts);                                       // false → l'API répond UPSTREAM_UNAVAILABLE
summarizeCheck(outcome); explainVerdict(assessment); buildCheckMetrics(checkId, facts); // textes et valeurs affichés
```

Tests : `nx test shared-risk-engine` (Vitest, couverture imposée à 90 % lignes, branches, fonctions, instructions).
