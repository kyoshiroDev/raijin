// Sert le build de production du front du banc (dist/apps/raijin-banc-de-test/browser) pour l'e2e, comme
// raijin-bench-web derrière Traefik : repli SPA sur index.html, /api/* relayé vers l'API du banc sans
// compression ni mise en mémoire tampon (SSE `GET /api/events` diffusé au fil de l'eau).
// Usage : node apps/raijin-banc-de-test-e2e/scripts/serve-front.mjs [--port 4320]   (API_URL, défaut http://localhost:3310)
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(process.env['BENCH_WEB_DIST'] ?? join(here, '..', '..', '..', 'dist', 'apps', 'raijin-banc-de-test', 'browser'));
const portArg = process.argv.indexOf('--port');
const port = Number(portArg > 0 ? process.argv[portArg + 1] : (process.env['PORT'] ?? 4320));
const api = new URL(process.env['API_URL'] ?? 'http://localhost:3310');

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
  '.txt': 'text/plain; charset=utf-8',
};

if (!existsSync(join(root, 'index.html'))) {
  console.error(`Build du front du banc introuvable : ${root}/index.html (lancer « pnpm nx run raijin-banc-de-test:build »)`);
  process.exit(1);
}

function sendFile(req, res, file) {
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

function proxy(req, res) {
  const upstream = httpRequest(
    { hostname: api.hostname, port: api.port, path: req.url, method: req.method, headers: { ...req.headers, host: api.host } },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      res.flushHeaders();
      answer.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end('{"code":"BAD_GATEWAY","message":"API du banc injoignable."}');
  });
  // Client parti (onglet fermé, EventSource coupé) : flux amont fermé aussi.
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return proxy(req, res);
  const candidate = normalize(join(root, decodeURIComponent(url.pathname)));
  if (candidate.startsWith(root + sep) && existsSync(candidate) && statSync(candidate).isFile()) return sendFile(req, res, candidate);
  return sendFile(req, res, join(root, 'index.html'));
}).listen(port, () => console.log(`Front du banc (build de production) sur http://localhost:${port}, API ${api.origin}`));
