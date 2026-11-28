# Lighthouse mobile — perf-apres

Lighthouse 13.6.0, émulation mobile par défaut (Moto G Power, 4G lente simulée), build de production servi par `apps/web-e2e/scripts/serve-prod.mjs`, API en mode fixtures. Médiane de 3 passages (performance). Seuil : 95. Multiplicateur CPU : 4 (défaut) ; benchmarkIndex de la machine : 1029, 1035, 957, 1098, 967, 1082, 963, 1012, 1188 (Lighthouse attend > 1000). Généré par `pnpm nx run web-e2e:lighthouse` le 2026-11-22.

| Page | Performance | Accessibilité | Best Practices | SEO | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|
| `/analyse` | 83 (85/83/81) | 100 | 96 | 100 | 1.7 s | 640 ms | 0 |
| `/analyse/<BONK>` | 68 (68/69/66) | 100 | 96 | 100 | 3.7 s | 950 ms | 0 |
| `/t/<BONK>` | 76 (74/76/77) | 100 | 96 | 100 | 0.8 s | 1,200 ms | 0 |

## Audits sous 0,9

- `/analyse` :
  - performance · `total-blocking-time` (0.46) Total Blocking Time — 640 ms
  - best-practices · `errors-in-console` (0) Browser errors were logged to the console
- `/analyse/<BONK>` :
  - performance · `largest-contentful-paint` (0.58) Largest Contentful Paint — 3.7 s
  - performance · `total-blocking-time` (0.29) Total Blocking Time — 950 ms
  - best-practices · `errors-in-console` (0) Browser errors were logged to the console
- `/t/<BONK>` :
  - performance · `total-blocking-time` (0.2) Total Blocking Time — 1,200 ms
  - best-practices · `errors-in-console` (0) Browser errors were logged to the console
