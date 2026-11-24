import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { BILLING_CONFIG, type BillingConfig } from '@raijin/api-billing';
import { AdminSecurityService, AuditService, AuthService, type AuditEntry, type ClientInfo } from '@raijin/api-auth';
import {
  afterCursor,
  APP_CONFIG,
  ApiException,
  buildTrialDetails,
  encodePageCursor,
  isGiftActive,
  isTrialActive,
  PLAN_POLICY_USER_SELECT,
  planPolicyLimits,
  resolvePlanPolicy,
  trialStatusOf,
  type AppConfig,
} from '@raijin/api-core';
import { Prisma, PrismaService } from '@raijin/api-prisma';
import { UsersService } from '@raijin/api-users';
import {
  ADMIN_GIFT_DAYS,
  ADMIN_GIFT_MAX_DAYS_AHEAD,
  ADMIN_USER_AUDIT_MAX,
  stripeDashboardCustomerUrl,
  type AdminUserActionRequest,
  type AdminUserActionResult,
  type AdminUserActionType,
  type AdminUserDetail,
  type AdminUserListQuery,
  type AdminUserPage,
  type AdminUserStatus,
  type AdminUserSummary,
  type AuditSnapshot,
  type Subscription,
} from '@raijin/shared-contracts';

const DAY_MS = 86_400_000;
/** Une entrée `admin.user_viewed` par admin et par fiche au plus toutes les 10 minutes. */
export const USER_VIEW_AUDIT_INTERVAL_MS = 10 * 60_000;
/** Statuts Prisma d'un abonnement qui donnent le plan Pro (`PRO_SUBSCRIPTION_STATUSES`). */
const PRO_STATUSES = ['ACTIVE', 'TRIALING', 'PAST_DUE'] as const;
export const DIRECT_SOURCE = '(direct)';

const userSelect = {
  ...PLAN_POLICY_USER_SELECT,
  id: true,
  email: true,
  role: true,
  suspendedAt: true,
  createdAt: true,
  lastLoginAt: true,
  utmSource: true,
  utmMedium: true,
  utmCampaign: true,
  referrer: true,
  landingPath: true,
  stripeCustomerId: true,
} satisfies Prisma.UserSelect;
type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;

/** Échappe `%`, `_` et `\` d'un fragment cherché par `LIKE` (Prisma ne le fait pas). */
export function escapeLike(fragment: string): string {
  return fragment.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function clip(value: string | null, max: number): string | null {
  return value === null ? null : value.slice(0, max);
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function notAllowed(): ApiException {
  return ApiException.admin('ADMIN_ACTION_NOT_ALLOWED', HttpStatus.CONFLICT);
}

/** Acteur d'une action : l'admin dont la session admin est vérifiée. */
export interface AdminActor {
  readonly userId: string;
  readonly client: ClientInfo | null;
}

/**
 * Comptes vus par l'admin (docs/ARCHITECTURE.md §14.8) : recherche et fiche **auditées**, liste filtrable, six actions
 * confirmées, chacune auditée (avant / après) dans la transaction de la modification. Aucune usurpation de compte.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly security: AdminSecurityService,
    private readonly auth: AuthService,
    private readonly users: UsersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    /** Résout `BILLING_CONFIG` (fourni par `ApiBillingModule.forRoot` de l'app) pour le mode de facturation. */
    private readonly moduleRef: ModuleRef,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Liste et recherche
  // ---------------------------------------------------------------------------------------------

  async list(query: AdminUserListQuery, actor: AdminActor, now: Date = new Date()): Promise<AdminUserPage> {
    const where = this.listWhere(query, now);
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where: { AND: [where, (afterCursor(query.cursor) as Prisma.UserWhereInput | undefined) ?? {}] },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        select: userSelect,
      }),
      this.prisma.user.count({ where }),
    ]);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    if (query.q) {
      // Consultation de données personnelles : nombre de résultats et empreinte du texte, jamais le texte.
      await this.audit.recordStrict({
        action: 'admin.user_searched',
        actorKind: 'admin',
        actorId: actor.userId,
        userId: null,
        client: actor.client,
        metadata: { details: { resultCount: total, queryHmac: this.audit.fingerprint(query.q) } },
      });
    }
    const pro = await this.proSubscribers(page.map((row) => row.id));
    return {
      items: page.map((row) => this.summary(row, now, pro.has(row.id))),
      nextCursor: rows.length > query.limit && last ? encodePageCursor(last) : null,
      total,
    };
  }

  /** Filtres (plan **effectif**, état d'essai exposé, statut du compte, source, période d'inscription). */
  listWhere(query: AdminUserListQuery, now: Date): Prisma.UserWhereInput {
    const and: Prisma.UserWhereInput[] = [];
    if (query.q) and.push({ email: { contains: escapeLike(query.q), mode: 'insensitive' } });
    const trialActive: Prisma.UserWhereInput = { trialStatus: 'ACTIVE', trialEndsAt: { gt: now } };
    const giftActive: Prisma.UserWhereInput = { proGrantedUntil: { gt: now } };
    const pro: Prisma.UserWhereInput = { OR: [{ plan: 'PRO' }, trialActive, giftActive] };
    if (query.plan === 'PRO') and.push(pro);
    if (query.plan === 'FREE') and.push({ NOT: pro });
    if (query.trialStatus === 'active') and.push(trialActive);
    if (query.trialStatus === 'ended') and.push({ OR: [{ trialStatus: 'ENDED' }, { trialStatus: 'ACTIVE', trialEndsAt: { lte: now } }] });
    if (query.trialStatus === 'none') and.push({ trialStatus: 'NONE' });
    if (query.trialStatus === 'ineligible') and.push({ trialStatus: 'INELIGIBLE' });
    if (query.status === 'suspended') and.push({ suspendedAt: { not: null } });
    if (query.status === 'unverified') and.push({ suspendedAt: null, emailVerifiedAt: null });
    if (query.status === 'active') and.push({ suspendedAt: null, emailVerifiedAt: { not: null } });
    if (query.source) and.push({ utmSource: query.source === DIRECT_SOURCE ? null : query.source });
    if (query.signupFrom) and.push({ createdAt: { gte: new Date(`${query.signupFrom}T00:00:00.000Z`) } });
    if (query.signupTo) and.push({ createdAt: { lt: new Date(Date.parse(`${query.signupTo}T00:00:00.000Z`) + DAY_MS) } });
    return and.length ? { AND: and } : {};
  }

  // ---------------------------------------------------------------------------------------------
  // Fiche
  // ---------------------------------------------------------------------------------------------

  /** `GET admin/users/:id` : consultation auditée (une entrée par admin et par fiche toutes les 10 min). */
  async detail(userId: string, actor: AdminActor, now: Date = new Date(), auditView = true): Promise<AdminUserDetail> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: userSelect });
    if (!user) throw new ApiException('NOT_FOUND', HttpStatus.NOT_FOUND);
    if (auditView) await this.auditView(userId, actor, now);

    const since30 = new Date(now.getTime() - 30 * DAY_MS);
    const today = startOfUtcDay(now);
    const [latest, proSub, analysesToday, analyses30d, walletScans, alerts30d, watchesActive, watchesPaused, pushSubscriptions, audit] =
      await Promise.all([
        this.prisma.subscription.findFirst({ where: { userId }, orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }] }),
        this.prisma.subscription.findFirst({ where: { userId, status: { in: [...PRO_STATUSES] } }, orderBy: { updatedAt: 'desc' } }),
        this.prisma.usageCounter.findFirst({ where: { userId, kind: 'analysis', day: today }, select: { count: true } }),
        this.prisma.tokenAnalysis.count({ where: { userId, createdAt: { gte: since30 } } }),
        this.prisma.usageCounter.aggregate({ where: { userId, kind: 'wallet_scan', day: { gte: startOfUtcDay(since30) } }, _sum: { count: true } }),
        this.prisma.alert.count({ where: { userId, createdAt: { gte: since30 } } }),
        this.prisma.watch.count({ where: { userId, status: 'active' } }),
        this.prisma.watch.count({ where: { userId, status: 'paused' } }),
        this.prisma.pushSubscription.count({ where: { userId } }),
        this.audit.forUser(userId, ADMIN_USER_AUDIT_MAX),
      ]);
    const shown = proSub ?? latest;
    const subscription: Subscription | null = shown
      ? {
          status: shown.status.toLowerCase() as Subscription['status'],
          interval: shown.interval === 'YEAR' ? 'year' : 'month',
          currentPeriodEnd: shown.currentPeriodEnd.toISOString(),
          cancelAtPeriodEnd: shown.cancelAtPeriodEnd,
        }
      : null;
    const summary = this.summary(user, now, proSub !== null);
    return {
      ...summary,
      emailVerified: user.emailVerifiedAt !== null,
      trial: buildTrialDetails(user, now),
      subscription,
      stripeDashboardUrl: this.stripeDashboardUrl(user.stripeCustomerId),
      giftEndsAt: isGiftActive(user, now) ? iso(user.proGrantedUntil) : null,
      suspendedAt: iso(user.suspendedAt),
      attribution: {
        utmSource: clip(user.utmSource, 200),
        utmMedium: clip(user.utmMedium, 200),
        utmCampaign: clip(user.utmCampaign, 200),
        referrer: clip(user.referrer, 2048),
        landingPath: clip(user.landingPath, 512),
      },
      usage: {
        analysesToday: analysesToday?.count ?? 0,
        analyses30d,
        walletScans30d: walletScans._sum.count ?? 0,
        alerts30d,
      },
      watches: { active: watchesActive, paused: watchesPaused },
      pushSubscriptions,
      audit,
      availableActions: this.availableActions(user, actor.userId, proSub !== null, now),
    };
  }

  /** Actions possibles dans l'état du compte (aucune sur un admin ni sur soi-même). */
  availableActions(
    user: Pick<UserRow, 'id' | 'role' | 'plan' | 'trialStatus' | 'trialStartedAt' | 'trialEndsAt' | 'emailVerifiedAt' | 'suspendedAt'>,
    actorId: string,
    hasProSubscription: boolean,
    now: Date,
  ): AdminUserActionType[] {
    if (user.role === 'ADMIN' || user.id === actorId) return [];
    const subscribed = hasProSubscription || user.plan === 'PRO';
    const actions: AdminUserActionType[] = [];
    const trial = trialStatusOf(user, now);
    if (!subscribed && (trial === 'active' || (trial === 'ended' && user.trialStartedAt !== null))) actions.push('extend_trial');
    if (!subscribed) actions.push('grant_pro_month');
    actions.push(user.suspendedAt ? 'reactivate' : 'suspend');
    if (!user.emailVerifiedAt && !user.suspendedAt) actions.push('resend_verification');
    actions.push('delete');
    return actions;
  }

  // ---------------------------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------------------------

  /** `POST admin/users/:id/actions` : confirmation vérifiée côté serveur, audit avant / après dans la transaction. */
  async act(userId: string, request: AdminUserActionRequest, actor: AdminActor, now: Date = new Date()): Promise<AdminUserActionResult> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: userSelect });
    if (!user) throw new ApiException('NOT_FOUND', HttpStatus.NOT_FOUND);
    const hasPro = (await this.proSubscribers([userId])).has(userId);
    if (!this.availableActions(user, actor.userId, hasPro, now).includes(request.type)) throw notAllowed();
    if ((request.type === 'suspend' || request.type === 'delete') && request.confirmEmail !== user.email.toLowerCase()) {
      throw ApiException.admin('ADMIN_CONFIRMATION_MISMATCH', HttpStatus.BAD_REQUEST);
    }
    const entry = (action: string, metadata: AuditEntry['metadata']): AuditEntry => ({
      action,
      actorKind: 'admin',
      actorId: actor.userId,
      userId,
      client: actor.client,
      metadata,
    });

    let auditLogId: string;
    switch (request.type) {
      case 'extend_trial':
        auditLogId = await this.extendTrial(userId, request.days, request.reason, entry, now);
        break;
      case 'grant_pro_month':
        auditLogId = await this.grantProMonth(userId, request.reason, entry, now);
        break;
      case 'suspend':
        auditLogId = await this.suspend(userId, request.reason, entry, now);
        break;
      case 'reactivate':
        auditLogId = await this.reactivate(userId, request.reason, entry);
        break;
      case 'resend_verification':
        await this.auth.resendVerification(userId, undefined);
        auditLogId = (await this.audit.recordStrict(entry('admin.verification_resent', {}))).id;
        break;
      case 'delete': {
        // Code TOTP frais de l'admin (anti-force brute commun), puis le flux de `DELETE users/me`.
        await this.security.verifyFreshTotp(actor.userId, request.totpCode, actor.client, now);
        let id = '';
        await this.users.deleteAccount(userId, actor.client, {
          actorKind: 'admin',
          actorId: actor.userId,
          beforeDelete: async (tx) => {
            const before: AuditSnapshot = { plan: user.plan, trialStatus: user.trialStatus, emailVerified: user.emailVerifiedAt !== null };
            id = (await this.audit.recordInTx(tx, entry('admin.user_deleted', { before, reason: request.reason }))).id;
          },
        });
        return { type: 'delete', auditLogId: id, user: null };
      }
    }
    return { type: request.type, auditLogId, user: await this.detail(userId, actor, now, false) };
  }

  /** Essai actif : `trialEndsAt += j` ; essai terminé sans abonnement : réouvert jusqu'à `now + j` (e-mails remis à zéro). */
  private async extendTrial(userId: string, days: number, reason: string, entry: (action: string, metadata: AuditEntry['metadata']) => AuditEntry, now: Date): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.user.findUnique({ where: { id: userId }, select: { trialStatus: true, trialEndsAt: true, trialStartedAt: true, plan: true } });
      if (!row || row.plan === 'PRO' || !row.trialStartedAt || !row.trialEndsAt) throw notAllowed();
      const before: AuditSnapshot = { trialStatus: row.trialStatus, trialEndsAt: row.trialEndsAt.toISOString() };
      let endsAt: Date;
      if (isTrialActive(row, now)) {
        endsAt = new Date(row.trialEndsAt.getTime() + days * DAY_MS);
        await tx.user.update({ where: { id: userId }, data: { trialEndsAt: endsAt } });
      } else if (row.trialStatus === 'ENDED' || row.trialStatus === 'ACTIVE') {
        endsAt = new Date(now.getTime() + days * DAY_MS);
        await tx.user.update({
          where: { id: userId },
          data: { trialStatus: 'ACTIVE', trialEndsAt: endsAt, trialDayMinus2MailAt: null, trialEndMailAt: null, trialEndScreenSeenAt: null },
        });
      } else {
        throw notAllowed();
      }
      const after: AuditSnapshot = { trialStatus: 'ACTIVE', trialEndsAt: endsAt.toISOString() };
      return (await this.audit.recordInTx(tx, entry('admin.trial_extended', { before, after, reason, details: { days } }))).id;
    });
  }

  /** `proGrantedUntil = max(now, actuel) + 30 j`, au plus `now + 365 j` ; refusé avec un abonnement Pro en cours. */
  private async grantProMonth(userId: string, reason: string, entry: (action: string, metadata: AuditEntry['metadata']) => AuditEntry, now: Date): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.user.findUnique({ where: { id: userId }, select: { plan: true, proGrantedUntil: true } });
      if (!row || row.plan === 'PRO') throw notAllowed();
      const current = row.proGrantedUntil && row.proGrantedUntil.getTime() > now.getTime() ? row.proGrantedUntil.getTime() : now.getTime();
      const cap = now.getTime() + ADMIN_GIFT_MAX_DAYS_AHEAD * DAY_MS;
      if (current >= cap) throw notAllowed();
      const until = new Date(Math.min(current + ADMIN_GIFT_DAYS * DAY_MS, cap));
      await tx.user.update({ where: { id: userId }, data: { proGrantedUntil: until, proGrantEndedAt: null } });
      return (
        await this.audit.recordInTx(
          tx,
          entry('admin.pro_month_granted', {
            before: { proGrantedUntil: iso(row.proGrantedUntil) },
            after: { proGrantedUntil: until.toISOString() },
            reason,
            details: { days: Math.round((until.getTime() - current) / DAY_MS) },
          }),
        )
      ).id;
    });
  }

  /** Suspension : sessions révoquées, abonnements push retirés ; l'abonnement Stripe n'est pas résilié (la fiche le signale). */
  private async suspend(userId: string, reason: string, entry: (action: string, metadata: AuditEntry['metadata']) => AuditEntry, now: Date): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.user.updateMany({ where: { id: userId, suspendedAt: null, role: 'USER' }, data: { suspendedAt: now } });
      if (changed.count !== 1) throw notAllowed();
      const sessions = await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, revokedReason: 'suspended' } });
      await tx.pushSubscription.deleteMany({ where: { userId } });
      return (
        await this.audit.recordInTx(
          tx,
          entry('admin.user_suspended', { before: { suspendedAt: null }, after: { suspendedAt: now.toISOString() }, reason, details: { sessionsRevoked: sessions.count } }),
        )
      ).id;
    });
  }

  private async reactivate(userId: string, reason: string, entry: (action: string, metadata: AuditEntry['metadata']) => AuditEntry): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.user.findUnique({ where: { id: userId }, select: { suspendedAt: true } });
      if (!row?.suspendedAt) throw notAllowed();
      await tx.user.update({ where: { id: userId }, data: { suspendedAt: null } });
      return (
        await this.audit.recordInTx(tx, entry('admin.user_reactivated', { before: { suspendedAt: row.suspendedAt.toISOString() }, after: { suspendedAt: null }, reason }))
      ).id;
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Outils
  // ---------------------------------------------------------------------------------------------

  private summary(row: UserRow, now: Date, hasProSubscription: boolean): AdminUserSummary {
    const policy = resolvePlanPolicy(row, planPolicyLimits(this.config), now);
    const status: AdminUserStatus = row.suspendedAt ? 'suspended' : row.emailVerifiedAt ? 'active' : 'unverified';
    return {
      id: row.id,
      email: row.email,
      plan: hasProSubscription ? 'PRO' : policy.effectivePlan,
      planSource: hasProSubscription ? 'subscription' : policy.source,
      role: row.role,
      status,
      trialStatus: trialStatusOf(row, now),
      createdAt: row.createdAt.toISOString(),
      lastLoginAt: iso(row.lastLoginAt),
      utmSource: clip(row.utmSource, 200),
    };
  }

  private async proSubscribers(userIds: readonly string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.prisma.subscription.findMany({
      where: { userId: { in: [...userIds] }, status: { in: [...PRO_STATUSES] } },
      select: { userId: true },
    });
    return new Set(rows.map((row) => row.userId));
  }

  private async auditView(userId: string, actor: AdminActor, now: Date): Promise<void> {
    const recent = await this.prisma.auditLog.findFirst({
      where: { action: 'admin.user_viewed', actorId: actor.userId, userId, createdAt: { gt: new Date(now.getTime() - USER_VIEW_AUDIT_INTERVAL_MS) } },
      select: { id: true },
    });
    if (!recent) {
      await this.audit.recordStrict({ action: 'admin.user_viewed', actorKind: 'admin', actorId: actor.userId, userId, client: actor.client });
    }
  }

  /**
   * Lien vers le client dans le dashboard Stripe selon le **mode de facturation** (clé `sk_live_` → réel, sinon
   * `/test/`), jamais selon `NODE_ENV` ; identifiant vérifié (`stripeDashboardCustomerUrl`).
   */
  stripeDashboardUrl(customerId: string | null): string | null {
    if (!customerId || !/^cus_[A-Za-z0-9]{1,64}$/.test(customerId)) return null;
    return stripeDashboardCustomerUrl(customerId, this.billingLivemode());
  }

  /** `BillingConfig.livemode` ; configuration de facturation absente : mode test (lien `/test/`). */
  private billingLivemode(): boolean {
    try {
      return this.moduleRef.get<BillingConfig>(BILLING_CONFIG, { strict: false }).livemode === true;
    } catch {
      return false;
    }
  }
}
