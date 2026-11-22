// Serveur local « comme en production » pour les tests de bout en bout et Lighthouse (phase 3) :
// - sert le build de production de l'app (dist/apps/web/browser), repli SPA sur index.html,
//   compression gzip/brotli et cache long des fichiers hachés (rôle de Traefik en phase 8) ;
// - relaie /api/* vers l'API (API_URL, défaut http://localhost:3100) ;
// - réécrit /t/<mint> vers /api/v1/share/t/<mint> (page publique avec balises OG injectées par l'API,
//   réécriture prévue côté Traefik, docs/ARCHITECTURE.md §9.7).
// X-Forwarded-For : conservé s'il est fourni (tests : une IP par test), sinon une IP fictive tirée au
// démarrage est ajoutée (comme Traefik), pour ne pas consommer le quota anonyme de 127.0.0.1.
// Usage : node apps/web-e2e/scripts/serve-prod.mjs [--port 4310]
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, createBrotliCompress, createGzip } from 'node:zlib';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(process.env['WEB_DIST'] ?? join(here, '..', '..', '..', 'dist', 'apps', 'web', 'browser'));
const portArg = process.argv.indexOf('--port');
const port = Number(portArg > 0 ? process.argv[portArg + 1] : (process.env['PORT'] ?? 4310));
const api = new URL(process.env['API_URL'] ?? 'http://localhost:3100');
const fallbackIp = `10.254.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json|xml)|image\/svg)/;

if (!existsSync(join(root, 'index.html'))) {
  console.error(`Build web introuvable : ${root}/index.html (lancer « pnpm nx run web:build »)`);
  process.exit(1);
}

function compressor(req, type) {
  if (!COMPRESSIBLE.test(type)) return null;
  const accept = String(req.headers['accept-encoding'] ?? '');
  if (/\bbr\b/.test(accept)) return { encoding: 'br', stream: createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }) };
  if (/\bgzip\b/.test(accept)) return { encoding: 'gzip', stream: createGzip() };
  return null;
}

function sendFile(req, res, file) {
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  const hashed = /-[A-Z0-9]{8}\.(js|css)$/.test(file) || file.includes(`${sep}fonts${sep}`);
  const headers = {
    'Content-Type': type,
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Accept-Encoding',
  };
  const zip = compressor(req, type);
  if (zip) headers['Content-Encoding'] = zip.encoding;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  const input = createReadStream(file);
  if (zip) input.pipe(zip.stream).pipe(res);
  else input.pipe(res);
}

function proxy(req, res, path) {
  const headers = { ...req.headers, host: api.host };
  if (!headers['x-forwarded-for']) headers['x-forwarded-for'] = fallbackIp;
  const upstream = httpRequest(
    { hostname: api.hostname, port: api.port, path, method: req.method, headers },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('API injoignable');
  });
  req.pipe(upstream);
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) return proxy(req, res, `${url.pathname}${url.search}`);
  const share = /^\/t\/([^/]+)\/?$/.exec(url.pathname);
  if (share && (req.method === 'GET' || req.method === 'HEAD')) return proxy(req, res, `/api/v1/share/t/${share[1]}`);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  const file = normalize(join(root, pathname));
  if (file.startsWith(root + sep) && existsSync(file) && statSync(file).isFile()) return sendFile(req, res, file);
  // Fichier statique absent (extension) : 404 ; route de l'app : index.html.
  if (extname(pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Introuvable');
  }
  return sendFile(req, res, join(root, 'index.html'));
}).listen(port, '127.0.0.1', () => {
  console.log(`Raijin (build de production) sur http://localhost:${port} (API ${api.origin})`);
});
