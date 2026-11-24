import { Injectable } from '@nestjs/common';
import type { BenchJobName, BenchMode } from '@raijin/bench-contracts';

/** Contexte passé au traitement d'un job. */
export interface BenchJobContext {
  readonly runId: string;
  readonly startedAt: Date;
  readonly mode: BenchMode;
  /** `schedule` (BullMQ) ou `manual` (déclenchement explicite). */
  readonly trigger: 'schedule' | 'manual';
}

/** Détails facultatifs écrits dans `job_runs.details` (petits compteurs, jamais de secret, ≤ 8 Kio). */
export type BenchJobDetails = Readonly<Record<string, string | number | boolean | null>>;

export type BenchJobHandler = (context: BenchJobContext) => Promise<BenchJobDetails | void>;

/**
 * Point d'extension des modules métier (T7) : chaque module enregistre son traitement dans `onModuleInit`
 * (`registry.register('scan-tokens', ctx => …)`). Seuls les jobs enregistrés sont planifiés.
 */
@Injectable()
export class BenchJobRegistry {
  private readonly handlers = new Map<BenchJobName, BenchJobHandler>();

  register(name: BenchJobName, handler: BenchJobHandler): void {
    if (this.handlers.has(name)) throw new Error(`Job ${name} déjà enregistré`);
    this.handlers.set(name, handler);
  }

  get(name: BenchJobName): BenchJobHandler | undefined {
    return this.handlers.get(name);
  }

  names(): BenchJobName[] {
    return [...this.handlers.keys()];
  }
}
