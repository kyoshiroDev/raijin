import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AnalysisClock, QuotaService, type QuotaPolicy, type QuotaReservation } from '@raijin/api-analysis';
import { APP_CONFIG, ApiException, PLAN_POLICY_USER_SELECT, planPolicyLimits, resolvePlanPolicy, type AppConfig } from '@raijin/api-core';
import { PrismaService } from '@raijin/api-prisma';
import { WALLET_ERROR_MESSAGES, type Plan, type QuotaInfo, type WalletScanQuotaResponse } from '@raijin/shared-contracts';

/** Droits au scan, relus en base à chaque requête (jamais depuis le jeton ni le front). */
export interface WalletScanRights {
  readonly userId: string;
  readonly plan: Plan;
  readonly trialActive: boolean;
  /** Pro payé ou essai actif, e-mail vérifié. */
  readonly allowed: boolean;
  /** Politique de quota `wallet_scan` (`null` si le scan n'est pas autorisé). */
  readonly policy: QuotaPolicy | null;
}

/**
 * Le même wallet re-scanné par le même utilisateur dans ce délai ne recompte pas le quota
 * (`quota:seen:wallet_scan:u:<userId>:<hmac>`, docs/ARCHITECTURE.md §12.5).
 */
export const WALLET_QUOTA_DEDUP_TTL_MS = 600_000;

export function planRequired(): ApiException {
  return new ApiException('WALLET_SCAN_PLAN_REQUIRED', HttpStatus.FORBIDDEN, WALLET_ERROR_MESSAGES.WALLET_SCAN_PLAN_REQUIRED);
}

export function quotaExceeded(): ApiException {
  return new ApiException('WALLET_SCAN_QUOTA_EXCEEDED', HttpStatus.TOO_MANY_REQUESTS, WALLET_ERROR_MESSAGES.WALLET_SCAN_QUOTA_EXCEEDED);
}

/**
 * Droits et quota du scan de wallet (docs/ARCHITECTURE.md §12.7) : Pro `WALLET_SCAN_DAILY_LIMIT_PRO`,
 * essai `WALLET_SCAN_DAILY_LIMIT_TRIAL`, Gratuit et e-mail non vérifié refusés (403, aucun compteur
 * touché). Réservation atomique `UsageCounter` kind `wallet_scan` par `QuotaService` (même plafond
 * d'échecs remboursés que l'analyse). Droits : `resolvePlanPolicy` (docs/ARCHITECTURE.md §13.4).
 */
@Injectable()
export class WalletAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: QuotaService,
    private readonly clock: AnalysisClock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async rights(userId: string): Promise<WalletScanRights> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: PLAN_POLICY_USER_SELECT,
    });
    if (!user) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    const plan = resolvePlanPolicy(user, planPolicyLimits(this.config), this.clock.now());
    const limit = plan.entitlements.walletScansPerDay;
    const allowed = plan.emailVerified && limit > 0;
    const policy: QuotaPolicy | null = allowed
      ? { kind: 'wallet_scan', subject: 'user', userId, ipHash: null, plan: user.plan, limit }
      : null;
    return { userId, plan: user.plan, trialActive: plan.trialActive, allowed, policy };
  }

  /** Droits d'un compte autorisé, sinon 403 `WALLET_SCAN_PLAN_REQUIRED`. */
  async requireAllowed(userId: string): Promise<WalletScanRights & { readonly policy: QuotaPolicy }> {
    const rights = await this.rights(userId);
    if (!rights.allowed || !rights.policy) throw planRequired();
    return { ...rights, policy: rights.policy };
  }

  /** Réserve un scan (clé = empreinte HMAC du wallet), ou 429 `WALLET_SCAN_QUOTA_EXCEEDED`. */
  async reserve(policy: QuotaPolicy, walletHash: string): Promise<QuotaReservation> {
    try {
      return await this.quota.reserve(policy, walletHash, WALLET_QUOTA_DEDUP_TTL_MS);
    } catch (error) {
      // Quota du jour atteint, ou trop d'échecs aujourd'hui (plafond partagé avec l'analyse).
      if (error instanceof ApiException && error.code === 'QUOTA_EXCEEDED') throw quotaExceeded();
      throw error;
    }
  }

  /** Scan échoué : remboursé sous les plafonds d'échecs de l'analyse. Ne lève jamais. */
  settleFailure(reservation: QuotaReservation, failure: unknown): Promise<void> {
    return this.quota.settleFailure(reservation, failure);
  }

  info(policy: QuotaPolicy, used?: number): Promise<QuotaInfo> {
    return this.quota.info(policy, used);
  }

  /** `GET wallet-scans/quota` : Gratuit `{allowed: false, quota: null}`. */
  async quotaResponse(userId: string): Promise<WalletScanQuotaResponse> {
    const rights = await this.rights(userId);
    if (!rights.allowed || !rights.policy) return { allowed: false, quota: null };
    return { allowed: true, quota: await this.quota.info(rights.policy) };
  }
}
