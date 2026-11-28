import { Injectable } from '@nestjs/common';
import { mintAddressSchema } from '@raijin/shared-contracts';
import * as z from 'zod';
import { WeeklyDigestService } from '../digest/weekly-digest.service';
import { AlertDeliveryService } from '../delivery/alert-delivery.service';
import { PurgeService } from '../purge/purge.service';
import { WatchPassesService } from '../watch/watch-passes.service';
import { WatchPlannerService } from '../watch/planner.service';
import type { JobData, JobName } from './job-queue';

const mintsData = z.object({ mints: z.array(mintAddressSchema).min(1).max(100) });
const mintData = z.object({ mint: mintAddressSchema });
const alertData = z.object({ alertId: z.uuid() });
const userData = z.object({ userId: z.uuid() });

export type JobResult = Readonly<Record<string, unknown>>;

/**
 * Exécution d'un job par son nom (worker BullMQ ou déclenchement manuel des tests). Les données
 * sont revalidées : un job altéré dans Redis ne fait rien d'imprévu.
 */
@Injectable()
export class JobHandlers {
  constructor(
    private readonly planner: WatchPlannerService,
    private readonly passes: WatchPassesService,
    private readonly delivery: AlertDeliveryService,
    private readonly digest: WeeklyDigestService,
    private readonly purge: PurgeService,
  ) {}

  async run(name: JobName, data: JobData): Promise<JobResult> {
    switch (name) {
      case 'watch-planner':
        return this.planner.tick();
      case 'watch-fast':
        return this.passes.fast(mintsData.parse(data).mints);
      case 'watch-holders':
        return this.passes.holders(mintData.parse(data).mint);
      case 'watch-full':
        return this.passes.full(mintData.parse(data).mint);
      case 'alert-push':
        return this.delivery.deliverPush(alertData.parse(data).alertId);
      case 'alert-email':
        return this.delivery.deliverEmail(userData.parse(data).userId);
      case 'weekly-digest':
        return this.digest.run();
      case 'purge':
        return this.purge.run();
    }
  }
}
