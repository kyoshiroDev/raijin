import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { AuthContext } from '@raijin/api-auth';
import { APP_CONFIG, ApiException, type AppConfig } from '@raijin/api-core';
import type { Request } from 'express';

export const WALLET_SCAN_THROTTLER = 'wallet-scan';
const WINDOW_MS = 60_000;

/**
 * Limite des scans par **utilisateur** (`RATE_LIMIT_WALLET_SCAN_PER_MINUTE`, 5 en production), en
 * plus de la limite globale par IP et du quota journalier : freine les rafales sur les crédits Helius.
 * Placée après `AuthGuard` (identité connue) ; stockage du throttler global (Redis, repli mémoire).
 */
@Injectable()
export class WalletScanThrottleGuard implements CanActivate {
  constructor(
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const auth = context.switchToHttp().getRequest<Request & { auth?: AuthContext }>().auth;
    if (!auth) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    const limit = this.config.rateLimit.walletScanPerMinute;
    const record = await this.storage.increment(`${WALLET_SCAN_THROTTLER}:u:${auth.userId}`, WINDOW_MS, limit, 0, WALLET_SCAN_THROTTLER);
    if (record.totalHits > limit) throw new ApiException('RATE_LIMITED', HttpStatus.TOO_MANY_REQUESTS);
    return true;
  }
}
