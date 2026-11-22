import { Injectable, Logger } from '@nestjs/common';
import { AnalysisClock } from '@raijin/api-analysis';
import { errorCode } from '@raijin/api-core';
import { AlertMailService, type DigestWatch } from '@raijin/api-notifications';
import { PrismaService } from '@raijin/api-prisma';
import { JobRunService } from '../jobs/job-run.service';
import { parseToken } from '../watch/snapshot';

const WEEK_MS = 7 * 86_400_000;
/** Marge : un résumé par semaine au plus, même si le job est rejoué ou décalé. */
const MIN_GAP_MS = 6 * 86_400_000;
const BATCH = 100;

/**
 * Résumé hebdomadaire (lundi 08:00 Europe/Paris, désactivable, désactivé par défaut) : verdict actuel
 * et alertes de la semaine par suivi actif. Envoi réservé (`weeklyDigestSentAt`) avant l'envoi ;
 * relâché si l'envoi échoue. Exige un e-mail vérifié.
 */
@Injectable()
export class WeeklyDigestService {
  private readonly logger = new Logger('WeeklyDigest');

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: AlertMailService,
    private readonly runs: JobRunService,
    private readonly clock: AnalysisClock,
  ) {}

  run(): Promise<{ sent: number; failed: number }> {
    return this.runs.track('weekly-digest', () => this.send());
  }

  private async send(): Promise<{ sent: number; failed: number }> {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - MIN_GAP_MS);
    let sent = 0;
    let failed = 0;
    let after: string | undefined;
    for (;;) {
      const users = await this.prisma.user.findMany({
        where: {
          notifyWeeklyDigest: true,
          emailVerifiedAt: { not: null },
          watches: { some: { status: 'active' } },
          OR: [{ weeklyDigestSentAt: null }, { weeklyDigestSentAt: { lt: cutoff } }],
          ...(after ? { id: { gt: after } } : {}),
        },
        orderBy: { id: 'asc' },
        take: BATCH,
        select: { id: true, email: true, weeklyDigestSentAt: true },
      });
      if (users.length === 0) break;
      after = users[users.length - 1]?.id;
      for (const user of users) {
        const reserved = await this.prisma.user.updateMany({
          where: { id: user.id, OR: [{ weeklyDigestSentAt: null }, { weeklyDigestSentAt: { lt: cutoff } }] },
          data: { weeklyDigestSentAt: now },
        });
        if (reserved.count === 0) continue;
        try {
          await this.mail.sendWeeklyDigest(user.email, await this.watchesOf(user.id, now));
          sent += 1;
        } catch (error) {
          failed += 1;
          await this.prisma.user.updateMany({ where: { id: user.id, weeklyDigestSentAt: now }, data: { weeklyDigestSentAt: user.weeklyDigestSentAt } });
          this.logger.warn(`Résumé non envoyé (${errorCode(error)})`);
        }
      }
      if (users.length < BATCH) break;
    }
    return { sent, failed };
  }

  private async watchesOf(userId: string, now: Date): Promise<DigestWatch[]> {
    const watches = await this.prisma.watch.findMany({ where: { userId, status: 'active' }, orderBy: { createdAt: 'asc' }, take: 50, select: { mint: true, lastVerdict: true } });
    const mints = watches.map((watch) => watch.mint);
    const [states, counts] = await Promise.all([
      this.prisma.mintWatchState.findMany({ where: { mint: { in: mints } }, select: { mint: true, token: true } }),
      this.prisma.alert.groupBy({ by: ['mint'], where: { userId, mint: { in: mints }, createdAt: { gte: new Date(now.getTime() - WEEK_MS) } }, _count: { _all: true } }),
    ]);
    const tokens = new Map(states.map((state) => [state.mint, parseToken(state.token)]));
    const alerts = new Map(counts.map((entry) => [entry.mint, entry._count._all]));
    return watches.map((watch) => ({ mint: watch.mint, token: tokens.get(watch.mint) ?? null, lastVerdict: watch.lastVerdict, alertsThisWeek: alerts.get(watch.mint) ?? 0 }));
  }
}
