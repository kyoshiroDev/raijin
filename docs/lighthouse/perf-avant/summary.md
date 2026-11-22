# Lighthouse mobile — perf-avant

Lighthouse 13.6.0, émulation mobile par défaut (Moto G Power, 4G lente simulée), build de production servi par `apps/web-e2e/scripts/serve-prod.mjs`, API en mode fixtures. Médiane de 1 passages (performance). Seuil : 95. Généré par `pnpm nx run web-e2e:lighthouse` le 2026-11-22.

| Page | Performance | Accessibilité | Best Practices | SEO | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|
| `/analyse` | 62 (62) | 100 | 96 | 100 | 3.9 s | 1,520 ms | 0.013 |
| `/analyse/<BONK>` | 57 (57) | 100 | 96 | 100 | 4.8 s | 1,540 ms | 0.014 |
| `/t/<BONK>` | 66 (66) | 100 | 92 | 100 | 3.7 s | 1,180 ms | 0 |

## Audits sous 0,9

- `/analyse` :
  - performance · `largest-contentful-paint` (0.51) Largest Contentful Paint — 3.9 s
  - performance · `total-blocking-time` (0.13) Total Blocking Time — 1,520 ms
  - best-practices · `errors-in-console` (0) Browser errors were logged to the console
- `/analyse/<BONK>` :
  - performance · `largest-contentful-paint` (0.31) Largest Contentful Paint — 4.8 s
  - performance · `total-blocking-time` (0.13) Total Blocking Time — 1,540 ms
  - best-practices · `errors-in-console` (0) Browser errors were logged to the console
- `/t/<BONK>` :
  - performance · `largest-contentful-paint` (0.59) Largest Contentful Paint — 3.7 s
  - performance · `total-blocking-time` (0.21) Total Blocking Time — 1,180 ms
  - best-practices · `errors-in-console` (0) Browser errors were logged to the console
  - best-practices · `inspector-issues` (0) Issues were logged in the `Issues` panel in Chrome Devtools
