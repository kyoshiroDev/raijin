/**
 * Point d'entrée de l'API Raijin (`/api/v1`). L'app reste fine : la logique vit dans libs/api/*.
 * Helmet, CORS, throttler et format d'erreur {code, message} arrivent en phase 2 (nestjs-api).
 */

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const globalPrefix = 'api/v1';
  app.setGlobalPrefix(globalPrefix);
  const port = process.env['API_PORT'] ?? 3000;
  await app.listen(port);
  // Set when Nx waits for this server to be ready
  if (process.env['NX_READY_SIGNAL_SOCKET']) {
    try {
      // Function keeps TypeScript and bundlers from rewriting or bundling the import
      const load = new Function('s', 'return import(s)') as (
        s: string,
      ) => Promise<{ emitReadySignal(server: unknown): boolean }>;
      (await load('@nx/js/ready-signal')).emitReadySignal(app.getHttpServer());
    } catch {
      // @nx/js isn't installed
    }
  }
  Logger.log(
    `API Raijin à l'écoute sur http://localhost:${port}/${globalPrefix}`,
  );
}

bootstrap();
