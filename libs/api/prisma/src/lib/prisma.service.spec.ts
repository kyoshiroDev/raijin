import { testConfig } from '@raijin/api-core';
import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  const service = new PrismaService(testConfig({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/raijin' }));

  it('isHealthy : vrai si la base répond, faux sinon', async () => {
    const query = jest.spyOn(service, '$queryRaw');
    query.mockResolvedValueOnce([{ '?column?': 1 }] as never);
    await expect(service.isHealthy()).resolves.toBe(true);
    query.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(service.isHealthy()).resolves.toBe(false);
  });

  it('démarre même si la base est injoignable (erreur journalisée), se ferme proprement', async () => {
    jest.spyOn(service, '$connect').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    jest.spyOn(service, '$disconnect').mockResolvedValueOnce();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });
});
