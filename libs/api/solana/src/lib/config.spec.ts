import { DEFAULT_SOLANA_DATA_CONFIG, loadSolanaDataConfig, normaliseHeliusApiKey, resolveSolanaDataConfig } from './config';

describe('configuration Solana', () => {
  it('valeurs par défaut documentées (budgets Helius API 7 / 1,5 req/s)', () => {
    const { config, heliusApiKey } = loadSolanaDataConfig({});
    expect(heliusApiKey).toBeNull();
    expect(config).toEqual(DEFAULT_SOLANA_DATA_CONFIG);
    expect(config.limits.helius_rpc.ratePerSecond).toBe(7);
    expect(config.limits.helius_das.ratePerSecond).toBe(1.5);
  });

  it('variables d’environnement (banc : 3 / 0,5 req/s, 10 000 crédits)', () => {
    const { config, heliusApiKey } = loadSolanaDataConfig({
      HELIUS_API_KEY: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
      HELIUS_RPC_RPS: '3',
      HELIUS_DAS_RPS: '0.5',
      HELIUS_DAILY_CREDIT_BUDGET: '10000',
      SOLANA_RPC_URL: 'https://rpc.example.org/',
      SOLANA_RPC_RPS: '',
    });
    expect(heliusApiKey).toBe('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0');
    expect(config.limits.helius_rpc).toEqual({ ratePerSecond: 3, maxQueue: 50, timeoutMs: 3_000 });
    expect(config.limits.helius_das.ratePerSecond).toBe(0.5);
    expect(config.heliusDailyCreditBudget).toBe(10_000);
    expect(config.publicRpcUrl).toBe('https://rpc.example.org');
  });

  it.each([
    ['http://insecure.example.org'],
    ['https://user:pass@example.org'],
    ['https://example.org/?api-key=x'],
    ['file:///etc/passwd'],
  ])('refuse l’URL %s sans citer sa valeur', (url) => {
    expect(() => loadSolanaDataConfig({ DEXSCREENER_API_URL: url })).toThrow('Configuration Solana invalide : DEXSCREENER_API_URL.');
    try {
      loadSolanaDataConfig({ DEXSCREENER_API_URL: url });
    } catch (error) {
      expect((error as Error).message).not.toContain(url);
    }
  });

  it('refuse un débit invalide', () => {
    expect(() => loadSolanaDataConfig({ HELIUS_RPC_RPS: '-1' })).toThrow('HELIUS_RPC_RPS');
  });

  it.each([
    [undefined, null],
    ['', null],
    ['changeme-helius-factice', null],
    ['trop court', null],
    ['  0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0 ', '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'],
  ])('normaliseHeliusApiKey(%p)', (raw, expected) => {
    expect(normaliseHeliusApiKey(raw)).toBe(expected);
  });

  it('fusion profonde des limites et TTL', () => {
    const config = resolveSolanaDataConfig({ limits: { jupiter: { timeoutMs: 9_000 } }, cacheTtlSeconds: { rugcheck: 60 } });
    expect(config.limits.jupiter).toEqual({ ...DEFAULT_SOLANA_DATA_CONFIG.limits.jupiter, timeoutMs: 9_000 });
    expect(config.cacheTtlSeconds).toEqual({ ...DEFAULT_SOLANA_DATA_CONFIG.cacheTtlSeconds, rugcheck: 60 });
  });
});
