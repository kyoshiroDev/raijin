import { Inject, Injectable } from '@nestjs/common';
import type { BenchMode } from '@raijin/bench-contracts';
import type { BenchConfig } from '../config/bench-config';
import { BENCH_CONFIG } from '../config/tokens';

/**
 * Mode du banc (`BENCH_MODE`, docs/ARCHITECTURE.md §17.6). En `shadow` : collecte et jobs actifs, mais aucune
 * notification (push, e-mail) et aucune ouverture automatique de position paper. Les modules métier (T7)
 * consultent `autoPaperAllowed()` ; les notifications passent toutes par `BenchNotifier`.
 */
@Injectable()
export class BenchModeService {
  constructor(@Inject(BENCH_CONFIG) private readonly config: BenchConfig) {}

  get mode(): BenchMode {
    return this.config.mode;
  }

  get isShadow(): boolean {
    return this.config.mode === 'shadow';
  }

  notificationsAllowed(): boolean {
    return !this.isShadow;
  }

  autoPaperAllowed(): boolean {
    return !this.isShadow;
  }
}
