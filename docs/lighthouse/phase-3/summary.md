# Lighthouse mobile — phase-3

Lighthouse 13.6.0, émulation mobile par défaut (Moto G Power, 4G lente simulée), build de production servi par `apps/web-e2e/scripts/serve-prod.mjs`, API en mode fixtures. Médiane de 3 passages (performance). Seuil : 95. Généré par `pnpm nx run web-e2e:lighthouse` le 2026-11-22.

| Page | Performance | Accessibilité | Best Practices | SEO | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|
| `/analyse` | 62 (61/68/62) | 100 | 96 | 100 | 4.0 s | 1,480 ms | 0.013 |
| `/analyse/<BONK>` | 54 (51/58/54) | 100 | 96 | 100 | 5.1 s | 1,670 ms | 0.014 |
| `/t/<BONK>` | 62 (62/60/64) | 100 | 92 | 100 | 4.0 s | 1,490 ms | 0 |

## Audits sous 0,9

- `/analyse` :
  - performance · `largest-contentful-paint` (0.5) Largest Contentful Paint — 4.0 s
  - performance · `total-blocking-time` (0.14) Total Blocking Time — 1,480 ms
  - best-practices · `errors-in-console` (0) Browser errors were logged to the console
- `/analyse/<BONK>` :
  - performance · `largest-contentful-paint` (0.24) Largest Contentful Paint — 5.1 s
  - performance · `total-blocking-time` (0.11) Total Blocking Time — 1,670 ms
  - best-practices · `errors-in-console` (0) Browser errors were logged to the console
- `/t/<BONK>` :
  - performance · `largest-contentful-paint` (0.51) Largest Contentful Paint — 4.0 s
  - performance · `total-blocking-time` (0.14) Total Blocking Time — 1,490 ms
  - best-practices · `errors-in-console` (0) Browser errors were logged to the console
  - best-practices · `inspector-issues` (0) Issues were logged in the `Issues` panel in Chrome Devtools
