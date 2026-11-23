import { Controller, Get, Header } from '@nestjs/common';
import { BENCH_ROUTES, type BenchLiveness } from '@raijin/bench-contracts';

/**
 * Santé minimale de l'API du banc (aucune donnée). Les dépendances (Postgres, Redis, jobs) et
 * `GET /api/status` arrivent avec `bench-core` (phase 8 bis, T6).
 */
@Controller(BENCH_ROUTES.health)
export class HealthController {
  @Get()
  @Header('Cache-Control', 'no-store')
  health(): BenchLiveness {
    return { status: 'ok' };
  }
}
