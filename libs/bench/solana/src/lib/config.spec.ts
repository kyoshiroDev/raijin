import { DEFAULT_SOLANA_DATA_CONFIG, loadSolanaDataConfig } from '@raijin/api-solana';
import { BENCH_SHARED_IP_SOURCES, loadBenchSolanaSettings } from './config';

const BENCH_KEY = 'bench-key-0123456789abcdef';
const RAIJIN_KEY = 'raijin-key-fedcba9876543210';

describe('loadBenchSolanaSettings', () => {
  it('défauts du banc : 3 / 0,5 req/s, 10 000 crédits/jour dont 2 000 pour wallet-study, préfixe raijin-bench:', () => {
    const settings = loadBenchSolanaSettings({});
    expect(settings.heliusApiKey).toBeNull();
    expect(settings.dailyCreditBudget).toBe(10_000);
    expect(settings.walletStudyDailyCredits).toBe(2_000);
    expect(settings.redisPrefix).toBe('raijin-bench:');
    expect(settings.solana.limits?.helius_rpc?.ratePerSecond).toBe(3);
    expect(settings.solana.limits?.helius_das?.ratePerSecond).toBe(0.5);
    expect(settings.solana.heliusDailyCreditBudget).toBe(10_000);
    expect(settings.solana.walletDailyCreditBudget).toBe(2_000);
    expect(settings.solana.watchDailyCreditBudget).toBe(10_000);
  });

  it('sources à IP partagée : moitié des débits de Raijin, au plus', () => {
    const limits = loadBenchSolanaSettings({}).solana.limits ?? {};
    for (const source of BENCH_SHARED_IP_SOURCES) {
      expect(limits[source]?.ratePerSecond).toBeCloseTo(DEFAULT_SOLANA_DATA_CONFIG.limits[source].ratePerSecond / 2, 10);
      expect(limits[source]?.maxQueue).toBeLessThanOrEqual(DEFAULT_SOLANA_DATA_CONFIG.limits[source].maxQueue);
    }
  });

  it('API Raijin inchangée : 7 / 1,5 req/s, 22 000 crédits', () => {
    expect(DEFAULT_SOLANA_DATA_CONFIG.limits.helius_rpc.ratePerSecond).toBe(7);
    expect(DEFAULT_SOLANA_DATA_CONFIG.limits.helius_das.ratePerSecond).toBe(1.5);
    expect(DEFAULT_SOLANA_DATA_CONFIG.heliusDailyCreditBudget).toBe(22_000);
    // Les variables du banc n'ont aucun effet sur la configuration de Raijin.
    const raijin = loadSolanaDataConfig({ HELIUS_API_KEY: RAIJIN_KEY, BENCH_HELIUS_API_KEY: BENCH_KEY, BENCH_HELIUS_RPC_RPS: '1' });
    expect(raijin.heliusApiKey).toBe(RAIJIN_KEY);
    expect(raijin.config.limits.helius_rpc.ratePerSecond).toBe(7);
  });

  it('ne lit que BENCH_HELIUS_API_KEY, jamais HELIUS_API_KEY', () => {
    expect(loadBenchSolanaSettings({ HELIUS_API_KEY: RAIJIN_KEY }).heliusApiKey).toBeNull();
    const settings = loadBenchSolanaSettings({ HELIUS_API_KEY: RAIJIN_KEY, BENCH_HELIUS_API_KEY: ` ${BENCH_KEY} ` });
    expect(settings.heliusApiKey).toBe(BENCH_KEY);
    expect(JSON.stringify(settings)).not.toContain(RAIJIN_KEY);
    expect(loadBenchSolanaSettings({ BENCH_HELIUS_API_KEY: 'factice-a-remplacer-0000' }).heliusApiKey).toBeNull();
    expect(loadBenchSolanaSettings({ BENCH_HELIUS_API_KEY: '   ' }).heliusApiKey).toBeNull();
  });

  it('valeurs plus basses acceptées', () => {
    const settings = loadBenchSolanaSettings({
      BENCH_HELIUS_RPC_RPS: '2',
      BENCH_HELIUS_DAS_RPS: '0.25',
      BENCH_HELIUS_DAILY_CREDIT_BUDGET: '1500',
      BENCH_WALLET_STUDY_DAILY_CREDITS: '0',
    });
    expect(settings.solana.limits?.helius_rpc?.ratePerSecond).toBe(2);
    expect(settings.solana.limits?.helius_das?.ratePerSecond).toBe(0.25);
    expect(settings.dailyCreditBudget).toBe(1_500);
    expect(settings.walletStudyDailyCredits).toBe(0);
    // Budget global sous 2 000 : wallet-study borné au global par défaut.
    expect(loadBenchSolanaSettings({ BENCH_HELIUS_DAILY_CREDIT_BUDGET: '500' }).walletStudyDailyCredits).toBe(500);
  });

  it.each([
    ['BENCH_HELIUS_RPC_RPS', '4'],
    ['BENCH_HELIUS_DAS_RPS', '1'],
    ['BENCH_HELIUS_DAILY_CREDIT_BUDGET', '22000'],
    ['BENCH_HELIUS_DAILY_CREDIT_BUDGET', 'beaucoup'],
    ['BENCH_WALLET_STUDY_DAILY_CREDITS', '-1'],
  ])('%s=%s refusé, message sans la valeur', (name, value) => {
    expect(() => loadBenchSolanaSettings({ [name]: value })).toThrow(new Error(`Configuration Solana du banc invalide : ${name}.`));
  });

  it('wallet-study au-delà du budget global : refusé', () => {
    expect(() => loadBenchSolanaSettings({ BENCH_HELIUS_DAILY_CREDIT_BUDGET: '1000', BENCH_WALLET_STUDY_DAILY_CREDITS: '2000' })).toThrow(
      'BENCH_WALLET_STUDY_DAILY_CREDITS',
    );
  });

  it('clé invalide : erreur sans la valeur', () => {
    const long = 'x'.repeat(300);
    expect(() => loadBenchSolanaSettings({ BENCH_HELIUS_API_KEY: long })).toThrow(/BENCH_HELIUS_API_KEY\.$/);
  });
});
