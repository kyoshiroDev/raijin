import { MemoryCacheStore, MemoryCreditBudget } from './memory';

describe('MemoryCacheStore', () => {
  it('expire les entrées et borne la taille', async () => {
    let now = 0;
    const cache = new MemoryCacheStore({ now: () => now }, 2);
    await cache.set('a', '1', 10);
    await cache.set('b', '2', 10);
    await cache.set('c', '3', 10);
    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('b')).toBe('2');
    now = 10_000;
    expect(await cache.get('c')).toBeNull();
    expect(await cache.get('absent')).toBeNull();
  });
});

describe('MemoryCreditBudget', () => {
  it('limite journalière remise à zéro au changement de jour UTC', async () => {
    let now = Date.parse('2026-11-22T23:59:00Z');
    const budget = new MemoryCreditBudget(15, { now: () => now });
    expect(await budget.tryConsume(10)).toBe(true);
    expect(await budget.tryConsume(10)).toBe(false);
    expect(await budget.tryConsume(5)).toBe(true);
    now = Date.parse('2026-11-23T00:00:01Z');
    expect(await budget.tryConsume(10)).toBe(true);
  });
});
