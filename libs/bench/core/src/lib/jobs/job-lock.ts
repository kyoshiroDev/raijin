import { Injectable } from '@nestjs/common';
import { BenchRedis } from '../redis/bench-redis';
import { randomToken } from '../security/crypto';
import { errorCodeOf } from '../security/redact';

/** Verrou anti-chevauchement d'un job (une exécution à la fois, tous processus confondus). */
export abstract class BenchJobLock {
  /** Jeton du verrou, ou `null` s'il est déjà tenu. */
  abstract acquire(job: string, ttlMs: number): Promise<string | null>;
  abstract extend(job: string, token: string, ttlMs: number): Promise<boolean>;
  abstract release(job: string, token: string): Promise<void>;
}

/** Verrou en mémoire (un seul processus : dev/test, ou repli si Redis ne répond pas). */
export class MemoryJobLock extends BenchJobLock {
  private readonly held = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  async acquire(job: string, ttlMs: number): Promise<string | null> {
    const current = this.held.get(job);
    if (current && current.expiresAt > this.now()) return null;
    const token = randomToken(12);
    this.held.set(job, { token, expiresAt: this.now() + ttlMs });
    return token;
  }

  async extend(job: string, token: string, ttlMs: number): Promise<boolean> {
    const current = this.held.get(job);
    if (current?.token !== token) return false;
    current.expiresAt = this.now() + ttlMs;
    return true;
  }

  async release(job: string, token: string): Promise<void> {
    if (this.held.get(job)?.token === token) this.held.delete(job);
  }
}

const EXTEND_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

/**
 * Verrou Redis `raijin-bench:lock:job:<nom>` (`SET NX PX`, libération et prolongation par script à jeton).
 * Redis indisponible : repli sur le verrou en mémoire (un seul conteneur `raijin-bench-api`).
 */
@Injectable()
export class RedisBenchJobLock extends BenchJobLock {
  private readonly memory = new MemoryJobLock();

  constructor(private readonly redis: BenchRedis) {
    super();
  }

  private key(job: string): string {
    return `lock:job:${job}`;
  }

  async acquire(job: string, ttlMs: number): Promise<string | null> {
    const client = this.redis.prefixed;
    if (!client) return this.memory.acquire(job, ttlMs);
    const token = randomToken(12);
    try {
      return (await client.set(this.key(job), token, 'PX', ttlMs, 'NX')) === 'OK' ? token : null;
    } catch (error) {
      this.redis.warn(`Verrou Redis indisponible, verrou en mémoire (${errorCodeOf(error)})`);
      return this.memory.acquire(job, ttlMs);
    }
  }

  async extend(job: string, token: string, ttlMs: number): Promise<boolean> {
    const client = this.redis.prefixed;
    if (!client) return this.memory.extend(job, token, ttlMs);
    try {
      return Number(await client.eval(EXTEND_SCRIPT, 1, this.key(job), token, String(ttlMs))) === 1 || (await this.memory.extend(job, token, ttlMs));
    } catch {
      return this.memory.extend(job, token, ttlMs);
    }
  }

  async release(job: string, token: string): Promise<void> {
    await this.memory.release(job, token);
    const client = this.redis.prefixed;
    if (!client) return;
    try {
      await client.eval(RELEASE_SCRIPT, 1, this.key(job), token);
    } catch {
      // Expirera de lui-même (TTL).
    }
  }
}
