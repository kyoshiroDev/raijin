import Redis from 'ioredis';

/**
 * Phase 8 : `REDIS_URL=redis://:<hex>@raijin-redis:6379`. Les clients de l'API (BullMQ via `BullMqRuntime.connection`,
 * magasin clé-valeur, compteurs, cache) construisent tous un `ioredis` à partir de cette URL : le mot de passe doit
 * en être extrait (commande AUTH), jamais l'URL journalisée (les erreurs ne sont journalisées que par `errorCode`).
 */
describe('REDIS_URL avec mot de passe (ioredis, BullMQ)', () => {
  it('ioredis extrait hôte, port et mot de passe de l’URL', () => {
    const redis = new Redis('redis://:0a1b2c3d4e5f60718293a4b5c6d7e8f9@raijin-redis:6379', { lazyConnect: true, maxRetriesPerRequest: null });
    expect(redis.options).toMatchObject({ host: 'raijin-redis', port: 6379, password: '0a1b2c3d4e5f60718293a4b5c6d7e8f9' });
    redis.disconnect();
  });
});
