import type { LogFields, SolanaLogger } from './core/ports';
import { SolanaDataService } from './solana-data.service';
import { createFixtureFetch, loadAllFixtures } from './testing/fixture-fetch';

const KEY = 'leak-check-KEY-9f8e7d6c5b4a';
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

/** Test anti-fuite (ARCHITECTURE.md §9.3) : la clé Helius n'apparaît ni dans les journaux, ni dans les résultats, ni dans les erreurs. */
describe('anti-fuite de la clé Helius', () => {
  it('erreurs réseau contenant l’URL : clé absente des journaux, du résultat et des statuts', async () => {
    const lines: string[] = [];
    const logger: SolanaLogger = {
      debug: (event: string, fields: LogFields) => lines.push(JSON.stringify({ event, fields })),
      warn: (event: string, fields: LogFields) => lines.push(JSON.stringify({ event, fields })),
    };
    // Helius injoignable (erreur undici simulée avec l'URL complète), autres sources rejouées.
    const fixtureFetch = createFixtureFetch(loadAllFixtures(), undefined, (url) => {
      if (url.includes('helius')) throw new TypeError(`fetch failed: ${url}`);
      return undefined;
    });
    const service = new SolanaDataService({
      heliusApiKey: KEY,
      logger,
      fetch: fixtureFetch.fetch,
      config: { maxAttempts: 1, signaturePageLimit: 100, maxSignaturePages: 1 },
    });
    const result = await service.collectFacts(MINT);

    expect(fixtureFetch.urls.some((url) => url.includes(KEY))).toBe(true);
    const everything = [JSON.stringify(result), ...lines, JSON.stringify(service.breakerStates()), JSON.stringify(service.config)].join('\n');
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain('api-key');
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(service)).not.toContain('api-key=');
  });

  it('erreur remontée à l’appelant : ni clé, ni URL, ni cause', async () => {
    const service = new SolanaDataService({
      heliusApiKey: KEY,
      fetch: async (url) => {
        throw new TypeError(`fetch failed: ${url}`);
      },
      config: { maxAttempts: 1 },
    });
    const error = (await service.collectFacts(MINT).catch((e: unknown) => e)) as Error;
    expect(error.name).toBe('UpstreamError');
    expect(error.cause).toBeUndefined();
    expect(`${error.message} ${error.stack ?? ''} ${JSON.stringify(error)}`).not.toContain(KEY);
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain('helius-rpc');
  });
});
