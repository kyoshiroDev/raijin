import { Controller, Get, HttpStatus, Inject, Query, Req, Res } from '@nestjs/common';
import { BENCH_ROUTES, BENCH_SSE_HEARTBEAT_SECONDS, type BenchEvent } from '@raijin/bench-contracts';
import type { Request, Response } from 'express';
import type { Subscription } from 'rxjs';
import * as z from 'zod';
import { BENCH_CLOCK, type BenchClock } from '../config/tokens';
import { BenchAuthService } from '../auth/auth.service';
import { CurrentBenchSession, type BenchRequestSession } from '../auth/session';
import { BenchException } from '../http/bench-exception';
import { BenchZodPipe } from '../http/zod.pipe';
import { BENCH_EVENT_TOPICS, BenchEventBus, TOPIC_OF, type BenchEventTopic } from './event-bus';

/** Flux simultanés au plus (un seul utilisateur : quelques onglets). */
export const BENCH_SSE_MAX_CLIENTS = 8;
/** Délai de reconnexion conseillé à `EventSource`. */
export const BENCH_SSE_RETRY_MS = 5_000;

const topicsQuerySchema = z.object({
  topics: z
    .string()
    .max(64)
    .optional()
    .transform((value) => (value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [...BENCH_EVENT_TOPICS]))
    .pipe(z.array(z.enum(BENCH_EVENT_TOPICS)).min(1, { message: 'Familles d’événements inconnues.' })),
});

export function formatSse(event: BenchEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * `GET /api/events?topics=tokens,paper` (session requise) : `text/event-stream`, battement toutes les 25 s,
 * pas de rejeu (le front recharge ses listes après reconnexion). La session est revalidée à chaque battement
 * (sans prolonger l'inactivité) : flux fermé dès qu'elle expire ou est révoquée.
 */
@Controller(BENCH_ROUTES.events)
export class BenchEventsController {
  private clients = 0;

  constructor(
    private readonly bus: BenchEventBus,
    private readonly auth: BenchAuthService,
    @Inject(BENCH_CLOCK) private readonly clock: BenchClock,
  ) {}

  @Get()
  stream(
    @Query(new BenchZodPipe(topicsQuerySchema)) query: { topics: BenchEventTopic[] },
    @CurrentBenchSession() session: BenchRequestSession,
    @Req() req: Request,
    @Res() res: Response,
  ): void {
    if (this.clients >= BENCH_SSE_MAX_CLIENTS) throw new BenchException('RATE_LIMITED', HttpStatus.TOO_MANY_REQUESTS);
    this.clients += 1;
    const topics = new Set(query.topics);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(`retry: ${BENCH_SSE_RETRY_MS}\n\n`);

    let closed = false;
    let subscription: Subscription | null = null;
    const close = (): void => {
      if (closed) return;
      closed = true;
      this.clients -= 1;
      clearInterval(heartbeat);
      subscription?.unsubscribe();
      res.end();
    };
    const send = (event: BenchEvent): void => {
      if (!closed) res.write(formatSse(event));
    };
    subscription = this.bus.events().subscribe((event) => {
      if (event.type === 'heartbeat' || topics.has(TOPIC_OF[event.type])) send(event);
    });
    const heartbeat = setInterval(() => {
      void this.auth.validate(session.token, { touch: false }).then((valid) => {
        if (!valid) close();
        else send({ type: 'heartbeat', at: this.clock().toISOString() });
      });
    }, BENCH_SSE_HEARTBEAT_SECONDS * 1000);
    heartbeat.unref();
    send({ type: 'heartbeat', at: this.clock().toISOString() });
    req.on('close', close);
  }
}
