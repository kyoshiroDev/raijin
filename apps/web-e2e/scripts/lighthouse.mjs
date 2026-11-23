// Lighthouse mobile (émulation mobile et throttling simulé par défaut de Lighthouse) sur l'écran
// d'analyse (docs/ARCHITECTURE.md §9.10, PROMPT.md §3) : build de production servi par
// scripts/serve-prod.mjs (port 4310), API réelle en mode fixtures (port 3100, `ANALYSIS_FIXTURES=1`).
// Landing (phase 7, docs/ARCHITECTURE.md §15.7) : accueil, tarifs et un guide, build statique de mesure
// (identifiant GA4 factice : la bannière de consentement d'une première visite est rendue, aucune requête
// Google avant l'accord) servi compressé par scripts/serve-landing.mjs (port 4332, cible web-e2e:serve-landing-lighthouse).
// Chromium de Playwright (pas de téléchargement de navigateur). Médiane de RUNS passages par page.
// Sorties : rapports complets dans dist/lighthouse/ (non versionnés), résumé léger (scores, métriques,
// audits fautifs) dans docs/lighthouse/<phase>/summary.json et summary.md.
// Usage : node apps/web-e2e/scripts/lighthouse.mjs [--phase phase-7] [--runs 3] [--pages all|app|landing]
//   [--base http://127.0.0.1:4310] [--landing http://127.0.0.1:4332]
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const PHASE = arg('phase', 'phase-7');
const RUNS = Number(arg('runs', '3'));
const BASE = arg('base', 'http://127.0.0.1:4310').replace(/\/$/, '');
const API = arg('api', 'http://localhost:3100').replace(/\/$/, '');
const LANDING = arg('landing', 'http://127.0.0.1:4332').replace(/\/$/, '');
// Pages mesurées : toutes (défaut), celles de l'app seules ou celles de la landing seules.
const SCOPE = arg('pages', 'all');
if (!['all', 'app', 'landing'].includes(SCOPE)) throw new Error(`--pages invalide : « ${SCOPE} » (attendu : all, app, landing)`);
const THRESHOLD = Number(arg('threshold', '95'));
// Multiplicateur CPU du throttling simulé : 4 (défaut Lighthouse) fait foi. Une autre valeur ne sert
// qu'au diagnostic sur une machine lente (benchmarkIndex < 1000, avertissement Lighthouse), voir
// docs/ARCHITECTURE.md §10 ; elle est alors notée dans le résumé.
const CPU = arg('cpu', null);
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];
const ALL_PAGES = [
  { site: 'app', name: 'analyse', path: '/analyse' },
  { site: 'app', name: 'analyse-bonk', path: `/analyse/${BONK}` },
  { site: 'app', name: 't-bonk', path: `/t/${BONK}` },
  { site: 'landing', name: 'landing-accueil', path: '/' },
  { site: 'landing', name: 'landing-tarifs', path: '/tarifs' },
  { site: 'landing', name: 'landing-guide-rug-pull', path: '/guides/rug-pull-solana' },
];
const PAGES = ALL_PAGES.filter((page) => SCOPE === 'all' || page.site === SCOPE);
const origin = (page) => (page.site === 'landing' ? LANDING : BASE);
/** Libellé d'une page dans le résumé (mint remplacé, landing préfixée). */
const label = (page) => `${page.site === 'landing' ? 'landing ' : ''}${page.url.replace(BONK, '<BONK>')}`;

const fullDir = join(workspace, 'dist', 'lighthouse', PHASE);
const summaryDir = join(workspace, 'docs', 'lighthouse', PHASE);
mkdirSync(fullDir, { recursive: true });
mkdirSync(summaryDir, { recursive: true });

/** Publie une analyse récente de BONK (la page /t/<mint> lit la dernière analyse ≤ 24 h). */
async function ensureLatest(attempt = 1) {
  try {
    await publishLatest();
  } catch (error) {
    // Connexion keep-alive fermée par l'API pendant un passage Lighthouse (~30 s) : on réessaie.
    if (attempt >= 3) throw error;
    await ensureLatest(attempt + 1);
  }
}

async function publishLatest() {
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

/** Erreurs transitoires de Lighthouse (ex. NO_NAVSTART sur machine chargée) : jusqu'à 3 tentatives. */
function runLighthouse(url, out, attempt = 1) {
  try {
    return runLighthouseOnce(url, out);
  } catch (error) {
    if (attempt >= 3) throw error;
    console.warn(`Lighthouse ${url} : échec de la tentative ${attempt}, nouvel essai`);
    return runLighthouse(url, out, attempt + 1);
  }
}

function runLighthouseOnce(url, out) {
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
      ...(CPU ? [`--throttling.cpuSlowdownMultiplier=${CPU}`] : []),
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

/**
 * Nx lance cette cible dès que les tâches continues (serve-prod, serve-api-fixtures) ont démarré, sans
 * garantir qu'elles écoutent déjà : on attend l'API et le serveur de production (2 min au plus).
 */
async function waitFor(url, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Pas encore à l'écoute.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} injoignable après ${timeoutMs / 1000} s (${url})`);
}

if (PAGES.some((page) => page.site === 'app')) {
  await waitFor(`${API}/api/v1/health`, 'API');
  await waitFor(`${BASE}/manifest.webmanifest`, 'Serveur de production');
}
// La cible de la landing construit le site avant de le servir (Astro, ~1 min sur le runner) : 5 min au plus.
if (PAGES.some((page) => page.site === 'landing')) await waitFor(`${LANDING}/robots.txt`, 'Landing', 300_000);

const summary = {
  phase: PHASE,
  base: BASE,
  landing: LANDING,
  runs: RUNS,
  lighthouse: null,
  date: new Date().toISOString(),
  threshold: THRESHOLD,
  cpuSlowdownMultiplier: CPU ? Number(CPU) : 4,
  pages: [],
};
let failed = false;
for (const page of PAGES) {
  const lhrs = [];
  const passes = [];
  for (let run = 1; run <= RUNS; run++) {
    // Analyse récente et en cache avant chaque passage : on mesure le front, pas une analyse
    // recalculée par l'API (le cache d'un résultat partiel est court, docs/ARCHITECTURE.md §9.5).
    if (page.site === 'app') await ensureLatest();
    const load = loadavg()[0];
    const lhr = runLighthouse(`${origin(page)}${page.path}`, join(fullDir, `${page.name}-${run}`));
    summary.lighthouse = lhr.lighthouseVersion;
    lhrs.push(lhr);
    passes.push({
      performance: Math.round(lhr.categories.performance.score * 100),
      benchmarkIndex: Math.round(lhr.environment.benchmarkIndex),
      load1m: Math.round(load * 100) / 100,
      tbt: lhr.audits['total-blocking-time'].displayValue,
      lcp: lhr.audits['largest-contentful-paint'].displayValue,
    });
  }
  // Passage retenu : médiane du score de performance (les 3 autres catégories sont déterministes).
  const perf = lhrs.map((lhr) => lhr.categories.performance.score);
  const chosen = lhrs[perf.indexOf(median(perf))];
  const scores = Object.fromEntries(CATEGORIES.map((c) => [c, Math.round(chosen.categories[c].score * 100)]));
  const entry = {
    name: page.name,
    site: page.site,
    url: page.path,
    scores,
    performanceRuns: perf.map((s) => Math.round(s * 100)),
    passes,
    benchmarkIndex: lhrs.map((lhr) => Math.round(lhr.environment.benchmarkIndex)),
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
  console.log(`${label(entry)} : ${CATEGORIES.map((c) => `${c} ${scores[c]}`).join(' · ')} (perf ${entry.performanceRuns.join('/')})`);
}

writeFileSync(join(summaryDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
const lines = [
  `# Lighthouse mobile — ${PHASE}`,
  '',
  `Lighthouse ${summary.lighthouse}, émulation mobile par défaut (Moto G Power, 4G lente simulée), app : build de production servi par \`apps/web-e2e/scripts/serve-prod.mjs\`, API en mode fixtures ; landing : build statique (GA4 factice, bannière de consentement affichée) servi compressé par \`apps/web-e2e/scripts/serve-landing.mjs\`. Médiane de ${RUNS} passages (performance). Seuil : ${THRESHOLD}. Multiplicateur CPU : ${summary.cpuSlowdownMultiplier}${summary.cpuSlowdownMultiplier === 4 ? ' (défaut)' : ' (diagnostic, ne fait pas foi)'} ; benchmarkIndex de la machine : ${summary.pages.flatMap((p) => p.benchmarkIndex).join(', ')} (Lighthouse attend > 1000). Généré par \`pnpm nx run web-e2e:lighthouse\` le ${summary.date.slice(0, 10)}.`,
  '',
  '| Page | Performance | Accessibilité | Best Practices | SEO | LCP | TBT | CLS |',
  '|---|---|---|---|---|---|---|---|',
  ...summary.pages.map(
    (p) =>
      `| \`${label(p)}\` | ${p.scores.performance} (${p.performanceRuns.join('/')}) | ${p.scores.accessibility} | ${p.scores['best-practices']} | ${p.scores.seo} | ${p.metrics['largest-contentful-paint']} | ${p.metrics['total-blocking-time']} | ${p.metrics['cumulative-layout-shift']} |`,
  ),
  '',
  '## Passages (performance · benchmarkIndex · charge 1 min · TBT · LCP)',
  '',
  ...summary.pages.map(
    (p) => `- \`${label(p)}\` : ${p.passes.map((x) => `${x.performance} · ${x.benchmarkIndex} · ${x.load1m} · ${x.tbt} · ${x.lcp}`).join(' | ')}`,
  ),
  '',
  '## Audits sous 0,9',
  '',
  ...summary.pages.flatMap((p) => {
    const entries = Object.entries(p.failing);
    if (entries.length === 0) return [`- \`${label(p)}\` : aucun`];
    return [
      `- \`${label(p)}\` :`,
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
