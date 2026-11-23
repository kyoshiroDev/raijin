import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BENCH_API_PREFIX } from '@raijin/bench-contracts';
import { AppModule } from './app/app.module';

/** Amorçage provisoire : configuration Zod, Helmet, cookies, CSRF et jobs arrivent avec `bench-core` (T6). */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix(BENCH_API_PREFIX.slice(1));
  const port = Number(process.env['API_PORT'] ?? 3300);
  await app.listen(port);
  Logger.log(`API du banc à l'écoute sur le port ${port}`);
}

void bootstrap();
