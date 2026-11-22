# Lighthouse mobile — phase-3

Lighthouse 13.6.0, émulation mobile par défaut (Moto G Power, 4G lente simulée), build de production servi par `apps/web-e2e/scripts/serve-prod.mjs`, API en mode fixtures. Médiane de 5 passages (performance). Seuil : 95. Multiplicateur CPU : 4 (défaut) ; benchmarkIndex de la machine : 1108, 1071, 1075, 1305, 1196, 1321, 1200, 1238, 982, 1061, 1086, 1184, 1065, 1143, 1019 (Lighthouse attend > 1000). Généré par `pnpm nx run web-e2e:lighthouse` le 2026-11-22.

| Page | Performance | Accessibilité | Best Practices | SEO | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|
| `/analyse` | 87 (87/87/85/87/87) | 100 | 100 | 100 | 1.5 s | 490 ms | 0 |
| `/analyse/<BONK>` | 73 (75/76/72/73/72) | 100 | 100 | 100 | 3.6 s | 710 ms | 0 |
| `/t/<BONK>` | 78 (77/78/78/79/78) | 100 | 100 | 100 | 0.8 s | 1,060 ms | 0 |

## Passages (performance · benchmarkIndex · charge 1 min · TBT · LCP)

- `/analyse` : 87 · 1108 · 6.17 · 490 ms · 1.5 s | 87 · 1071 · 6.35 · 510 ms · 1.5 s | 85 · 1075 · 6.72 · 580 ms · 0.8 s | 87 · 1305 · 7.83 · 510 ms · 1.5 s | 87 · 1196 · 7.14 · 500 ms · 1.5 s
- `/analyse/<BONK>` : 75 · 1321 · 6.6 · 600 ms · 3.6 s | 76 · 1200 · 8.76 · 540 ms · 3.6 s | 72 · 1238 · 9.41 · 710 ms · 3.6 s | 73 · 982 · 8.3 · 710 ms · 3.6 s | 72 · 1061 · 7.98 · 700 ms · 3.7 s
- `/t/<BONK>` : 77 · 1086 · 7.85 · 1,140 ms · 0.8 s | 78 · 1184 · 7.71 · 1,060 ms · 0.8 s | 78 · 1065 · 7.16 · 990 ms · 0.8 s | 79 · 1143 · 6.95 · 900 ms · 0.8 s | 78 · 1019 · 6.78 · 970 ms · 0.8 s

## Audits sous 0,9

- `/analyse` :
  - performance · `total-blocking-time` (0.59) Total Blocking Time — 490 ms
- `/analyse/<BONK>` :
  - performance · `largest-contentful-paint` (0.62) Largest Contentful Paint — 3.6 s
  - performance · `total-blocking-time` (0.42) Total Blocking Time — 710 ms
- `/t/<BONK>` :
  - performance · `total-blocking-time` (0.25) Total Blocking Time — 1,060 ms
