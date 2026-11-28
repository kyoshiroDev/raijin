import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { CSRF_HEADER } from '@raijin/shared-contracts';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { AppConfig } from '../config/app-config';
import { GENERIC_ERROR_MESSAGES } from '../errors/api-exception';
import { ApiExceptionFilter } from '../errors/api-exception.filter';
import { edgeGuardMiddleware } from './edge-guard';

export const GLOBAL_PREFIX = 'api/v1';
/** Taille maximale d'un corps JSON : les requêtes de l'API sont petites. */
export const JSON_BODY_LIMIT = '32kb';

/**
 * Maintenance programmée (`MAINTENANCE_MODE=1`) : 503 `MAINTENANCE` sur toutes les routes sauf
 * `/api/v1/health…` (sondes) ; `Retry-After` indicatif. Le front affiche la page de maintenance.
 */
export function maintenanceMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === `/${GLOBAL_PREFIX}/health` || req.path.startsWith(`/${GLOBAL_PREFIX}/health/`)) {
    next();
    return;
  }
  res
    .status(503)
    .set({ 'Retry-After': '300', 'Cache-Control': 'no-store' })
    .json({ code: 'MAINTENANCE', message: GENERIC_ERROR_MESSAGES['MAINTENANCE'] });
}

/** Options de `setupApp`. */
export interface SetupAppOptions {
  /**
   * Middlewares à monter juste après le contrôle de l'en-tête de Traefik et avant tout le reste
   * (ex. corps brut du webhook Stripe, qui doit précéder le parseur JSON global).
   */
  readonly beforeParsers?: (app: NestExpressApplication) => void;
}

/**
 * Branche le socle HTTP sur l'application Nest (à appeler avant `listen`) :
 * contrôle de l'en-tête `X-Raijin-Edge` (premier middleware), préfixe /api/v1, trust proxy, Helmet, cookies, corps JSON borné, CORS strict avec credentials,
 * filtre d'erreurs `{code, message}`, OpenAPI hors production.
 * L'application doit être créée avec `{ bodyParser: false }`.
 */
export function setupApp(app: NestExpressApplication, config: AppConfig, options: SetupAppOptions = {}): void {
  app.disable('x-powered-by');
  // `trust proxy` reste réglé par TRUST_PROXY ; quand EDGE_SHARED_SECRET est défini, le contrôle ci-dessous supprime
  // les en-têtes X-Forwarded-* d'une requête sans en-tête valide : Express retombe alors sur l'adresse de la socket.
  app.set('trust proxy', config.trustProxy);
  app.use(edgeGuardMiddleware(config.edgeSharedSecret));
  options.beforeParsers?.(app);

  app.use(
    helmet({
      // API JSON : aucune ressource à charger. Swagger (dev seulement) a besoin de scripts.
      contentSecurityPolicy: config.swaggerEnabled
        ? false
        : { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      strictTransportSecurity: config.isProduction
        ? { maxAge: 31_536_000, includeSubDomains: true }
        : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  if (config.maintenance) app.use(maintenanceMiddleware);
  app.use(cookieParser());
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => callback(null, !origin || config.allowedOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', CSRF_HEADER],
    maxAge: 600,
  });
  app.setGlobalPrefix(GLOBAL_PREFIX);
  app.useGlobalFilters(new ApiExceptionFilter(!config.isProduction));
  app.enableShutdownHooks();

  if (config.swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('API Raijin')
        .setDescription('API REST de Raijin Shield (/api/v1). Documentation disponible hors production.')
        .setVersion('1')
        .addCookieAuth('rj_at')
        .build(),
    );
    SwaggerModule.setup(`${GLOBAL_PREFIX}/docs`, app, document);
  }
}
