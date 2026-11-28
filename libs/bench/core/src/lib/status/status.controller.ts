import { Controller, Get } from '@nestjs/common';
import { BENCH_ROUTES, type BenchLiveness, type BenchStatus } from '@raijin/bench-contracts';
import { BenchPublic } from '../http/decorators';
import { BenchStatusService } from './status.service';

/** Santé publique sans donnée (`GET /api/health`, derrière le basicAuth Traefik) : sonde du conteneur. */
@Controller(BENCH_ROUTES.health)
export class BenchHealthController {
  constructor(private readonly status: BenchStatusService) {}

  @Get()
  @BenchPublic()
  async health(): Promise<BenchLiveness> {
    return { status: await this.status.liveness() };
  }
}

/** État détaillé (`GET /api/status`, session requise). */
@Controller(BENCH_ROUTES.status)
export class BenchStatusController {
  constructor(private readonly status: BenchStatusService) {}

  @Get()
  get(): Promise<BenchStatus> {
    return this.status.status();
  }
}
