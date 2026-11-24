import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { benchEventSchema, type BenchEvent, type BenchEventType } from '@raijin/bench-contracts';
import { Observable, Subject } from 'rxjs';

/** Familles d'événements filtrables par `GET /api/events?topics=` (ex-canaux Realtime `tokens-live`, `paper-positions-live`). */
export const BENCH_EVENT_TOPICS = ['tokens', 'paper', 'jobs', 'backtest'] as const;
export type BenchEventTopic = (typeof BENCH_EVENT_TOPICS)[number];

export const TOPIC_OF: Readonly<Record<Exclude<BenchEventType, 'heartbeat'>, BenchEventTopic>> = {
  'token.upsert': 'tokens',
  'token.delete': 'tokens',
  'paper.changed': 'paper',
  'job.finished': 'jobs',
  'backtest.progress': 'backtest',
};

/**
 * Bus d'événements du banc (remplace Supabase Realtime, docs/ARCHITECTURE.md §17.4) : les modules métier
 * publient (`token.upsert` après un scan, `paper.changed` après un ordre…), `GET /api/events` diffuse.
 * Un événement non conforme au contrat est écarté (journalisé sans contenu). Processus unique : pas de Redis.
 */
@Injectable()
export class BenchEventBus implements OnModuleDestroy {
  private readonly logger = new Logger('BenchEvents');
  private readonly subject = new Subject<BenchEvent>();

  publish(event: BenchEvent): void {
    const parsed = benchEventSchema.safeParse(event);
    if (!parsed.success) {
      this.logger.warn(`Événement ${String((event as { type?: unknown }).type).slice(0, 32)} non conforme, ignoré`);
      return;
    }
    this.subject.next(parsed.data);
  }

  events(): Observable<BenchEvent> {
    return this.subject.asObservable();
  }

  onModuleDestroy(): void {
    this.subject.complete();
  }
}
