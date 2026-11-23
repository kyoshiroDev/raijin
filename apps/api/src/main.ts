/**
 * Point d'entrée de l'API Raijin (`/api/v1`). L'app reste fine : la logique vit dans libs/api/*.
 * La configuration est validée avant tout (échec du démarrage si invalide en production).
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { BILLING_WEBHOOK_PATH, billingWebhookRawBody, loadBillingConfig } from '@raijin/api-billing';
import { ConfigError, GLOBAL_PREFIX, loadConfig, redactCredentials, setupApp } from '@raijin/api-core';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { AppModule } from './app/app.module';

/**
 * Signale à `nx serve` que le serveur écoute (développement uniquement, variable posée par Nx).
 * `createRequire` résout @nx/js depuis le workspace sans évaluer de code dynamique.
 */
function emitNxReadySignal(server: unknown): void {
  if (!process.env['NX_READY_SIGNAL_SOCKET']) return;
  try {
    const load = createRequire(join(process.cwd(), 'package.json'));
    (load('@nx/js/ready-signal') as { emitReadySignal(server: unknown): boolean }).emitReadySignal(server);
  } catch {
    // @nx/js absent (image de production) : rien à signaler.
  }
}

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const config = loadConfig(process.env, (message) => logger.warn(message));
  const billing = loadBillingConfig(process.env, config, (message) => logger.warn(message));
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config, billing), {
    bodyParser: false,
  });
  // Webhook Stripe : corps brut (signature sur les octets reçus), monté avant le parseur JSON global.
  app.use(`/${GLOBAL_PREFIX}/${BILLING_WEBHOOK_PATH}`, billingWebhookRawBody());
  setupApp(app, config);
  await app.listen(config.port);
  emitNxReadySignal(app.getHttpServer());
  logger.log(`API Raijin à l'écoute sur http://localhost:${config.port}/${GLOBAL_PREFIX} (${config.env})`);
}

bootstrap().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    new Logger('Bootstrap').error(error.message);
  } else {
    // Jamais d'URL de connexion en clair (mot de passe Redis / Postgres) dans les journaux.
    new Logger('Bootstrap').error(redactCredentials(error instanceof Error ? (error.stack ?? error.message) : String(error)));
  }
  process.exit(1);
});
