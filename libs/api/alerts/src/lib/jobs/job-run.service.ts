import { Injectable, Logger } from '@nestjs/common';
import { errorCode } from '@raijin/api-core';
import { Prisma, PrismaService } from '@raijin/api-prisma';

export type JobDetails = Readonly<Record<string, string | number | boolean | null | Readonly<Record<string, number>>>>;

/**
 * Journal `JobRun` (docs/ARCHITECTURE.md §11.3) : une ligne par exécution du planificateur et de
 * chaque purge ; `details` = compteurs ; erreur = **code** seulement. Ne lève jamais.
 */
@Injectable()
export class JobRunService {
  private readonly logger = new Logger('JobRun');

  constructor(private readonly prisma: PrismaService) {}

  /** Exécute `task` et journalise son statut, sa durée et ses compteurs. */
  async track<T extends JobDetails>(job: string, task: () => Promise<T>): Promise<T> {
    const started = Date.now();
    let id: string | null = null;
    try {
      id = (await this.prisma.jobRun.create({ data: { job }, select: { id: true } })).id;
    } catch (error) {
      this.logger.warn(`JobRun non créé (${errorCode(error)})`);
    }
    try {
      const details = await task();
      await this.finish(id, 'SUCCESS', started, details, null);
      return details;
    } catch (error) {
      await this.finish(id, 'FAILED', started, null, errorCode(error));
      throw error;
    }
  }

  private async finish(id: string | null, status: 'SUCCESS' | 'FAILED', started: number, details: JobDetails | null, error: string | null): Promise<void> {
    if (!id) return;
    try {
      await this.prisma.jobRun.update({
        where: { id },
        data: {
          status,
          finishedAt: new Date(),
          durationMs: Date.now() - started,
          error,
          details: details === null ? Prisma.DbNull : (details as Prisma.InputJsonValue),
        },
      });
    } catch (failure) {
      this.logger.warn(`JobRun non clos (${errorCode(failure)})`);
    }
  }
}
