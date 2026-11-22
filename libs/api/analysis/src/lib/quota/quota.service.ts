import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, ApiException, errorCode, type AppConfig } from '@raijin/api-core';
import { Prisma, PrismaService } from '@raijin/api-prisma';
import { ANALYSIS_ERROR_MESSAGES, type Plan, type QuotaInfo, type QuotaKind } from '@raijin/shared-contracts';
import { randomUUID } from 'node:crypto';
import { AnalysisClock } from '../ports/facts-collector';
import { KeyValueStore } from '../store/key-value-store';
import { hashIp } from './ip-hash';

/** Demandeur d'une analyse : utilisateur connecté, ou visiteur anonyme identifié par son IP. */
export type QuotaActor = { readonly kind: 'user'; readonly userId: string } | { readonly kind: 'anonymous'; readonly ip: string | null };

/** Politique applicable au demandeur, relue en base à chaque requête (jamais depuis le jeton). */
export interface QuotaPolicy {
  readonly kind: QuotaKind;
  readonly subject: 'user' | 'anonymous';
  readonly userId: string | null;
  readonly ipHash: string | null;
  readonly plan: Plan | null;
  /** `null` : illimité (Pro). */
  readonly limit: number | null;
}

/** Réservation d'une unité de quota, à rembourser si l'analyse échoue. */
export interface QuotaReservation {
  readonly policy: QuotaPolicy;
  readonly day: string;
  /** Faux si l'analyse était déjà comptée (même sujet + mint dans les 10 min) : rien à rembourser. */
  readonly counted: boolean;
  readonly used: number;
  readonly seenKey: string | null;
}

/** Compteur interne des analyses en échec (colonne `UsageCounter.kind`, jamais exposé au front). */
export const FAILURE_KIND = 'analysis_failure';

/** Une même analyse (sujet + mint) répétée dans ce délai ne recompte pas. */
export const QUOTA_DEDUP_TTL_MS = 10 * 60_000;
const UNLIMITED = 2_147_483_647;

/**
 * Quotas journaliers d'analyse (jour UTC), docs/ARCHITECTURE.md §9.6 :
 * anonyme `ANON_ANALYSIS_DAILY_LIMIT` par empreinte d'IP, Gratuit `FREE_…`, essai Pro `TRIAL_…`,
 * Pro illimité (compté pour les statistiques). Réservation atomique en base (`INSERT … ON CONFLICT
 * DO UPDATE … WHERE count < limit`), remboursée si l'analyse échoue. Phase 6 (Stripe) : seule
 * `resolvePolicy` évolue (plan payé, essai, autres `QuotaKind`).
 */
@Injectable()
export class QuotaService {
  private readonly logger = new Logger('Quota');

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: KeyValueStore,
    private readonly clock: AnalysisClock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Politique du demandeur pour un type de quota. */
  async resolvePolicy(actor: QuotaActor, kind: QuotaKind = 'analysis'): Promise<QuotaPolicy> {
    const limits = this.config.analysis;
    if (actor.kind === 'anonymous') {
      return {
        kind,
        subject: 'anonymous',
        userId: null,
        ipHash: hashIp(limits.ipHashSecret, actor.ip),
        plan: null,
        limit: limits.anonDailyLimit,
      };
    }
    const user = await this.prisma.user.findUnique({
      where: { id: actor.userId },
      select: { plan: true, trialStatus: true, trialEndsAt: true },
    });
    if (!user) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    const now = this.clock.now();
    const trialActive = user.trialStatus === 'ACTIVE' && !!user.trialEndsAt && user.trialEndsAt > now;
    let limit: number | null = limits.freeDailyLimit;
    if (user.plan === 'PRO') limit = null;
    else if (trialActive) limit = limits.trialDailyLimit;
    return { kind, subject: 'user', userId: actor.userId, ipHash: null, plan: user.plan, limit };
  }

  /**
   * Réserve une analyse de `mint` pour le demandeur, ou lève 429 `QUOTA_EXCEEDED`.
   * À appeler avant l'analyse ; `refund` si elle échoue.
   */
  async reserve(policy: QuotaPolicy, mint: string): Promise<QuotaReservation> {
    const day = this.today();
    // Trop d'échecs aujourd'hui (tokens inexistants en rafale) : refus avant toute collecte.
    if ((await this.used(policy, day, FAILURE_KIND)) >= this.config.analysis.failedDailyLimit) {
      throw new ApiException('QUOTA_EXCEEDED', HttpStatus.TOO_MANY_REQUESTS, ANALYSIS_ERROR_MESSAGES.QUOTA_EXCEEDED);
    }
    const seenKey = `quota:seen:${policy.kind}:${this.subjectKey(policy)}:${mint}`;
    const fresh = await this.store.setIfAbsent(seenKey, '1', QUOTA_DEDUP_TTL_MS);
    if (fresh === false) {
      return { policy, day, counted: false, used: await this.used(policy, day), seenKey: null };
    }
    const used = await this.increment(policy, day, policy.limit, policy.kind);
    if (used === null) {
      if (fresh) await this.store.delete(seenKey);
      throw new ApiException('QUOTA_EXCEEDED', HttpStatus.TOO_MANY_REQUESTS, ANALYSIS_ERROR_MESSAGES.QUOTA_EXCEEDED);
    }
    return { policy, day, counted: true, used, seenKey: fresh ? seenKey : null };
  }

  /**
   * Analyse échouée : panne des sources (`UPSTREAM_UNAVAILABLE`, notre fait) toujours remboursée ;
   * autre échec (token inexistant…) compté et remboursé jusqu'à `ANALYSIS_FAILED_DAILY_LIMIT` par
   * jour, au-delà l'unité reste consommée. Ne lève jamais.
   */
  async settleFailure(reservation: QuotaReservation, failure: unknown): Promise<void> {
    if (failure instanceof ApiException && failure.code === 'UPSTREAM_UNAVAILABLE') {
      await this.refund(reservation);
      return;
    }
    let failures: number;
    try {
      failures = (await this.increment(reservation.policy, reservation.day, null, FAILURE_KIND)) ?? Number.MAX_SAFE_INTEGER;
    } catch (error) {
      this.logger.error(`Comptage d'échec impossible (${errorCode(error)})`);
      return;
    }
    if (failures <= this.config.analysis.failedDailyLimit) await this.refund(reservation);
  }

  /** Rembourse une réservation (analyse échouée). Ne lève jamais. */
  async refund(reservation: QuotaReservation): Promise<void> {
    if (!reservation.counted) return;
    if (reservation.seenKey) await this.store.delete(reservation.seenKey);
    const { policy, day } = reservation;
    try {
      await this.prisma.$executeRaw`
        UPDATE "UsageCounter" SET "count" = "count" - 1
        WHERE ${this.subjectWhere(policy)} AND "kind" = ${policy.kind} AND "day" = ${day}::date AND "count" > 0`;
    } catch (error) {
      this.logger.error(`Remboursement de quota impossible (${errorCode(error)})`);
    }
  }

  /** Quota restant du demandeur (calculé depuis la base). */
  async info(policy: QuotaPolicy, used?: number): Promise<QuotaInfo> {
    const count = used ?? (await this.used(policy, this.today()));
    return {
      kind: policy.kind,
      subject: policy.subject,
      plan: policy.plan,
      limit: policy.limit,
      used: count,
      remaining: policy.limit === null ? null : Math.max(0, policy.limit - count),
      resetsAt: this.nextReset().toISOString(),
    };
  }

  private subjectKey(policy: QuotaPolicy): string {
    return policy.userId ? `u:${policy.userId}` : `a:${policy.ipHash ?? 'unknown'}`;
  }

  private subjectWhere(policy: QuotaPolicy): Prisma.Sql {
    return policy.userId ? Prisma.sql`"userId" = ${policy.userId}::uuid` : Prisma.sql`"ipHash" = ${policy.ipHash}`;
  }

  /** Incrément atomique sous la limite (`null` : illimité) ; renvoie `null` si la limite est atteinte. */
  private async increment(policy: QuotaPolicy, day: string, max: number | null, kind: string): Promise<number | null> {
    const limit = max ?? UNLIMITED;
    const id = randomUUID();
    const rows = policy.userId
      ? await this.prisma.$queryRaw<{ count: number }[]>`
          INSERT INTO "UsageCounter" ("id", "userId", "ipHash", "kind", "day", "count")
          VALUES (${id}::uuid, ${policy.userId}::uuid, NULL, ${kind}, ${day}::date, 1)
          ON CONFLICT ("userId", "kind", "day")
          DO UPDATE SET "count" = "UsageCounter"."count" + 1 WHERE "UsageCounter"."count" < ${limit}
          RETURNING "count"`
      : await this.prisma.$queryRaw<{ count: number }[]>`
          INSERT INTO "UsageCounter" ("id", "userId", "ipHash", "kind", "day", "count")
          VALUES (${id}::uuid, NULL, ${policy.ipHash}, ${kind}, ${day}::date, 1)
          ON CONFLICT ("ipHash", "kind", "day")
          DO UPDATE SET "count" = "UsageCounter"."count" + 1 WHERE "UsageCounter"."count" < ${limit}
          RETURNING "count"`;
    const count = rows[0]?.count;
    return count === undefined ? null : Number(count);
  }

  private async used(policy: QuotaPolicy, day: string, kind: string = policy.kind): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT "count" FROM "UsageCounter"
      WHERE ${this.subjectWhere(policy)} AND "kind" = ${kind} AND "day" = ${day}::date`;
    return Number(rows[0]?.count ?? 0);
  }

  private today(): string {
    return this.clock.now().toISOString().slice(0, 10);
  }

  private nextReset(): Date {
    const now = this.clock.now();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  }
}
