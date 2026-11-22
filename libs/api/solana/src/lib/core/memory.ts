import { SYSTEM_CLOCK, type CacheStore, type Clock, type CreditBudget, type CreditLane } from './ports';

/** Cache mémoire borné (repli quand l'hôte ne fournit pas de cache ; tests). */
export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    private readonly clock: Clock = SYSTEM_CLOCK,
    private readonly maxEntries = 2_000,
  ) {}

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.clock.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.clock.now() + ttlSeconds * 1_000 });
  }
}

/**
 * Budget journalier en mémoire (jour UTC), propre au processus : plafond global et plafonds
 * optionnels par voie (la voie `watch` est comptée dans les deux).
 */
export class MemoryCreditBudget implements CreditBudget {
  private day = '';
  private used = 0;
  private readonly usedByLane = new Map<CreditLane, number>();

  constructor(
    private readonly dailyLimit: number,
    private readonly clock: Clock = SYSTEM_CLOCK,
    private readonly laneLimits: Readonly<Partial<Record<CreditLane, number>>> = {},
  ) {}

  async tryConsume(credits: number, lane: CreditLane = 'interactive'): Promise<boolean> {
    const today = new Date(this.clock.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
      this.usedByLane.clear();
    }
    const laneUsed = this.usedByLane.get(lane) ?? 0;
    const laneLimit = this.laneLimits[lane];
    if (this.used + credits > this.dailyLimit) return false;
    if (laneLimit !== undefined && laneUsed + credits > laneLimit) return false;
    this.used += credits;
    this.usedByLane.set(lane, laneUsed + credits);
    return true;
  }
}
