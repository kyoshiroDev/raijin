# Lighthouse mobile — perf-diag-cpu2

Lighthouse 13.6.0, émulation mobile par défaut (Moto G Power, 4G lente simulée), build de production servi par `apps/web-e2e/scripts/serve-prod.mjs`, API en mode fixtures. Médiane de 1 passages (performance). Seuil : 95. Multiplicateur CPU : 2 (diagnostic, ne fait pas foi) ; benchmarkIndex de la machine : 776, 1060, 778 (Lighthouse attend > 1000). Généré par `pnpm nx run web-e2e:lighthouse` le 2026-11-22.

| Page | Performance | Accessibilité | Best Practices | SEO | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|
| `/analyse` | 96 (96) | 100 | 96 | 100 | 0.8 s | 230 ms | 0 |
| `/analyse/<BONK>` | 85 (85) | 100 | 96 | 100 | 3.2 s | 330 ms | 0 |
| `/t/<BONK>` | 84 (84) | 100 | 96 | 100 | 0.8 s | 620 ms | 0 |

## Audits sous 0,9

- `/analyse` :
  - performance · `total-blocking-time` (0.87) Total Blocking Time — 230 ms
  - best-practices · `errors-in-console` (0) Browser errors were logged to the console
- `/analyse/<BONK>` :
  - performance · `largest-contentful-paint` (0.73) Largest Contentful Paint — 3.2 s
  - performance · `total-blocking-time` (0.75) Total Blocking Time — 330 ms
  - best-practices · `errors-in-console` (0) Browser errors were logged to the console
- `/t/<BONK>` :
  - performance · `total-blocking-time` (0.48) Total Blocking Time — 620 ms
  - best-practices · `errors-in-console` (0) Browser errors were logged to the console
