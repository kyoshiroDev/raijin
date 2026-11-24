import { Inject, Injectable, Logger } from '@nestjs/common';
import { BENCH_SESSION_IDLE_SECONDS, BENCH_SESSION_MAX_SECONDS, type BenchLoginRequest, type BenchSession } from '@raijin/bench-contracts';
import { createDummyPasswordVerifier, verifyPassword } from '@raijin/server-security';
import type { BenchConfig } from '../config/bench-config';
import { BENCH_CLOCK, BENCH_CONFIG, type BenchClock } from '../config/tokens';
import { BenchException } from '../http/bench-exception';
import { BenchRedis } from '../redis/bench-redis';
import { RedisCounterStore, ResilientCounterStore, type CounterStore } from '../redis/counter-store';
import { hmac, randomToken } from '../security/crypto';
import { ipBucket } from '../security/ip-bucket';
import { errorCodeOf } from '../security/redact';
import { BenchAuthStore } from './auth.store';
import { BenchSecondFactor } from './second-factor';
import type { BenchRequestSession } from './session';

/** Échecs avant verrouillage d'une IP (empreinte HMAC de son préfixe), et durée de la fenêtre / du verrouillage. */
export const BENCH_LOCKOUT_THRESHOLD = 5;
export const BENCH_LOCKOUT_MS = 15 * 60_000;
/** Échecs, toutes IP confondues, avant verrouillage global du compte (attaque distribuée), même fenêtre. */
export const BENCH_GLOBAL_LOCKOUT_THRESHOLD = 50;
/** `last_seen_at` n'est réécrit qu'une fois par minute au plus. */
export const BENCH_SESSION_TOUCH_MS = 60_000;
const GLOBAL_LOCK_KEY = 'auth:fail:owner';
const IP_LOCK_PREFIX = 'auth:fail:ip:';
const SESSION_TOKEN_MAX = 256;

export interface LoginContext {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface LoginResult {
  readonly token: string;
  readonly session: BenchRequestSession;
  readonly body: BenchSession;
}

/**
 * Authentification du propriétaire unique (docs/ARCHITECTURE.md §17.7) : e-mail + mot de passe argon2id +
 * TOTP (ou code de secours) en une seule étape, une seule erreur `AUTH_INVALID_CREDENTIALS`. Verrouillage de
 * l'IP après 5 échecs en 15 min (compteur Redis `raijin-bench:auth:fail:ip:<HMAC du préfixe d'IP>`, comme Raijin :
 * aucune IP en clair), et du compte entier après 50 échecs toutes IP confondues (`raijin-bench:auth:fail:owner`) ;
 * repli mémoire si Redis tombe ; même les bons identifiants sont refusés pendant le verrouillage. Un tiers ne peut
 * donc plus bloquer le propriétaire avec 5 essais depuis une autre adresse. Le mot de passe est toujours vérifié (factice si besoin) : temps comparable.
 * Sessions opaques (HMAC en base), 2 h d'inactivité, 12 h au plus.
 */
@Injectable()
export class BenchAuthService {
  private readonly logger = new Logger('BenchAuth');
  private readonly dummyVerify = createDummyPasswordVerifier('raijin-bench-dummy-password');
  private readonly secondFactor: BenchSecondFactor;
  private readonly attempts: CounterStore;

  constructor(
    @Inject(BENCH_CONFIG) private readonly config: BenchConfig,
    @Inject(BENCH_CLOCK) private readonly clock: BenchClock,
    private readonly store: BenchAuthStore,
    redis: BenchRedis,
  ) {
    this.secondFactor = new BenchSecondFactor(config.auth.totpKey);
    this.attempts = new ResilientCounterStore(redis.prefixed ? new RedisCounterStore(redis.prefixed) : null, (error) => redis.warn(`Redis indisponible, compteur de connexion en mémoire (${errorCodeOf(error)})`), () => this.clock().getTime());
  }

  private tokenHash(token: string): string {
    return hmac(this.config.auth.sessionSecret, `session:${token}`);
  }

  private ipLockKey(ip: string | null): string {
    return `${IP_LOCK_PREFIX}${hmac(this.config.auth.sessionSecret, `lock-ip:${ipBucket(ip)}`)}`;
  }

  async login(input: BenchLoginRequest, context: LoginContext): Promise<LoginResult> {
    const now = this.clock();
    const ipKey = this.ipLockKey(context.ip);
    const [ipFailures, globalFailures] = await Promise.all([this.attempts.get(ipKey), this.attempts.get(GLOBAL_LOCK_KEY)]);
    const locked = ipFailures >= BENCH_LOCKOUT_THRESHOLD || globalFailures >= BENCH_GLOBAL_LOCKOUT_THRESHOLD;
    const owner = locked ? null : await this.store.findOwner();
    let passwordOk = false;
    if (owner?.passwordHash) passwordOk = await verifyPassword(owner.passwordHash, input.password);
    else await this.dummyVerify(input.password);

    let ok = false;
    if (!locked && owner && passwordOk && owner.totp?.enabled && owner.email === input.email && input.email === this.config.ownerEmail) {
      if (input.totp !== undefined) {
        const step = this.secondFactor.matchTotp(owner.id, owner.totp.secretEncrypted, input.totp, now, owner.totp.lastUsedStep);
        ok = step !== null && (await this.store.consumeTotpStep(owner.id, step, now));
      } else if (input.recovery_code !== undefined) {
        ok = await this.store.consumeRecoveryCode(owner.id, this.secondFactor.hashRecoveryCode(owner.id, input.recovery_code), now);
        if (ok) this.logger.warn('Connexion par code de secours (régénère les codes avec reset-2fa s’il en reste peu)');
      }
    }

    if (!ok || !owner) {
      const [ipCount, globalCount] = await Promise.all([
        this.attempts.increment(ipKey, BENCH_LOCKOUT_MS),
        this.attempts.increment(GLOBAL_LOCK_KEY, BENCH_LOCKOUT_MS),
      ]);
      if (globalCount === BENCH_GLOBAL_LOCKOUT_THRESHOLD) this.logger.warn(`Connexion verrouillée pour toutes les IP ${BENCH_LOCKOUT_MS / 60_000} min après ${BENCH_GLOBAL_LOCKOUT_THRESHOLD} échecs`);
      else if (ipCount === BENCH_LOCKOUT_THRESHOLD) this.logger.warn(`IP verrouillée ${BENCH_LOCKOUT_MS / 60_000} min après ${BENCH_LOCKOUT_THRESHOLD} échecs`);
      else this.logger.warn('Échec de connexion au banc');
      throw BenchException.invalidCredentials();
    }

    await this.attempts.reset(ipKey);
    const token = randomToken(32);
    const expiresAt = new Date(now.getTime() + BENCH_SESSION_MAX_SECONDS * 1000);
    const sessionId = await this.store.createSession({
      ownerId: owner.id,
      tokenHash: this.tokenHash(token),
      userAgent: context.userAgent ? context.userAgent.slice(0, 512) : null,
      ipHash: hmac(this.config.auth.sessionSecret, `ip:${ipBucket(context.ip)}`),
      createdAt: now,
      expiresAt,
    });
    const session: BenchRequestSession = { sessionId, ownerId: owner.id, email: owner.email, expiresAt, token };
    return { token, session, body: this.describe(session) };
  }

  describe(session: BenchRequestSession): BenchSession {
    return { email: session.email, mode: this.config.mode, expiresAt: session.expiresAt.toISOString() };
  }

  /**
   * Session valide pour ce jeton, ou `null` (absente, révoquée, expirée, inactive > 2 h, propriétaire changé).
   * `touch` prolonge l'inactivité (requêtes) ; le flux SSE revalide sans prolonger.
   */
  async validate(token: string | null, options: { touch: boolean } = { touch: true }): Promise<BenchRequestSession | null> {
    if (!token || token.length > SESSION_TOKEN_MAX) return null;
    const now = this.clock();
    let row;
    try {
      row = await this.store.findSession(this.tokenHash(token));
    } catch (error) {
      this.logger.error(`Lecture de session impossible (${errorCodeOf(error)})`);
      return null;
    }
    if (!row || row.revokedAt) return null;
    if (now.getTime() >= row.expiresAt.getTime()) {
      await this.store.revokeSession(row.id, 'expired', now).catch(() => undefined);
      return null;
    }
    if (now.getTime() - row.lastSeenAt.getTime() >= BENCH_SESSION_IDLE_SECONDS * 1000) {
      await this.store.revokeSession(row.id, 'idle', now).catch(() => undefined);
      return null;
    }
    if (row.ownerEmail !== this.config.ownerEmail) return null;
    if (options.touch && now.getTime() - row.lastSeenAt.getTime() >= BENCH_SESSION_TOUCH_MS) await this.store.touchSession(row.id, now).catch(() => undefined);
    return { sessionId: row.id, ownerId: row.ownerId, email: row.ownerEmail, expiresAt: row.expiresAt, token };
  }

  async logout(session: BenchRequestSession): Promise<void> {
    await this.store.revokeSession(session.sessionId, 'logout', this.clock());
  }
}
