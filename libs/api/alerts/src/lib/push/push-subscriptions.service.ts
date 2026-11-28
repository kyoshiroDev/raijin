import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '@raijin/api-core';
import { PushSender } from '@raijin/api-notifications';
import { PrismaService } from '@raijin/api-prisma';
import {
  WATCH_ERROR_MESSAGES,
  type PushSubscriptionRequest,
  type PushSubscriptionResponse,
  type VapidPublicKeyResponse,
} from '@raijin/shared-contracts';
import { PlanLimitsService } from '../plan/plan-limits.service';

/** Appareils abonnés au push au plus par compte (le plus ancien est remplacé). */
export const MAX_PUSH_SUBSCRIPTIONS = 10;
const USER_AGENT_MAX = 256;

const notSupported = () => new ApiException('PUSH_NOT_SUPPORTED', HttpStatus.SERVICE_UNAVAILABLE, WATCH_ERROR_MESSAGES.PUSH_NOT_SUPPORTED);

/**
 * Abonnements push (docs/ARCHITECTURE.md §11.7). L'endpoint (filtré par `PUSH_SERVICE_HOSTS` dans
 * le contrat) n'est jamais journalisé ni renvoyé. Un endpoint ré-abonné par un autre compte avec les
 * mêmes clés lui est réattribué (appareil partagé) ; avec d'autres clés : 409 `CONFLICT`.
 */
@Injectable()
export class PushSubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanLimitsService,
    private readonly push: PushSender,
  ) {}

  publicKey(): VapidPublicKeyResponse {
    if (!this.push.configured || !this.push.publicKey) throw notSupported();
    return { publicKey: this.push.publicKey };
  }

  async subscribe(userId: string, body: PushSubscriptionRequest, userAgent: string | null): Promise<PushSubscriptionResponse> {
    if (!this.push.configured) throw notSupported();
    const rights = await this.plans.verifiedRights(userId);
    if (!rights.limits.pushAlerts) throw new ApiException('PUSH_PLAN_REQUIRED', HttpStatus.FORBIDDEN, WATCH_ERROR_MESSAGES.PUSH_PLAN_REQUIRED);
    const agent = userAgent ? userAgent.slice(0, USER_AGENT_MAX) : null;
    // Endpoint déjà abonné par un autre compte : réattribué seulement si le navigateur prouve qu'il
    // s'agit du même abonnement (mêmes clés). Sinon 409 : un endpoint connu (fuite, journal tiers)
    // ne permet pas de détourner les notifications d'un autre compte.
    const existing = await this.prisma.pushSubscription.findUnique({ where: { endpoint: body.endpoint }, select: { userId: true, p256dh: true, auth: true } });
    if (existing && existing.userId !== userId && (existing.p256dh !== body.keys.p256dh || existing.auth !== body.keys.auth)) {
      throw new ApiException('CONFLICT', HttpStatus.CONFLICT, WATCH_ERROR_MESSAGES.PUSH_SUBSCRIPTION_INVALID);
    }
    const row = await this.prisma.pushSubscription.upsert({
      where: { endpoint: body.endpoint },
      create: { userId, endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth, userAgent: agent },
      update: { userId, p256dh: body.keys.p256dh, auth: body.keys.auth, userAgent: agent },
      select: { id: true, createdAt: true },
    });
    const all = await this.prisma.pushSubscription.findMany({ where: { userId }, orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }], select: { id: true } });
    const excess = all.slice(MAX_PUSH_SUBSCRIPTIONS).map((entry) => entry.id);
    if (excess.length > 0) await this.prisma.pushSubscription.deleteMany({ where: { id: { in: excess }, userId } });
    return { id: row.id, createdAt: row.createdAt.toISOString() };
  }

  /** Désabonnement (déconnexion, refus) : 204 même si l'endpoint est inconnu ou d'un autre compte. */
  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
  }
}
