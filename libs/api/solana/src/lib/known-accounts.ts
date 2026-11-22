/**
 * Comptes exclus du calcul de concentration (PROMPT.md §4.1 : « hors LP et programmes connus »).
 * Programmes AMM / launchpads : un wallet propriétaire dont le compte appartient à l'un d'eux est
 * un pool ou une courbe de liaison, pas un holder. Les lockers (vesting) ne sont **pas** exclus :
 * leurs tokens seront débloqués un jour.
 */
export const KNOWN_AMM_PROGRAMS: Readonly<Record<string, string>> = {
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM v4',
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'Raydium CPMM',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM',
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: 'Raydium LaunchLab',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca Whirlpool',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM',
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: 'Meteora DAMM v1',
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: 'Meteora DAMM v2',
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: 'Meteora DBC',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump.fun',
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'PumpSwap',
};

/** Propriétaires connus (autorités de pools, adresse de brûlage). */
export const KNOWN_EXCLUDED_OWNERS: Readonly<Record<string, string>> = {
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1': 'Raydium AMM v4 (autorité)',
  GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL: 'Raydium CPMM (autorité)',
  '1nc1nerator11111111111111111111111111111111': 'Incinérateur (brûlage)',
  '11111111111111111111111111111111': 'System Program',
};

/** Types de comptes RugCheck exclus (pools). */
export const RUGCHECK_EXCLUDED_TYPES: ReadonlySet<string> = new Set(['AMM']);

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const QUOTE_MINTS: ReadonlySet<string> = new Set([
  USDC_MINT,
  WSOL_MINT,
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);
