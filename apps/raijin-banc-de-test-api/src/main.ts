import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { BenchConfigError, loadBenchConfig, setupBenchApp } from '@raijin/bench-core';
import { AppModule } from './app/app.module';

/**
 * Démarrage de l'API du banc : configuration validée d'abord (refus de démarrer en production si un secret
 * manque ou reste factice ; seuls les noms de variables sont affichés), puis socle HTTP et écoute.
 */
async function bootstrap(): Promise<void> {
  let config;
  try {
    config = loadBenchConfig(process.env);
  } catch (error) {
    if (error instanceof BenchConfigError) {
      for (const problem of error.problems) Logger.error(`Configuration : ${problem}`, 'BenchBootstrap');
      process.exit(78);
    }
    throw error;
  }
  for (const warning of config.warnings) Logger.warn(`Configuration : ${warning}`, 'BenchBootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), { bodyParser: false });
  setupBenchApp(app, config);
  await app.listen(config.port);
  Logger.log(`API du banc à l'écoute sur le port ${config.port} (mode ${config.mode})`, 'BenchBootstrap');
}

void bootstrap();
