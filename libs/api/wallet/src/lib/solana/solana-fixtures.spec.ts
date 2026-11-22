import { Logger } from '@nestjs/common';
import { FIXTURE_HELIUS_KEY, MemoryKeyValueStore, solanaDataOptions } from '@raijin/api-analysis';
import { ApiException, testConfig } from '@raijin/api-core';
import { SolanaDataService } from '@raijin/api-solana';
import { walletScanResponseSchema } from '@raijin/shared-contracts';
import { join } from 'node:path';
import { walletKit } from '../../testing/wallet-test-kit';
import { SolanaWalletDataSource } from './solana-wallet-data-source';

/**
 * Chaîne complète sur la **vraie** collecte (`SolanaDataService.listWalletHoldings` +
 * `collectFactsLightBatch`, voie `wallet`) rejouée depuis les fixtures de wallets de
 * `@raijin/api-solana` (docs/ARCHITECTURE.md §12.10), sans réseau.
 */
const FIXTURES_DIR = join(__dirname, '..', '..', '..', '..', 'solana', 'src', 'fixtures');
const WALLETS = {
  delegation: 'HeESQ5wM9nFoXTgiNY2XWpK5PtiUfQ7kTvk3kk6ksZwf',
  danger: '2Vm2knf2ywSNrKhQSgKTE3sUawpzs9GY32HYeDvA6W6N',
  empty: '54SpU9vgpM99H5qc91upiTYXe3i7gQ2RM78BHZoTDayp',
  program: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  tooLarge: '53Bmgioqf3gPGEKErmJtVaJrV8SoDf52nPVzeNALMaVW',
};

function realKit() {
  const config = testConfig({ ANALYSIS_FIXTURES: '1', ANALYSIS_FIXTURES_DIR: FIXTURES_DIR });
  const solana = new SolanaDataService(solanaDataOptions(config, new MemoryKeyValueStore(), null, undefined, null, FIXTURE_HELIUS_KEY));
  const source = new SolanaWalletDataSource(solana, () => config.wallet.maxTokens);
  return walletKit({ source, env: { ANALYSIS_FIXTURES_DIR: FIXTURES_DIR } });
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return error instanceof ApiException ? error.code : String(error);
  }
}

describe('scan sur la collecte réelle rejouée (fixtures de wallets)', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'debug'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('délégations SPL et Token-2022, résultat contractuel', async () => {
    const kit = realKit();
    const response = await kit.scan.scan('0195a0c4-0000-7000-8000-000000000001', { address: WALLETS.delegation });
    expect(walletScanResponseSchema.safeParse(response).success).toBe(true);
    expect(response.scan.summary.delegationCount).toBeGreaterThanOrEqual(2);
    expect(response.scan.delegations.map((delegation) => delegation.tokenProgram).sort()).toEqual(expect.arrayContaining(['spl-token', 'token-2022']));
  });

  it('wallet avec un token Danger (verdict rapide)', async () => {
    const kit = realKit();
    const { scan } = await kit.scan.scan('0195a0c4-0000-7000-8000-000000000001', { address: WALLETS.danger });
    expect(scan.summary.verdicts.danger).toBeGreaterThanOrEqual(1);
    expect(scan.tokens.some((token) => token.assessment.status === 'analyzed' && token.assessment.coverage === 'light')).toBe(true);
  });

  it('wallet vide, programme, wallet trop gros', async () => {
    const kit = realKit();
    const empty = await kit.scan.scan('0195a0c4-0000-7000-8000-000000000001', { address: WALLETS.empty });
    expect(empty.scan.summary.tokenCount).toBe(0);
    await expect(code(kit.scan.scan('0195a0c4-0000-7000-8000-000000000001', { address: WALLETS.program }))).resolves.toBe('WALLET_INVALID');
    await expect(code(kit.scan.scan('0195a0c4-0000-7000-8000-000000000001', { address: WALLETS.tooLarge }))).resolves.toBe('WALLET_TOO_LARGE');
  });
});
