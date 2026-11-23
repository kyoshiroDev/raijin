import { Test } from '@nestjs/testing';
import { BenchPrismaModule } from './bench-prisma.module';
import { safeErrorCode } from './bench-prisma.options';
import { BenchPrismaService } from './bench-prisma.service';

const URL = 'postgresql://u:mot-de-passe-factice@127.0.0.1:1/raijin_bench';

describe('BenchPrismaService', () => {
  const service = new BenchPrismaService({ databaseUrl: URL });

  it('isHealthy : vrai si la base répond, faux sinon', async () => {
    const query = jest.spyOn(service, '$queryRaw');
    query.mockResolvedValueOnce([{ '?column?': 1 }] as never);
    await expect(service.isHealthy()).resolves.toBe(true);
    query.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(service.isHealthy()).resolves.toBe(false);
  });

  it('databaseSizeBytes : pg_database_size converti en nombre', async () => {
    jest
      .spyOn(service, '$queryRaw')
      .mockResolvedValueOnce([{ size: 133_000_000n }] as never);
    await expect(service.databaseSizeBytes()).resolves.toBe(133_000_000);
  });

  it('démarre même si la base est injoignable, sans journaliser l’URL', async () => {
    const error = Object.assign(new Error(`connexion à ${URL} refusée`), {
      code: 'ECONNREFUSED',
    });
    jest.spyOn(service, '$connect').mockRejectedValueOnce(error);
    const log = jest
      .spyOn(service['logger'], 'error')
      .mockImplementation(() => undefined);
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      'Connexion à la base du banc impossible (ECONNREFUSED)',
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      'mot-de-passe-factice',
    );
    jest.spyOn(service, '$disconnect').mockResolvedValueOnce();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });
});

describe('safeErrorCode', () => {
  it('garde un code court, jamais le message', () => {
    expect(safeErrorCode({ code: 'P1001', message: URL })).toBe('P1001');
    expect(safeErrorCode({ code: URL })).toBe('UNKNOWN');
    expect(safeErrorCode(new Error(URL))).toBe('UNKNOWN');
    expect(safeErrorCode(null)).toBe('UNKNOWN');
  });
});

describe('BenchPrismaModule', () => {
  it('forRoot et forRootAsync fournissent le service avec l’URL de l’application', async () => {
    for (const imported of [
      BenchPrismaModule.forRoot({ databaseUrl: URL }),
      BenchPrismaModule.forRootAsync({
        useFactory: () => ({ databaseUrl: URL }),
      }),
    ]) {
      const moduleRef = await Test.createTestingModule({
        imports: [imported],
      }).compile();
      // Le client Prisma 7 renvoie un objet étendu (pas d'instanceof) : on vérifie l'interface.
      const service = moduleRef.get(BenchPrismaService);
      expect(typeof service.isHealthy).toBe('function');
      expect(typeof service.databaseSizeBytes).toBe('function');
      await moduleRef.close();
    }
  });
});
