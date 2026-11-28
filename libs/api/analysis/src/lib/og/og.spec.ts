import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testConfig } from '@raijin/api-core';
import type { AnalysisResult } from '@raijin/shared-contracts';
import type { AnalysisService } from '../analysis/analysis.service';
import { DefaultRiskEngine } from '../analysis/risk-engine.provider';
import { buildAnalysisResult } from '../analysis/result-builder';
import { FIXTURE_MINTS, FixtureFactsCollector, HOSTILE_TOKEN_NAME } from '../fixtures/fixture-facts-collector';
import { MemoryKeyValueStore } from '../store/key-value-store';
import { BRAND_ASSET_SOURCES, OG_COLORS, RAI_ALERT_SVG, RAI_HERO_SVG, RAIJIN_MARK_SVG } from './brand-assets';
import { OgImageService, OG_MAX_PENDING } from './og-image.service';
import { OgRenderer } from './og-renderer';
import { buildOgTree, cleanNameForImage, OG_NAME_MAX_LENGTH, ogModelFrom, type OgNode } from './og-template';

const ROOT = join(__dirname, '../../../../../..');
const NOW = new Date('2026-11-22T12:00:00.000Z');

async function result(mint: string): Promise<AnalysisResult> {
  const collected = await new FixtureFactsCollector({ now: () => NOW }).collectFacts(mint);
  if (!collected) throw new Error('fixture absente');
  return buildAnalysisResult(mint, collected, new DefaultRiskEngine().evaluate(collected.facts), NOW);
}

/** Dimensions d'un PNG (en-tête IHDR). */
function pngSize(png: Buffer): { width: number; height: number } {
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function texts(node: OgNode | string): string[] {
  if (typeof node === 'string') return [node];
  const children = node.props.children;
  if (children === undefined) return [];
  return (Array.isArray(children) ? children : [children]).flatMap(texts);
}

describe('charte embarquée', () => {
  it('copies identiques aux fichiers de libs/brand', () => {
    const copies = { RAIJIN_MARK_SVG, RAI_HERO_SVG, RAI_ALERT_SVG };
    for (const [name, path] of Object.entries(BRAND_ASSET_SOURCES)) {
      expect(copies[name as keyof typeof copies]).toBe(readFileSync(join(ROOT, path), 'utf8'));
    }
  });

  it('couleurs identiques au thème sombre de tokens.json', () => {
    const tokens = JSON.parse(readFileSync(join(ROOT, 'libs/brand/tokens.json'), 'utf8')) as {
      color: { tokens: { name: string; value: { dark: string } }[] };
    };
    for (const [name, value] of Object.entries(OG_COLORS)) {
      expect(tokens.color.tokens.find((token) => token.name === name)?.value.dark).toBe(value);
    }
  });
});

describe('texte de l’image', () => {
  it('nom hostile nettoyé, sans balise, borné', () => {
    const cleaned = cleanNameForImage(HOSTILE_TOKEN_NAME);
    expect(cleaned).not.toMatch(/[<>"\u202E\u200B]/);
    expect(Array.from(cleaned ?? '').length).toBeLessThanOrEqual(OG_NAME_MAX_LENGTH);
    expect(cleanNameForImage('Un nom de token vraiment beaucoup trop long pour l’image')).toMatch(/…$/);
    expect(cleanNameForImage('日本語🚀')).toBeNull();
    expect(cleanNameForImage(null)).toBeNull();
  });

  it('arbre : verdict icône + mot, mint tronqué, mention, nom marqué non vérifié', async () => {
    const tree = buildOgTree(ogModelFrom(await result(FIXTURE_MINTS.warn)));
    const all = texts(tree);
    expect(all).toContain('Prudence');
    expect(all).toContain('Raijin Shield');
    expect(all).toContain('Nom déclaré : « Prudence Demo » (non vérifié)');
    expect(all).toContain('8hVdV1…582K4u');
    expect(all.some((text) => text.includes('pas un conseil en investissement'))).toBe(true);
    expect(buildOgTree(ogModelFrom(null)).props.children).toBeDefined();
  });
});

describe('rendu PNG (satori + resvg-wasm)', () => {
  const renderer = new OgRenderer(null);

  it('image 1200×630 pour un verdict, nom hostile compris', async () => {
    const png = await renderer.render(ogModelFrom(await result(FIXTURE_MINTS.hostile)));
    expect(pngSize(png)).toEqual({ width: 1200, height: 630 });
    expect(png.length).toBeGreaterThan(5_000);
  }, 30_000);

  it('image générique sans analyse', async () => {
    const png = await renderer.render({ verdict: null, mint: null, name: null });
    expect(pngSize(png)).toEqual({ width: 1200, height: 630 });
  }, 30_000);

  it('polices introuvables : erreur explicite', async () => {
    const cwd = process.cwd();
    const broken = new OgRenderer('/dossier/inexistant');
    jest.spyOn(process, 'cwd').mockReturnValue('/');
    try {
      await expect(broken.render({ verdict: 'safe', mint: null, name: null })).rejects.toThrow(/Police OG introuvable/);
    } finally {
      jest.spyOn(process, 'cwd').mockReturnValue(cwd);
    }
  }, 30_000);
});

describe('OgImageService', () => {
  function setup(latest: AnalysisResult | null) {
    const analyses = { findLatest: jest.fn(async () => latest) } as unknown as AnalysisService;
    const store = new MemoryKeyValueStore();
    const service = new OgImageService(analyses, store, testConfig());
    return { service, store };
  }

  it('met en cache par mint, verdict et version du moteur ; ETag stable', async () => {
    const latest = await result(FIXTURE_MINTS.safe);
    const { service, store } = setup(latest);
    const first = await service.imageFor(FIXTURE_MINTS.safe);
    expect(pngSize(first.png)).toEqual({ width: 1200, height: 630 });
    await expect(store.get(`og:${FIXTURE_MINTS.safe}:safe:${latest.engineVersion}`)).resolves.toBe(first.png.toString('base64'));
    const second = await service.imageFor(FIXTURE_MINTS.safe);
    expect(second.etag).toBe(first.etag);
  }, 30_000);

  it('mint jamais analysé ou invalide : image générique', async () => {
    const { service } = setup(null);
    const generic = await service.imageFor(FIXTURE_MINTS.notFound);
    expect(generic.etag).toBe((await service.generic()).etag);
  }, 30_000);

  it('rendu impossible ou file pleine : image générique', async () => {
    const latest = await result(FIXTURE_MINTS.danger);
    const { service } = setup(latest);
    const generic = await service.generic();
    const renderer = (service as unknown as { renderer: OgRenderer }).renderer;
    jest.spyOn(renderer, 'render').mockRejectedValueOnce(new Error('rendu'));
    expect((await service.imageFor(FIXTURE_MINTS.danger)).etag).toBe(generic.etag);
    (service as unknown as { pending: number }).pending = OG_MAX_PENDING;
    expect((await service.imageFor(FIXTURE_MINTS.danger)).etag).toBe(generic.etag);
  }, 30_000);
});
