import { HttpStatus, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KeyValueStore } from '@raijin/api-analysis';
import { JobQueue, JobRegistry, JobRunService, jobId, WatchesService, type JobData } from '@raijin/api-alerts';
import { APP_CONFIG, ApiException, errorCode, isTrialActive, planPolicyLimits, randomToken, type AppConfig } from '@raijin/api-core';
import { TrialMailService } from '@raijin/api-notifications';
import { PrismaService, type Prisma } from '@raijin/api-prisma';
import type { BillingInterval } from '@raijin/shared-contracts';
import * as z from 'zod';
import { TrialRecapService, trialNotFound } from './trial-recap.service';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Utilisateurs traités par lot. */
export const TRIAL_BATCH = 200;
export const TRIAL_TICK_LOCK_KEY = 'lock:trial-tick';
const TRIAL_TICK_LOCK_TTL_MS = 15 * 60_000;
export const TRIAL_TICK_JOB = 'trial-tick';
export const TRIAL_EMAIL_JOB = 'trial-email';

export const TRIAL_EMAIL_KINDS = ['day1', 'dayMinus2', 'ended'] as const;
export type TrialEmailKind = (typeof TRIAL_EMAIL_KINDS)[number];
const trialEmailData = z.object({ userId: z.uuid(), kind: z.enum(TRIAL_EMAIL_KINDS) }).strict();
/** Données du tick : `now` seulement depuis la route interne de test (horloge simulée), jamais par BullMQ. */
const tickData = z.object({ now: z.iso.datetime().optional() }).strict();

export interface TrialTickResult {
  readonly [key: string]: number | boolean;
  readonly expired: number;
  readonly pausedWatches: number;
  readonly day1: number;
  readonly dayMinus2: number;
  readonly ended: number;
}

/** Heure (0-23) à Paris pour `now`. */
export function parisHour(now: Date): number {
  const hour = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Paris' }).format(now);
  return Number(hour);
}

/** Colonne d'idempotence de chaque e-mail. */
const MAIL_COLUMN = { day1: 'trialDay1MailAt', dayMinus2: 'trialDayMinus2MailAt', ended: 'trialEndMailAt' } as const;

/**
 * Cycle de vie de l'essai Pro (docs/ARCHITECTURE.md §13.3, §13.7) :
 * - job horaire `trial-tick` (file `maintenance`, `TRIAL_JOB_CRON`, verrou Redis, `JobRun`), par lots de 200 :
 *   expiration (→ `ENDED`, suivis au-delà de la limite Gratuite en pause `plan_limit`, jamais supprimés,
 *   `trial_expired {pausedWatches}`, e-mail J0) puis e-mails J+1 et J-2 à partir de `TRIAL_EMAIL_HOUR` (Paris) ;
 * - job `trial-email` (file `notify`, `jobId` dédié) : un e-mail, colonne d'idempotence posée **avant** la mise en file ;
 * - fin anticipée par l'abonnement (`endTrialOnSubscriptionInTx`, appelée par `api-billing` dans sa transaction).
 */
@Injectable()
export class TrialLifecycleService implements OnModuleInit {
  private readonly logger = new Logger('Trial');

  constructor(
    private readonly prisma: PrismaService,
    private readonly watches: WatchesService,
    private readonly queue: JobQueue,
    private readonly registry: JobRegistry,
    private readonly runs: JobRunService,
    private readonly store: KeyValueStore,
    private readonly mail: TrialMailService,
    private readonly recaps: TrialRecapService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: TRIAL_TICK_JOB,
      queue: 'maintenance',
      scheduler: { pattern: this.config.trial.jobCron, tz: 'UTC' },
      manualRun: true,
      handler: async (data: JobData) => {
        const parsed = tickData.safeParse(data ?? {});
        // Depuis BullMQ, l'horloge est toujours l'heure réelle : `now` n'est accepté que par la route interne.
        return this.tick(parsed.success && parsed.data.now && this.config.jobs.testTrigger && !this.config.isProduction ? new Date(parsed.data.now) : new Date());
      },
    });
    this.registry.register({
      name: TRIAL_EMAIL_JOB,
      queue: 'notify',
      handler: async (data: JobData) => {
        const parsed = trialEmailData.parse(data);
        return this.sendEmail(parsed.userId, parsed.kind);
      },
    });
  }

  /**
   * Une exécution du job (verrou : une seule instance à la fois). `onlyUserId` : tests e2e seulement
   * (route interne), pour qu'une horloge simulée ne touche que le compte du test.
   */
  async tick(now: Date = new Date(), onlyUserId?: string): Promise<TrialTickResult | { locked: true }> {
    const owner = randomToken(12);
    if ((await this.store.setIfAbsent(TRIAL_TICK_LOCK_KEY, owner, TRIAL_TICK_LOCK_TTL_MS)) === false) return { locked: true };
    try {
      return await this.runs.track(TRIAL_TICK_JOB, () => this.run(now, onlyUserId ? { id: onlyUserId } : {}));
    } finally {
      await this.store.deleteIfEquals(TRIAL_TICK_LOCK_KEY, owner);
    }
  }

  private async run(now: Date, scope: Prisma.UserWhereInput): Promise<TrialTickResult> {
    const { expired, pausedWatches, ended } = await this.expire(now, scope);
    const emailsOpen = parisHour(now) >= this.config.trial.emailHour;
    const day1 = emailsOpen ? await this.scheduleDay1(now, scope) : 0;
    const dayMinus2 = emailsOpen ? await this.scheduleDayMinus2(now, scope) : 0;
    return { expired, pausedWatches, day1, dayMinus2, ended };
  }

  /** Essais échus : `ENDED`, limite Gratuite appliquée, `trial_expired`, e-mail J0 (toujours, sauf abonné Pro). */
  private async expire(now: Date, scope: Prisma.UserWhereInput): Promise<{ expired: number; pausedWatches: number; ended: number }> {
    let expired = 0;
    let pausedWatches = 0;
    let ended = 0;
    for (;;) {
      const batch = await this.prisma.user.findMany({
        where: { ...scope, trialStatus: 'ACTIVE', trialEndsAt: { lte: now } },
        select: { id: true },
        orderBy: { trialEndsAt: 'asc' },
        take: TRIAL_BATCH,
      });
      let progressed = 0;
      for (const { id } of batch) {
        try {
          const result = await this.expireOne(id, now);
          if (!result) continue;
          progressed += 1;
          expired += 1;
          pausedWatches += result.paused;
          if (result.mail) ended += 1;
        } catch (error) {
          // Un compte en erreur ne bloque pas les autres ; il sera repris au prochain passage.
          this.logger.warn(`Fin d'essai non appliquée (${errorCode(error)})`);
        }
      }
      // Lot sans aucun progrès (comptes tous en erreur) : on s'arrête, ils seront repris au prochain passage.
      if (batch.length < TRIAL_BATCH || progressed === 0) break;
    }
    return { expired, pausedWatches, ended };
  }

  private async expireOne(userId: string, now: Date): Promise<{ paused: number; mail: boolean } | null> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.user.updateMany({ where: { id: userId, trialStatus: 'ACTIVE', trialEndsAt: { lte: now } }, data: { trialStatus: 'ENDED' } });
      if (changed.count === 0) return null;
      const change = await this.watches.enforcePlanLimitInTx(tx, userId);
      await tx.productEvent.create({ data: { userId, type: 'trial_expired', properties: { pausedWatches: change.count } } });
      // J0 : jamais pour un abonné Pro (l'abonnement a déjà terminé l'essai) ; colonne posée avant l'envoi.
      const mail = await tx.user.updateMany({ where: { id: userId, plan: 'FREE', trialEndMailAt: null }, data: { trialEndMailAt: now } });
      return { change, mail: mail.count === 1 };
    });
    if (!outcome) return null;
    await this.watches.refreshPriorities(outcome.change.mints);
    if (outcome.mail) await this.queue.add(TRIAL_EMAIL_JOB, { userId, kind: 'ended' }, { jobId: jobId('trial-j0', userId) });
    return { paused: outcome.change.count, mail: outcome.mail };
  }

  /** J+1 : au moins 24 h d'essai, encore actif, avant la fenêtre du J-2, préférence active. */
  private scheduleDay1(now: Date, scope: Prisma.UserWhereInput): Promise<number> {
    return this.schedule('day1', now, {
      ...scope,
      trialStartedAt: { lte: new Date(now.getTime() - DAY_MS) },
      trialEndsAt: { gt: new Date(now.getTime() + 2 * DAY_MS) },
      trialDay1MailAt: null,
    });
  }

  /** J-2 : moins de 48 h avant la fin, encore actif, préférence active. */
  private scheduleDayMinus2(now: Date, scope: Prisma.UserWhereInput): Promise<number> {
    return this.schedule('dayMinus2', now, {
      ...scope,
      trialEndsAt: { gt: now, lte: new Date(now.getTime() + 2 * DAY_MS) },
      trialDayMinus2MailAt: null,
    });
  }

  private async schedule(kind: 'day1' | 'dayMinus2', now: Date, where: Prisma.UserWhereInput): Promise<number> {
    const column = MAIL_COLUMN[kind];
    let sent = 0;
    for (;;) {
      let progressed = 0;
      const batch = await this.prisma.user.findMany({
        where: { ...where, trialStatus: 'ACTIVE', plan: 'FREE', notifyTrialEmails: true, emailVerifiedAt: { not: null } },
        select: { id: true },
        take: TRIAL_BATCH,
      });
      for (const { id } of batch) {
        const claimed = await this.prisma.user.updateMany({ where: { id, [column]: null }, data: { [column]: now } });
        if (claimed.count === 0) continue;
        await this.queue.add(TRIAL_EMAIL_JOB, { userId: id, kind }, { jobId: jobId(kind === 'day1' ? 'trial-day1' : 'trial-dayminus2', id) });
        sent += 1;
        progressed += 1;
      }
      if (batch.length < TRIAL_BATCH || progressed === 0) break;
    }
    return sent;
  }

  /**
   * Envoi d'un e-mail d'essai (job `trial-email`). Relit le compte : J+1 / J-2 ne partent plus si l'essai
   * est terminé ou la préférence désactivée entre-temps ; J0 part toujours. Une erreur d'envoi lève :
   * BullMQ réessaie (5 tentatives) avec le même `jobId`.
   */
  async sendEmail(userId: string, kind: TrialEmailKind, now: Date = new Date()): Promise<{ sent: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, plan: true, trialStatus: true, trialEndsAt: true, notifyTrialEmails: true },
    });
    if (!user?.trialEndsAt) return { sent: false };
    const free = planPolicyLimits(this.config).free;
    // Abonné Pro au moment de l'envoi (abonnement pris entre la fin d'essai et le job) : aucun e-mail d'essai, J0 compris.
    if (user.plan !== 'FREE') return { sent: false };
    if (kind !== 'ended' && (!user.notifyTrialEmails || !isTrialActive(user, now))) return { sent: false };
    const recap = await this.recaps.recap(userId, now);
    if (kind === 'day1') await this.mail.sendDay1(user.email, recap);
    else if (kind === 'dayMinus2') await this.mail.sendDayMinus2(user.email, recap, user.trialEndsAt, free);
    else await this.mail.sendEnded(user.email, recap, free);
    return { sent: true };
  }

  /** `POST trial/end-screen/seen` : l'écran de fin d'essai ne réapparaît plus (tous appareils). */
  async markEndScreenSeen(userId: string, now: Date = new Date()): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { trialStartedAt: true } });
    if (!user?.trialStartedAt) throw trialNotFound();
    await this.prisma.user.updateMany({ where: { id: userId, trialEndScreenSeenAt: null }, data: { trialEndScreenSeenAt: now } });
  }

  /**
   * **Méthode pour `api-billing`**, à appeler dans la transaction du webhook qui passe le compte en Pro
   * (après l'écriture de `Subscription` et de `User.plan`) :
   * - essai actif → terminé tout de suite (`ENDED`, `trialEndsAt = now`), `trial_converted {phase: during}` ;
   * - essai terminé depuis moins de `TRIAL_CONVERSION_WINDOW_DAYS` → `trial_converted {phase: after}` ;
   * - sinon (jamais d'essai, refus, fenêtre dépassée, conversion déjà comptée) → rien.
   * Renvoie la phase comptée, ou `null`. Idempotent (rejeu du webhook : une seule conversion).
   */
  async endTrialOnSubscriptionInTx(tx: Prisma.TransactionClient, userId: string, interval: BillingInterval, now: Date = new Date()): Promise<'during' | 'after' | null> {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { trialStatus: true, trialStartedAt: true, trialEndsAt: true } });
    if (!user?.trialStartedAt || !user.trialEndsAt) return null;
    if (await tx.productEvent.findFirst({ where: { userId, type: 'trial_converted' }, select: { id: true } })) {
      if (user.trialStatus === 'ACTIVE') await tx.user.update({ where: { id: userId }, data: { trialStatus: 'ENDED', trialEndsAt: now } });
      return null;
    }
    let phase: 'during' | 'after' | null = null;
    if (user.trialStatus === 'ACTIVE' && user.trialEndsAt.getTime() > now.getTime()) {
      await tx.user.update({ where: { id: userId }, data: { trialStatus: 'ENDED', trialEndsAt: now } });
      phase = 'during';
    } else {
      if (user.trialStatus === 'ACTIVE') await tx.user.update({ where: { id: userId }, data: { trialStatus: 'ENDED' } });
      if ((user.trialStatus === 'ACTIVE' || user.trialStatus === 'ENDED') && now.getTime() - user.trialEndsAt.getTime() <= this.config.trial.conversionWindowDays * DAY_MS) phase = 'after';
    }
    if (phase) await tx.productEvent.create({ data: { userId, type: 'trial_converted', properties: { phase, interval } } });
    return phase;
  }

  /** Même chose dans sa propre transaction (tests, outils). */
  endTrialOnSubscription(userId: string, interval: BillingInterval, now: Date = new Date()): Promise<'during' | 'after' | null> {
    return this.prisma.$transaction((tx) => this.endTrialOnSubscriptionInTx(tx, userId, interval, now));
  }

  /** Garde des routes de test (horloge simulée) : 404 hors `JOBS_TEST_TRIGGER=1` ou en production. */
  assertTestClock(): void {
    if (!this.config.jobs.testTrigger || this.config.isProduction) throw new ApiException('NOT_FOUND', HttpStatus.NOT_FOUND);
  }
}
