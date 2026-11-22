import { Inject, Injectable } from '@nestjs/common';
import { AnalysisClock } from '@raijin/api-analysis';
import { APP_CONFIG, type AppConfig } from '@raijin/api-core';
import { Prisma, PrismaService } from '@raijin/api-prisma';
import type { TokenMetadata, WatchEvent, WatchSnapshot } from '@raijin/shared-contracts';
import { JobQueue, jobId } from '../jobs/job-queue';

const SEVERITY_RANK = { warn: 1, danger: 2 } as const;

export interface RecordInput {
  readonly mint: string;
  /** Révision lue avec l'instantané précédent (verrou optimiste). */
  readonly revision: number;
  readonly next: WatchSnapshot;
  readonly events: readonly WatchEvent[];
  readonly token?: TokenMetadata | null;
  /** Champs d'état à écrire en même temps (échecs, prochaine passe anticipée…). */
  readonly state?: Prisma.MintWatchStateUpdateManyMutationInput;
  /** Verdict de la passe complète, recopié sur les suivis du mint. */
  readonly verdict?: { readonly verdict: 'safe' | 'warn' | 'danger'; readonly checkedAt: Date };
}

export interface RecordResult {
  /** Une autre écriture a eu lieu entre-temps : rien n'est écrit, la passe sera rejouée. */
  readonly conflict: boolean;
  readonly events: number;
  readonly skippedByCooldown: number;
  readonly alerts: number;
}

/**
 * Idempotence des alertes (docs/ARCHITECTURE.md §11.6) : dans **une** transaction, l'instantané du
 * mint est écrit (révision optimiste), chaque événement inséré une seule fois (`@@unique([mint,
 * dedupeKey])`, `ON CONFLICT DO NOTHING`), puis une alerte par suivi **actif** du mint créé avant
 * l'événement (`@@unique([userId, eventId])`). Rejouer une passe ne crée rien de plus. Délai de
 * grâce `ALERT_COOLDOWN_MINUTES` par mint et type, sauf aggravation. Les envois sont mis en file
 * après validation (push par alerte, e-mail groupé par utilisateur).
 */
@Injectable()
export class EventRecorderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: JobQueue,
    private readonly clock: AnalysisClock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async record(input: RecordInput): Promise<RecordResult> {
    const now = this.clock.now();
    const outcome = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.mintWatchState.updateMany({
        where: { mint: input.mint, revision: input.revision },
        data: {
          ...input.state,
          snapshot: input.next as unknown as Prisma.InputJsonValue,
          ...(input.token ? { token: input.token as unknown as Prisma.InputJsonValue } : {}),
          revision: { increment: 1 },
        },
      });
      if (updated.count === 0) return null;
      if (input.verdict) {
        await tx.watch.updateMany({
          where: { mint: input.mint },
          data: { lastVerdict: input.verdict.verdict, lastCheckedAt: input.verdict.checkedAt },
        });
      }
      let events = 0;
      let skipped = 0;
      let created = 0;
      const alertIds: { id: string; userId: string; pushedAt: Date | null; emailedAt: Date | null }[] = [];
      for (const event of input.events) {
        const detectedAt = new Date(event.detectedAt);
        if (await this.inCooldown(tx, input.mint, event, detectedAt)) {
          skipped += 1;
          continue;
        }
        const inserted = await tx.watchEvent.createMany({
          data: [
            {
              mint: input.mint,
              type: event.type,
              severity: event.severity,
              payload: event.payload as unknown as Prisma.InputJsonValue,
              dedupeKey: event.dedupeKey,
              detectedAt,
            },
          ],
          skipDuplicates: true,
        });
        const stored = await tx.watchEvent.findUnique({ where: { mint_dedupeKey: { mint: input.mint, dedupeKey: event.dedupeKey } }, select: { id: true } });
        if (!stored) continue;
        events += inserted.count;
        const watchers = await tx.watch.findMany({
          where: { mint: input.mint, status: 'active', createdAt: { lt: detectedAt } },
          select: { userId: true },
        });
        if (watchers.length > 0) {
          const createdAlerts = await tx.alert.createMany({
            data: watchers.map((watcher) => ({
              userId: watcher.userId,
              eventId: stored.id,
              mint: input.mint,
              type: event.type,
              severity: event.severity,
              payload: event.payload as unknown as Prisma.InputJsonValue,
              token: input.token ? (input.token as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
              createdAt: now,
            })),
            skipDuplicates: true,
          });
          created += createdAlerts.count;
        }
        // Toutes les alertes de l'événement encore à livrer (une reprise après coupure les renvoie en file).
        alertIds.push(
          ...(await tx.alert.findMany({ where: { eventId: stored.id }, select: { id: true, userId: true, pushedAt: true, emailedAt: true } })),
        );
      }
      return { events, skipped, created, alertIds };
    });
    if (outcome === null) return { conflict: true, events: 0, skippedByCooldown: 0, alerts: 0 };
    await this.dispatch(outcome.alertIds, now);
    return { conflict: false, events: outcome.events, skippedByCooldown: outcome.skipped, alerts: outcome.created };
  }

  /** Même type déjà signalé pour ce mint dans le délai de grâce, sans aggravation. */
  private async inCooldown(tx: Prisma.TransactionClient, mint: string, event: WatchEvent, detectedAt: Date): Promise<boolean> {
    const minutes = this.config.watch.alertCooldownMinutes;
    if (minutes <= 0) return false;
    const previous = await tx.watchEvent.findFirst({
      where: {
        mint,
        type: event.type,
        dedupeKey: { not: event.dedupeKey },
        detectedAt: { gte: new Date(detectedAt.getTime() - minutes * 60_000), lte: detectedAt },
      },
      orderBy: { detectedAt: 'desc' },
      select: { severity: true },
    });
    if (!previous) return false;
    return SEVERITY_RANK[event.severity] <= SEVERITY_RANK[previous.severity];
  }

  /** Push par alerte, e-mail groupé par utilisateur (fenêtre `ALERT_EMAIL_BATCH_DELAY_S`). */
  private async dispatch(alerts: readonly { id: string; userId: string; pushedAt: Date | null; emailedAt: Date | null }[], now: Date): Promise<void> {
    const delayMs = this.config.watch.emailBatchDelayS * 1000;
    const users = new Set<string>();
    for (const alert of alerts) {
      if (alert.pushedAt === null) await this.queue.add('alert-push', { alertId: alert.id }, { jobId: jobId('push', alert.id) });
      if (alert.emailedAt === null) users.add(alert.userId);
    }
    for (const userId of users) await this.enqueueEmail(userId, now, delayMs);
  }

  /** Job d'e-mail de la fenêtre courante : déclenché à la fin de la fenêtre, une seule fois. */
  async enqueueEmail(userId: string, now: Date, delayMs = this.config.watch.emailBatchDelayS * 1000): Promise<void> {
    const window = delayMs > 0 ? Math.floor(now.getTime() / delayMs) + 1 : now.getTime();
    const fireAt = delayMs > 0 ? window * delayMs : now.getTime();
    await this.queue.add('alert-email', { userId }, { jobId: jobId('email', userId, window), delayMs: Math.max(0, fireAt - now.getTime()) });
  }
}
