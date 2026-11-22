// Rend en PNG les images de Raijin utilisées hors de l'app (docs/ARCHITECTURE.md §11.7 et §11.8) :
// - Rai (poses alerte et bravo) en 2x pour les e-mails : 240 × 280 px, affichées en 120 × 140 ;
// - le badge monochrome des notifications push (72 × 72 px, blanc sur transparent).
// Source : libs/brand (lecture seule, aucun SVG modifié). Rendu par @resvg/resvg-wasm : aucun
// binaire natif. Sortie commitée dans apps/web/public (servie sous /email/ et /icons/).
//
// Usage : node tools/scripts/render-mascot-png.mjs           → écrit les PNG et le manifeste
//         node tools/scripts/render-mascot-png.mjs --check   → vérifie dimensions et fraîcheur
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

const root = join(import.meta.dirname, '..', '..');
const publicDir = join(root, 'apps', 'web', 'public');
// Empreintes des sources, hors du dossier public (non servi).
const manifestPath = join(root, 'apps', 'web', 'brand-png.lock.json');

/** Images produites : source, sortie, largeur rendue, hauteur attendue, transformation en mémoire. */
export const TARGETS = [
  { source: 'libs/brand/mascot/rai-alerte.svg', output: 'email/rai-alerte@2x.png', width: 240, height: 280 },
  { source: 'libs/brand/mascot/rai-bravo.svg', output: 'email/rai-bravo@2x.png', width: 240, height: 280 },
  {
    source: 'libs/brand/logos/raijin-mark.svg',
    output: 'icons/badge-72.png',
    width: 72,
    height: 72,
    // Badge Android : seul le canal alpha compte ; symbole en blanc, fond transparent.
    transform: (svg) => svg.replaceAll('currentColor', '#ffffff'),
  },
];

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Largeur et hauteur lues dans l'en-tête IHDR d'un PNG. */
export function pngSize(buffer) {
  const signature = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== signature || buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('Fichier PNG invalide');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function render() {
  const require = createRequire(import.meta.url);
  await initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
  const manifest = {};
  for (const target of TARGETS) {
    const source = readFileSync(join(root, target.source), 'utf8');
    const svg = target.transform ? target.transform(source) : source;
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: target.width }, background: 'rgba(0,0,0,0)' }).render().asPng();
    const size = pngSize(Buffer.from(png));
    if (size.width !== target.width || size.height !== target.height) {
      throw new Error(`${target.output} : ${size.width}×${size.height} au lieu de ${target.width}×${target.height}`);
    }
    const out = join(publicDir, target.output);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, png);
    manifest[target.output] = { source: target.source, sourceSha256: sha256(source), width: size.width, height: size.height };
    console.log(`${relative(root, out)} : ${size.width}×${size.height}`);
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Vérifie que chaque PNG existe, a la bonne taille et a été rendu depuis la version actuelle du SVG. */
function check() {
  const errors = [];
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  for (const target of TARGETS) {
    const out = join(publicDir, target.output);
    if (!existsSync(out)) {
      errors.push(`${target.output} absent`);
      continue;
    }
    const size = pngSize(readFileSync(out));
    if (size.width !== target.width || size.height !== target.height) {
      errors.push(`${target.output} : ${size.width}×${size.height} au lieu de ${target.width}×${target.height}`);
    }
    const expected = sha256(readFileSync(join(root, target.source), 'utf8'));
    if (manifest[target.output]?.sourceSha256 !== expected) {
      errors.push(`${target.output} : rendu depuis une ancienne version de ${target.source}`);
    }
  }
  errors.push(...checkMaintenanceTokens());
  if (errors.length > 0) {
    console.error(`PNG de la charte à régénérer (pnpm nx run web:render-mascot-png) :\n- ${errors.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`${TARGETS.length} PNG à jour (dimensions et empreinte des SVG sources), maintenance-static.css conforme aux tokens.`);
}

/** La page statique `maintenance-static.css` recopie des tokens : mêmes valeurs que libs/brand/tokens.css. */
function checkMaintenanceTokens() {
  const tokens = readFileSync(join(root, 'libs', 'brand', 'tokens.css'), 'utf8');
  const theme = tokens.match(/@theme\s*{([\s\S]*?)}/)?.[1] ?? '';
  const page = readFileSync(join(publicDir, 'maintenance-static.css'), 'utf8');
  const errors = [];
  for (const [, name, value] of page.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    const expected = theme.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();
    if (expected !== value.trim()) errors.push(`maintenance-static.css : ${name} = ${value.trim()} ≠ tokens.css ${expected ?? '(absent)'}`);
  }
  return errors;
}

if (process.argv.includes('--check')) {
  check();
} else {
  await render();
}
