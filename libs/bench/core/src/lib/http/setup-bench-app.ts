import type { NestExpressApplication } from '@nestjs/platform-express';
import { BENCH_API_PREFIX, BENCH_CSRF_HEADER } from '@raijin/bench-contracts';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import type { BenchConfig } from '../config/bench-config';
import { BenchExceptionFilter } from './bench-exception.filter';

/** Corps JSON maximal : les requêtes du banc sont petites. */
export const BENCH_JSON_BODY_LIMIT = '32kb';

/** En-têtes communs : jamais indexé (double emploi avec Traefik), jamais mis en cache. */
export function benchHeadersMiddleware(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  next();
}

/**
 * Socle HTTP de l'API du banc (à appeler avant `listen`, application créée avec `{ bodyParser: false }`) :
 * préfixe `/api`, `trust proxy`, Helmet (CSP `default-src 'none'`), `noindex`, cookies, JSON borné,
 * CORS limité aux origines du banc avec credentials, erreurs `{ code, message }`, arrêt propre.
 */
export function setupBenchApp(app: NestExpressApplication, config: BenchConfig): void {
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      strictTransportSecurity: config.isProduction ? { maxAge: 63_072_000, includeSubDomains: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
      frameguard: { action: 'deny' },
    }),
  );
  app.use(benchHeadersMiddleware);
  app.use(cookieParser());
  app.useBodyParser('json', { limit: BENCH_JSON_BODY_LIMIT });
  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) =>
      callback(null, !origin || config.allowedOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', BENCH_CSRF_HEADER],
    maxAge: 600,
  });
  app.setGlobalPrefix(BENCH_API_PREFIX.slice(1));
  app.useGlobalFilters(new BenchExceptionFilter());
  app.enableShutdownHooks();
}
