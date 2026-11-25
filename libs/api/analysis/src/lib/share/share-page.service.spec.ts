import { testConfig } from '@raijin/api-core';
import type { AnalysisResult } from '@raijin/shared-contracts';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisService } from '../analysis/analysis.service';
import { DefaultRiskEngine } from '../analysis/risk-engine.provider';
import { buildAnalysisResult } from '../analysis/result-builder';
import { FIXTURE_MINTS, FixtureFactsCollector, HOSTILE_TOKEN_NAME } from '../fixtures/fixture-facts-collector';
import { escapeHtml, injectMeta, injectStaticVerdict, minimalHtml, renderStaticVerdict, SharePageService } from './share-page.service';

const NOW = new Date('2026-11-22T12:00:00.000Z');

async function hostileResult(): Promise<AnalysisResult> {
  const collected = await new FixtureFactsCollector({ now: () => NOW }).collectFacts(FIXTURE_MINTS.hostile);
  if (!collected) throw new Error('fixture absente');
  return buildAnalysisResult(FIXTURE_MINTS.hostile, collected, new DefaultRiskEngine().evaluate(collected.facts), NOW);
}

const WEB_INDEX = `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title>Raijin</title>
    <base href="/" />
    <meta name="description" content="Description d'origine" />
    <meta property="og:title" content="ancien" />
    <meta name="twitter:card" content="summary" />
    <link rel="canonical" href="https://ancien.example/" />
  </head>
  <body>
    <rj-root></rj-root>
  </body>
</html>`;

function service(result: AnalysisResult | null, env: Record<string, string> = {}) {
  const analyses = { findLatest: jest.fn(async () => result) } as unknown as AnalysisService;
  return new SharePageService(analyses, testConfig({ APP_URL: 'https://app.raijinshield.com', API_URL: 'https://api.raijinshield.com', ...env }));
}

function indexFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'raijin-share-'));
  const path = join(dir, 'index.html');
  writeFileSync(path, WEB_INDEX);
  return path;
}

describe('escapeHtml', () => {
  it('échappe les 5 caractères sensibles', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});

describe('SharePageService', () => {
  it('nom et symbole hostiles : aucune balise injectée, valeurs échappées, marqués non vérifiés', async () => {
    const result = await hostileResult();
    const html = await service(result, { WEB_INDEX_HTML_PATH: indexFile() }).render(FIXTURE_MINTS.hostile);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toContain('onload="y"');
    expect(html).not.toMatch(/[\u202E\u200B]/);
    expect(html).toContain('(non vérifié)');
    expect(html).toContain('&quot;&gt;&lt;img src=x&gt;');
    // Toutes les valeurs d'attributs sont fermées proprement : aucune balise meta cassée.
    for (const tag of html.match(/<meta [^>]*>/g) ?? []) expect(tag).toMatch(/^<meta (name|property|charset)=/);
    expect(HOSTILE_TOKEN_NAME).toContain('<script>');
  });

  it('remplace titre, description, OG, Twitter et canonique du build web, une seule fois chacun', async () => {
    const result = await hostileResult();
    const html = await service({ ...result, verdict: 'warn' }, { WEB_INDEX_HTML_PATH: indexFile() }).render(FIXTURE_MINTS.hostile);
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain('<title>Prudence · token 8hVd…Q6kU · Raijin Shield</title>');
    expect(html).not.toContain("Description d'origine");
    expect(html).not.toContain('ancien');
    expect(html.match(/property="og:title"/g)).toHaveLength(1);
    expect(html).toContain(`<link rel="canonical" href="https://app.raijinshield.com/t/${FIXTURE_MINTS.hostile}" />`);
    expect(html).toContain(`<meta property="og:image" content="https://api.raijinshield.com/api/v1/og/${FIXTURE_MINTS.hostile}.png" />`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain('pas un conseil en investissement');
    expect(html).toContain('<rj-root><header class="rj-static__header">');
    expect(html).toContain('<base href="/" />');
  });

  it('mint sans analyse : balises génériques du token, aucun verdict statique', async () => {
    const html = await service(null, { WEB_INDEX_HTML_PATH: indexFile() }).render(FIXTURE_MINTS.safe);
    expect(html).toContain('<title>Token 8hVd…Gypt · Raijin Shield</title>');
    expect(html).toContain('<rj-root></rj-root>');
    expect(html).not.toContain('data-rj-static');
  });

  it('mint invalide : page générique vers /analyse', async () => {
    const page = service(null);
    const html = await page.render(null);
    expect(html).toContain('<title>Analyse de token Solana · Raijin Shield</title>');
    expect(html).toContain('href="https://app.raijinshield.com/analyse"');
  });

  it('sans build web (ou fichier illisible) : HTML minimal avec lien vers l’app', async () => {
    const html = await service(null).render(FIXTURE_MINTS.safe);
    expect(html).toContain(`href="https://app.raijinshield.com/t/${FIXTURE_MINTS.safe}"`);
    expect(html).toContain('property="og:title"');
    const missing = await service(null, { WEB_INDEX_HTML_PATH: '/chemin/inexistant/index.html' }).render(FIXTURE_MINTS.safe);
    expect(missing).toContain('Ouvrir l’analyse dans Raijin');
  });

  it('relit index.html quand il change (nouveau build web), sans redémarrage', async () => {
    const path = indexFile();
    const page = service(null, { WEB_INDEX_HTML_PATH: path });
    expect(await page.render(FIXTURE_MINTS.safe)).toContain('<rj-root></rj-root>');
    writeFileSync(path, WEB_INDEX.replace('<rj-root></rj-root>', '<rj-root></rj-root><script src="main-NOUVEAU.js"></script>'));
    const later = new Date(Date.now() + 5_000);
    utimesSync(path, later, later);
    expect(await page.render(FIXTURE_MINTS.safe)).toContain('main-NOUVEAU.js');
  });

  it('injectMeta insère avant </head>, minimalHtml échappe le lien', () => {
    const html = injectMeta(minimalHtml('https://app.example', null), {
      title: 'T',
      description: 'D',
      canonical: 'https://app.example/x',
      image: 'https://api.example/i.png',
      imageAlt: 'A',
    });
    expect(html.indexOf('<title>T</title>')).toBeLessThan(html.indexOf('</head>'));
  });
});

const SHELL_INDEX = `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title>Raijin</title>
    <script src="analyse-prefetch.js"></script>
    <link rel="modulepreload" href="chunk-ABC.js" />
  </head>
  <body>
    <RJ-ROOT ng-version="x"></RJ-ROOT>
    <script src="main-ABC123.js" type="module"></script>
  </body>
</html>`;

function staticResult(overrides: Partial<AnalysisResult> = {}, token: Partial<AnalysisResult['token']> = {}): AnalysisResult {
  return {
    mint: FIXTURE_MINTS.safe,
    verdict: 'safe',
    explanation: 'Aucun signal critique détecté.',
    analyzedAt: '2026-11-22T14:03:00.000Z',
    degraded: false,
    ...overrides,
    token: { name: 'Bonk', symbol: 'BONK', decimals: 5, tokenProgram: 'spl-token', ...token },
  } as unknown as AnalysisResult;
}

function indexWith(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'raijin-share-'));
  const path = join(dir, 'index.html');
  writeFileSync(path, content);
  return path;
}

describe('renderStaticVerdict', () => {
  it.each(['safe', 'warn', 'danger'] as const)('verdict %s', (verdict) => {
    expect(renderStaticVerdict(staticResult({ verdict }), FIXTURE_MINTS.safe)).toMatchSnapshot();
  });

  it('résultat partiel (degraded)', () => {
    const html = renderStaticVerdict(staticResult({ verdict: 'warn', degraded: true }), FIXTURE_MINTS.safe);
    expect(html).toContain('<p class="rj-static__note">Résultat partiel : une source était indisponible.</p>');
    expect(html).toMatchSnapshot();
  });

  it('sans symbole : repli sur le nom, puis aucune ligne', () => {
    expect(renderStaticVerdict(staticResult({}, { symbol: null }), FIXTURE_MINTS.safe)).toContain('Symbole déclaré « Bonk » (non vérifié)');
    const html = renderStaticVerdict(staticResult({}, { symbol: null, name: null }), FIXTURE_MINTS.safe);
    expect(html).not.toContain('rj-static__token');
    expect(html).toMatchSnapshot();
  });

  it('nom piégé : rendu inerte, bidi retiré, tronqué à 32 caractères sans couper un emoji', () => {
    const trap = `</rj-root><script>alert("x")</script> ' & \u202Eevil\u2066 🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀`;
    const html = renderStaticVerdict(staticResult({}, { symbol: null, name: trap }), FIXTURE_MINTS.safe);
    expect(html).not.toMatch(/<script|<\/rj-root>/i);
    expect(html).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F]/);
    expect(html).not.toMatch(/ on\w+=|style=/i);
    expect(html).toContain('&lt;/rj-root&gt;&lt;script&gt;');
    expect(html).toContain('&quot;');
    const token = /« (.*) » \(non vérifié\)/.exec(html)?.[1] ?? '';
    const decoded = token.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    expect(Array.from(decoded).length).toBeLessThanOrEqual(32);
    expect(decoded).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('en-tête minimal : symbole et logotype officiels inline, décoratifs, lien vers l’accueil, sans style ni ressource externe', () => {
    const html = renderStaticVerdict(staticResult(), FIXTURE_MINTS.safe);
    expect(html.indexOf('<header class="rj-static__header">')).toBe(0);
    expect(html.indexOf('</header>')).toBeLessThan(html.indexOf('<main data-rj-static="t"'));
    expect(html).toContain('<a class="rj-static__brand" href="/" aria-label="Raijin Shield, accueil">');
    expect(html).toContain('<svg class="rj-static__logo rj-static__logo--mark" viewBox="8 2 48 60" aria-hidden="true" focusable="false">');
    expect(html).toContain('<svg class="rj-static__logo rj-static__logo--wordmark" viewBox="8 2 204 60" aria-hidden="true" focusable="false">');
    expect(html).toMatch(/<text class="rj-static__logo-name"[^>]*>Raijin<\/text>/);
    expect(html).toMatch(/<text class="rj-static__logo-tagline"[^>]*>SHIELD<\/text>/);
    expect(html).not.toMatch(/style=|<img|<use|xlink|https?:\/\/|<script/i);
  });

  it('symbole contenant & et apostrophe : échappés', () => {
    const html = renderStaticVerdict(staticResult({}, { symbol: `A&B'"` }), FIXTURE_MINTS.safe);
    expect(html).toContain('« A&amp;B&#39;&quot; »');
  });
});

describe('injection du verdict statique', () => {
  it('dans <rj-root> du build web, head, main-*.js et analyse-prefetch.js intacts', async () => {
    const html = await service(staticResult({ verdict: 'warn' }), { WEB_INDEX_HTML_PATH: indexWith(SHELL_INDEX) }).render(FIXTURE_MINTS.safe);
    expect(html).toMatch(/<RJ-ROOT ng-version="x"><header class="rj-static__header">[\s\S]*<\/header>\n<main data-rj-static="t"[\s\S]*<\/main><\/RJ-ROOT>/);
    expect(html.match(/data-rj-static/g)).toHaveLength(1);
    expect(html).toContain('<p class="rj-static__verdict" data-verdict="warn" role="status" aria-label="Verdict : Prudence">Prudence</p>');
    expect(html).toContain('<script src="main-ABC123.js" type="module"></script>');
    expect(html).toContain('<script src="analyse-prefetch.js"></script>');
    expect(html).toContain('<link rel="modulepreload" href="chunk-ABC.js" />');
    expect(html).toContain('property="og:title"');
  });

  it('nom piégé : ne ferme pas <rj-root> et n’ajoute aucun script', async () => {
    const result = staticResult({}, { symbol: null, name: '</rj-root><script>alert(1)</script>' });
    const html = await service(result, { WEB_INDEX_HTML_PATH: indexWith(SHELL_INDEX) }).render(FIXTURE_MINTS.safe);
    expect(html.match(/<\/rj-root>/gi)).toHaveLength(1);
    expect(html.match(/<script/gi)).toHaveLength(2);
  });

  it('gabarit sans <rj-root> : aucune injection', async () => {
    const path = indexWith(SHELL_INDEX.replace('<RJ-ROOT ng-version="x"></RJ-ROOT>', ''));
    const html = await service(staticResult(), { WEB_INDEX_HTML_PATH: path }).render(FIXTURE_MINTS.safe);
    expect(html).not.toContain('data-rj-static');
    expect(injectStaticVerdict('<body></body>', '<main></main>')).toBeNull();
  });

  it('sans build web (HTML minimal) : aucune injection', async () => {
    const html = await service(staticResult()).render(FIXTURE_MINTS.safe);
    expect(html).not.toContain('data-rj-static');
  });

  it('mint invalide : aucune injection', async () => {
    const html = await service(staticResult(), { WEB_INDEX_HTML_PATH: indexWith(SHELL_INDEX) }).render(null);
    expect(html).not.toContain('data-rj-static');
  });

  it('contenu avec motifs $& : inséré tel quel', () => {
    expect(injectStaticVerdict('<rj-root></rj-root>', 'a$&b')).toBe('<rj-root>a$&b</rj-root>');
  });
});
