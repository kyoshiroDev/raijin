// Serveur statique de la landing Astro pour les tests de bout en bout (phase 6 bis, consentement et attribution).
// Sert un build fait avec un identifiant GA4 factice et APP_URL pointant vers l'app de test (playwright.config.mts),
// dans un dossier à part (dist/apps/landing-e2e) pour ne jamais écraser le build de production de la landing.
// `build.format: 'file'` : /guides/x → guides/x.html ; / → index.html. Aucune requête sortante.
// Compression gzip/brotli des textes, comme Traefik en production (phase 8) : la mesure Lighthouse de la landing
// (scripts/lighthouse.mjs, `LANDING_DIST` = build de mesure) porte sur les octets réellement transférés.
// Usage : node apps/web-e2e/scripts/serve-landing.mjs [--port 4330]
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, createBrotliCompress, createGzip } from 'node:zlib';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(process.env['LANDING_DIST'] ?? join(here, '..', '..', '..', 'dist', 'apps', 'landing-e2e'));
const portArg = process.argv.indexOf('--port');
const port = Number(portArg > 0 ? process.argv[portArg + 1] : (process.env['PORT'] ?? 4330));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const COMPRESSIBLE = /^(text\/|application\/(json|xml|manifest\+json)|image\/svg\+xml)/;

function compressor(req, type) {
  if (!COMPRESSIBLE.test(type)) return null;
  const accept = String(req.headers['accept-encoding'] ?? '');
  if (/\bbr\b/.test(accept)) return { encoding: 'br', stream: createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }) };
  if (/\bgzip\b/.test(accept)) return { encoding: 'gzip', stream: createGzip() };
  return null;
}

/** Envoie un fichier (compressé si le client l'accepte). */
function send(req, res, file, status, cacheControl) {
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff', Vary: 'Accept-Encoding' };
  const zip = compressor(req, type);
  if (zip) headers['Content-Encoding'] = zip.encoding;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const input = createReadStream(file);
  if (zip) input.pipe(zip.stream).pipe(res);
  else input.pipe(res);
}

if (!existsSync(join(root, 'index.html'))) {
  console.error(`Build de la landing introuvable : ${root}/index.html`);
  process.exit(1);
}

/** Fichier du build pour un chemin d'URL (jamais en dehors de `root`), ou null. */
function resolveFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  const candidates = relative === '' ? ['index.html'] : [relative, `${relative}.html`, join(relative, 'index.html')];
  for (const candidate of candidates) {
    const file = resolve(root, candidate);
    if (file !== root && !file.startsWith(root + sep)) return null;
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const file = resolveFile(url.pathname);
  if (!file) {
    const notFound = join(root, '404.html');
    if (existsSync(notFound)) return send(req, res, notFound, 404, 'no-cache');
    res.writeHead(404, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
    res.end('Page introuvable');
    return;
  }
  send(req, res, file, 200, file.includes(`${sep}_astro${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
}).listen(port, () => {
  console.log(`Landing de test sur http://localhost:${port} (${root})`);
});
