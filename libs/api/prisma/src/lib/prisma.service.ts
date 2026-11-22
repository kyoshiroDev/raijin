import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG, type AppConfig } from '@raijin/api-core';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Client Prisma de l'API (adaptateur `pg`). Connexion au démarrage, fermeture propre à l'arrêt.
 * L'URL vient de la configuration validée (`DATABASE_URL`), jamais journalisée.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Prisma');

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch (error) {
      // L'API démarre quand même : /health signale la base indisponible.
      this.logger.error(`Connexion à la base impossible : ${(error as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Vérifie que la base répond (GET /health). */
  async isHealthy(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
