import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { AuthContext } from '@raijin/api-auth';
import { ApiException } from '@raijin/api-core';
import type { Request } from 'express';
import { BILLING_CONFIG, type BillingConfig } from '../config/billing-config';

export const BILLING_THROTTLER = 'billing';
const WINDOW_MS = 60_000;

/**
 * Sessions Checkout / portail / simulation par **utilisateur** et par minute (`RATE_LIMIT_BILLING_PER_MINUTE`,
 * 10 par défaut), en plus de la limite globale par IP. Placée après `AuthGuard`.
 */
@Injectable()
export class BillingThrottleGuard implements CanActivate {
  constructor(
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const auth = context.switchToHttp().getRequest<Request & { auth?: AuthContext }>().auth;
    if (!auth) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    const limit = this.config.perMinute;
    const record = await this.storage.increment(`${BILLING_THROTTLER}:u:${auth.userId}`, WINDOW_MS, limit, 0, BILLING_THROTTLER);
    if (record.totalHits > limit) throw new ApiException('RATE_LIMITED', HttpStatus.TOO_MANY_REQUESTS);
    return true;
  }
}
