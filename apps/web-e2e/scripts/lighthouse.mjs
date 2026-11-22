// Lighthouse mobile (émulation mobile et throttling simulé par défaut de Lighthouse) sur l'écran
// d'analyse (docs/ARCHITECTURE.md §9.10, PROMPT.md §3) : build de production servi par
// scripts/serve-prod.mjs (port 4310), API réelle en mode fixtures (port 3100, `ANALYSIS_FIXTURES=1`).
// Chromium de Playwright (pas de téléchargement de navigateur). Médiane de RUNS passages par page.
// Sorties : rapports complets dans dist/lighthouse/ (non versionnés), résumé léger (scores, métriques,
// audits fautifs) dans docs/lighthouse/<phase>/summary.json et summary.md.
// Usage : node apps/web-e2e/scripts/lighthouse.mjs [--phase phase-3] [--runs 3] [--base http://127.0.0.1:4310]
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const PHASE = arg('phase', 'phase-3');
const RUNS = Number(arg('runs', '3'));
const BASE = arg('base', 'http://127.0.0.1:4310').replace(/\/$/, '');
const API = arg('api', 'http://localhost:3100').replace(/\/$/, '');
const THRESHOLD = Number(arg('threshold', '95'));
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];
const PAGES = [
  { name: 'analyse', path: '/analyse' },
  { name: 'analyse-bonk', path: `/analyse/${BONK}` },
  { name: 't-bonk', path: `/t/${BONK}` },
];

const fullDir = join(workspace, 'dist', 'lighthouse', PHASE);
const summaryDir = join(workspace, 'docs', 'lighthouse', PHASE);
mkdirSync(fullDir, { recursive: true });
mkdirSync(summaryDir, { recursive: true });

/** Publie une analyse récente de BONK (la page /t/<mint> lit la dernière analyse ≤ 24 h). */
async function ensureLatest() {
  const ip = `10.253.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  const csrfRes = await fetch(`${API}/api/v1/auth/csrf`, { headers: { 'X-Forwarded-For': ip } });
  const cookie = (csrfRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const { csrfToken } = await csrfRes.json();
  const res = await fetch(`${API}/api/v1/analyses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Origin: BASE, Cookie: cookie, 'X-Forwarded-For': ip },
    body: JSON.stringify({ input: BONK }),
  });
  if (res.status !== 200) throw new Error(`POST /analyses BONK : ${res.status} ${await res.text()}`);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function runLighthouse(url, out) {
  const bin = join(workspace, 'node_modules', '.bin', 'lighthouse');
  execFileSync(
    bin,
    [
      url,
      '--quiet',
      '--output=json',
      '--output=html',
      `--output-path=${out}`,
      `--only-categories=${CATEGORIES.join(',')}`,
      '--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage',
    ],
    { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, CHROME_PATH: chromium.executablePath() } },
  );
  return JSON.parse(readFileSync(`${out}.report.json`, 'utf8'));
}

/** Audits notés sous 0,9 (ou en échec binaire) qui pèsent dans une catégorie. */
function failingAudits(lhr, category) {
  return lhr.categories[category].auditRefs
    .filter((ref) => ref.weight > 0)
    .map((ref) => lhr.audits[ref.id])
    .filter((audit) => audit.score !== null && audit.score < 0.9)
    .map((audit) => ({ id: audit.id, score: audit.score, title: audit.title, displayValue: audit.displayValue ?? null }));
}

await ensureLatest();
const summary = { phase: PHASE, base: BASE, runs: RUNS, lighthouse: null, date: new Date().toISOString(), threshold: THRESHOLD, pages: [] };
let failed = false;
for (const page of PAGES) {
  const lhrs = [];
  for (let run = 1; run <= RUNS; run++) {
    const lhr = runLighthouse(`${BASE}${page.path}`, join(fullDir, `${page.name}-${run}`));
    summary.lighthouse = lhr.lighthouseVersion;
    lhrs.push(lhr);
  }
  // Passage retenu : médiane du score de performance (les 3 autres catégories sont déterministes).
  const perf = lhrs.map((lhr) => lhr.categories.performance.score);
  const chosen = lhrs[perf.indexOf(median(perf))];
  const scores = Object.fromEntries(CATEGORIES.map((c) => [c, Math.round(chosen.categories[c].score * 100)]));
  const entry = {
    name: page.name,
    url: page.path,
    scores,
    performanceRuns: perf.map((s) => Math.round(s * 100)),
    metrics: Object.fromEntries(
      ['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift', 'speed-index'].map((id) => [
        id,
        chosen.audits[id].displayValue,
      ]),
    ),
    failing: Object.fromEntries(CATEGORIES.map((c) => [c, failingAudits(chosen, c)]).filter(([, list]) => list.length > 0)),
    report: `dist/lighthouse/${PHASE}/${page.name}-${lhrs.indexOf(chosen) + 1}.report.html`,
  };
  if (CATEGORIES.some((c) => scores[c] < THRESHOLD)) failed = true;
  summary.pages.push(entry);
  console.log(`${page.path} : ${CATEGORIES.map((c) => `${c} ${scores[c]}`).join(' · ')} (perf ${entry.performanceRuns.join('/')})`);
}

writeFileSync(join(summaryDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
const lines = [
  `# Lighthouse mobile — ${PHASE}`,
  '',
  `Lighthouse ${summary.lighthouse}, émulation mobile par défaut (Moto G Power, 4G lente simulée), build de production servi par \`apps/web-e2e/scripts/serve-prod.mjs\`, API en mode fixtures. Médiane de ${RUNS} passages (performance). Seuil : ${THRESHOLD}. Généré par \`pnpm nx run web-e2e:lighthouse\` le ${summary.date.slice(0, 10)}.`,
  '',
  '| Page | Performance | Accessibilité | Best Practices | SEO | LCP | TBT | CLS |',
  '|---|---|---|---|---|---|---|---|',
  ...summary.pages.map(
    (p) =>
      `| \`${p.url.replace(BONK, '<BONK>')}\` | ${p.scores.performance} (${p.performanceRuns.join('/')}) | ${p.scores.accessibility} | ${p.scores['best-practices']} | ${p.scores.seo} | ${p.metrics['largest-contentful-paint']} | ${p.metrics['total-blocking-time']} | ${p.metrics['cumulative-layout-shift']} |`,
  ),
  '',
  '## Audits sous 0,9',
  '',
  ...summary.pages.flatMap((p) => {
    const entries = Object.entries(p.failing);
    if (entries.length === 0) return [`- \`${p.url.replace(BONK, '<BONK>')}\` : aucun`];
    return [
      `- \`${p.url.replace(BONK, '<BONK>')}\` :`,
      ...entries.flatMap(([category, list]) => list.map((a) => `  - ${category} · \`${a.id}\` (${a.score}) ${a.title}${a.displayValue ? ` — ${a.displayValue}` : ''}`)),
    ];
  }),
  '',
];
writeFileSync(join(summaryDir, 'summary.md'), lines.join('\n'));
if (failed) {
  console.error(`Au moins un score < ${THRESHOLD} (détail : docs/lighthouse/${PHASE}/summary.md)`);
  process.exit(1);
}
