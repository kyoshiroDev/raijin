import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import satori from 'satori';
import { loadOgFonts, type OgFont } from './og-fonts';
import { buildOgTree, OG_HEIGHT, OG_WIDTH, type OgModel } from './og-template';

let wasmReady: Promise<void> | null = null;

/** Charge le module WebAssembly de resvg une seule fois par processus (aucun binaire natif). */
function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      const load = createRequire(join(process.cwd(), 'package.json'));
      await initWasm(readFileSync(load.resolve('@resvg/resvg-wasm/index_bg.wasm')));
    })().catch((error: unknown) => {
      wasmReady = null;
      throw error;
    });
  }
  return wasmReady;
}

type SatoriElement = Parameters<typeof satori>[0];

/** Rendu PNG 1200×630 : satori (arbre → SVG, texte en tracés) puis resvg-wasm (SVG → PNG). */
export class OgRenderer {
  private fonts: OgFont[] | null = null;

  constructor(private readonly fontsDir: string | null) {}

  async render(model: OgModel): Promise<Buffer> {
    await ensureWasm();
    this.fonts ??= loadOgFonts(this.fontsDir);
    const svg = await satori(buildOgTree(model) as unknown as SatoriElement, {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      fonts: this.fonts.map((font) => ({ ...font })),
    });
    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: OG_WIDTH } });
    try {
      return Buffer.from(resvg.render().asPng());
    } finally {
      resvg.free();
    }
  }
}
