import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import {
  BENCH_PRISMA_OPTIONS,
  safeErrorCode,
  type BenchPrismaOptions,
} from './bench-prisma.options';

/**
 * Client Prisma de la base du banc `raijin_bench` (adaptateur `pg`), distinct de celui de l'API
 * Raijin. Connexion au démarrage (l'API démarre même si la base est injoignable : la santé le
 * signale), fermeture propre à l'arrêt. L'URL n'est jamais journalisée.
 */
@Injectable()
export class BenchPrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger('BenchPrisma');

  constructor(@Inject(BENCH_PRISMA_OPTIONS) options: BenchPrismaOptions) {
    super({ adapter: new PrismaPg({ connectionString: options.databaseUrl }) });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch (error) {
      this.logger.error(
        `Connexion à la base du banc impossible (${safeErrorCode(error)})`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Vérifie que la base répond (`GET /api/status`). */
  async isHealthy(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  /** Taille de la base courante en octets (`pg_database_size`, alerte 80 % / 95 %). */
  async databaseSizeBytes(): Promise<number> {
    const rows = await this.$queryRaw<
      { size: bigint }[]
    >`SELECT pg_database_size(current_database()) AS size`;
    return Number(rows[0]?.size ?? 0n);
  }
}
