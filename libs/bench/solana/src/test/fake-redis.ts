import { PREFIXED_CONSUME_CREDITS_SCRIPT } from '@raijin/api-solana';
import type { BenchRedisClient } from '../lib/redis-cache';

/** Redis simulé (tests) : sémantique du script de budget, chaînes avec TTL. Aucun réseau. */
export class FakeRedis implements BenchRedisClient {
  readonly counters = new Map<string, number>();
  readonly strings = new Map<string, { value: string; ttl: number }>();
  failing = false;

  async eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown> {
    if (this.failing) throw new Error('ECONNREFUSED');
    if (script !== PREFIXED_CONSUME_CREDITS_SCRIPT) throw new Error('script inattendu');
    const keys = args.slice(0, numKeys).map(String);
    const credits = Number(args[numKeys]);
    const limits = args.slice(numKeys + 1, numKeys * 2 + 1).map(Number);
    let over = false;
    keys.forEach((key, i) => {
      const used = (this.counters.get(key) ?? 0) + credits;
      this.counters.set(key, used);
      if (used > (limits[i] ?? 0)) over = true;
    });
    if (!over) return 1;
    for (const key of keys) this.counters.set(key, (this.counters.get(key) ?? 0) - credits);
    return 0;
  }

  async get(key: string): Promise<string | null> {
    if (this.failing) throw new Error('ECONNREFUSED');
    const counter = this.counters.get(key);
    if (counter !== undefined) return String(counter);
    return this.strings.get(key)?.value ?? null;
  }

  async set(key: string, value: string, _mode: 'EX', seconds: number): Promise<unknown> {
    if (this.failing) throw new Error('ECONNREFUSED');
    this.strings.set(key, { value, ttl: seconds });
    return 'OK';
  }

  keys(): string[] {
    return [...this.counters.keys(), ...this.strings.keys()].sort();
  }
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
