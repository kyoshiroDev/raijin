import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import satori from 'satori';
import { buildOgTree, OG_HEIGHT, OG_WIDTH, type OgAssets, type OgPage } from './template';

/**
 * Rendu PNG des images Open Graph **au build** (docs/ARCHITECTURE.md §15.6) : satori (arbre → SVG, texte en tracés)
 * puis resvg en WebAssembly (aucun binaire natif). Polices WOFF `@fontsource` (satori ne lit pas le WOFF2).
 */
const FONT_FILES = [
  { name: 'Space Grotesk', weight: 700, file: '@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff' },
  { name: 'Inter', weight: 400, file: '@fontsource/inter/files/inter-latin-400-normal.woff' },
] as const;

const load = createRequire(join(process.cwd(), 'package.json'));
let wasmReady: Promise<void> | null = null;
let fonts: { name: string; data: Buffer; weight: 400 | 700; style: 'normal' }[] | null = null;

function ensureWasm(): Promise<void> {
  wasmReady ??= initWasm(readFileSync(load.resolve('@resvg/resvg-wasm/index_bg.wasm'))).catch((error: unknown) => {
    // Déjà initialisé dans ce processus (autre module) : sans conséquence.
    if (error instanceof Error && /already/i.test(error.message)) return;
    wasmReady = null;
    throw error;
  });
  return wasmReady;
}

type SatoriElement = Parameters<typeof satori>[0];

export async function renderOgPng(page: OgPage, assets: OgAssets): Promise<Uint8Array> {
  await ensureWasm();
  fonts ??= FONT_FILES.map((font) => ({
    name: font.name,
    weight: font.weight,
    style: 'normal' as const,
    data: readFileSync(load.resolve(font.file)),
  }));
  const svg = await satori(buildOgTree(page, assets) as unknown as SatoriElement, {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts,
  });
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: OG_WIDTH } });
  try {
    return resvg.render().asPng();
  } finally {
    resvg.free();
  }
}
