import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Optional, Param, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { FixtureScenarios } from '@raijin/api-analysis';
import { APP_CONFIG, ApiException, type AppConfig } from '@raijin/api-core';
import { FakePushSender, PushSender } from '@raijin/api-notifications';
import { PrismaService } from '@raijin/api-prisma';
import { mintAddressSchema } from '@raijin/shared-contracts';
import * as z from 'zod';
import { AlertDeliveryService } from '../delivery/alert-delivery.service';
import { JobHandlers, type JobResult } from '../jobs/job-handlers.service';
import { jobNameSchema } from '../jobs/job-queue';
import { JobRegistry } from '../jobs/job-registry';

const runBodySchema = z.object({ mints: z.array(mintAddressSchema).min(1).max(100).optional() }).strict();
const fixtureBodySchema = z.object({ step: z.number().int().min(0).max(100) }).strict();

/**
 * Routes de test (`/api/v1/internal`), actives seulement si `JOBS_TEST_TRIGGER=1` hors production
 * (la configuration refuse ce réglage en production) ; sinon 404 comme une route inexistante.
 * - `POST internal/jobs/:name/run` : exécute un job tout de suite (passes : `mints` ou tous les mints suivis ;
 *   jobs déclarés dans `JobRegistry` avec `manualRun`, corps vide) ;
 * - `POST internal/fixtures/:scenario` : étape d'un scénario de fixtures en séquence (`ANALYSIS_FIXTURES=1`) ;
 * - `GET internal/push/outbox` : notifications du push simulé (`PUSH_PROVIDER=fake`).
 */
@ApiExcludeController()
@Controller('internal')
export class InternalController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly handlers: JobHandlers,
    private readonly delivery: AlertDeliveryService,
    private readonly prisma: PrismaService,
    private readonly push: PushSender,
    private readonly registry: JobRegistry,
    @Optional() @Inject(FixtureScenarios) private readonly scenarios: FixtureScenarios | null,
  ) {}

  private assertEnabled(): void {
    if (!this.config.jobs.testTrigger || this.config.isProduction) throw new ApiException('NOT_FOUND', HttpStatus.NOT_FOUND);
  }

  @Post('jobs/:name/run')
  @HttpCode(200)
  async run(@Param('name') rawName: string, @Body() rawBody: unknown): Promise<{ name: string; results: JobResult[] }> {
    this.assertEnabled();
    const extra = this.registry.get(rawName);
    if (extra?.manualRun) {
      if (Object.keys((rawBody ?? {}) as object).length > 0) throw new ApiException('VALIDATION_ERROR', HttpStatus.BAD_REQUEST);
      return { name: extra.name, results: [await extra.handler({})] };
    }
    const name = jobNameSchema.safeParse(rawName);
    const body = runBodySchema.safeParse(rawBody ?? {});
    if (!name.success || !body.success) throw new ApiException('VALIDATION_ERROR', HttpStatus.BAD_REQUEST);
    const mints = body.data.mints ?? (await this.prisma.mintWatchState.findMany({ select: { mint: true }, take: 100 })).map((state) => state.mint);
    const results: JobResult[] = [];
    switch (name.data) {
      case 'watch-fast':
        if (mints.length > 0) results.push(await this.handlers.run('watch-fast', { mints }));
        break;
      case 'watch-holders':
      case 'watch-full':
        for (const mint of mints) results.push(await this.handlers.run(name.data, { mint }));
        break;
      case 'alert-email':
        for (const userId of await this.delivery.pendingEmailUsers()) results.push(await this.handlers.run('alert-email', { userId }));
        break;
      case 'alert-push':
        throw new ApiException('VALIDATION_ERROR', HttpStatus.BAD_REQUEST);
      default:
        results.push(await this.handlers.run(name.data, {}));
    }
    return { name: name.data, results };
  }

  @Post('fixtures/:scenario')
  @HttpCode(200)
  goTo(@Param('scenario') scenario: string, @Body() rawBody: unknown): { scenario: string; step: number } {
    this.assertEnabled();
    const body = fixtureBodySchema.safeParse(rawBody ?? {});
    if (!this.scenarios || !body.success || !this.scenarios.goTo(scenario, body.data.step)) throw new ApiException('NOT_FOUND', HttpStatus.NOT_FOUND);
    return { scenario, step: body.data.step };
  }

  @Get('push/outbox')
  outbox(): { items: ReturnType<FakePushSender['sent']> } {
    this.assertEnabled();
    if (!(this.push instanceof FakePushSender)) throw new ApiException('NOT_FOUND', HttpStatus.NOT_FOUND);
    return { items: this.push.sent() };
  }
}
