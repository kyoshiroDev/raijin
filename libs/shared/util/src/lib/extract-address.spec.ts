import { isSolanaAddress } from './base58';
import { ANALYSIS_INPUT_MAX_LENGTH, extractSolanaAddress } from './extract-address';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PUMP = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump';
const PAIR = 'Bzc9NZfMqkXR6fz1DBph7BDf9BroyEf6pnzESP7v5iiw';

describe('extractSolanaAddress', () => {
  it('utilise des adresses de test valides', () => {
    expect([USDC, PUMP, PAIR].every(isSolanaAddress)).toBe(true);
  });

  it('accepte une adresse brute (espaces retirés)', () => {
    expect(extractSolanaAddress(`  ${USDC}\n`)).toEqual({ address: USDC, source: 'raw', kind: 'mint' });
  });

  it.each([
    [`https://dexscreener.com/solana/${PAIR}`, PAIR, 'dexscreener', 'pair_or_mint'],
    [`dexscreener.com/solana/${PAIR}?maker=x#top`, PAIR, 'dexscreener', 'pair_or_mint'],
    [`https://www.DexScreener.com/solana/${USDC}`, USDC, 'dexscreener', 'pair_or_mint'],
    [`https://pump.fun/coin/${PUMP}`, PUMP, 'pumpfun', 'mint'],
    [`https://pump.fun/${PUMP}`, PUMP, 'pumpfun', 'mint'],
    [`https://pump.fun/advanced/coin/${PUMP}?ref=abc`, PUMP, 'pumpfun', 'mint'],
    [`https://solscan.io/token/${USDC}`, USDC, 'solscan', 'mint'],
    [`https://solscan.io/token/${USDC}?cluster=mainnet-beta`, USDC, 'solscan', 'mint'],
    [`https://solscan.io/account/${PAIR}`, PAIR, 'solscan', 'pair_or_mint'],
    [`https://birdeye.so/token/${USDC}?chain=solana`, USDC, 'birdeye', 'mint'],
    [`https://birdeye.so/token/${USDC}`, USDC, 'birdeye', 'mint'],
    [`https://birdeye.so/solana/token/${USDC}`, USDC, 'birdeye', 'mint'],
    [`http://solscan.io/token/${USDC}`, USDC, 'solscan', 'mint'],
  ])('extrait l’adresse de %s', (input, address, source, kind) => {
    expect(extractSolanaAddress(input)).toEqual({ address, source, kind });
  });

  it('prend le premier mot reconnu dans une phrase', () => {
    expect(extractSolanaAddress(`regarde https://pump.fun/coin/${PUMP} stp`)?.address).toBe(PUMP);
  });

  it.each([
    '',
    '   ',
    'pas une adresse',
    `https://dexscreener.com/ethereum/${PAIR}`,
    `https://dexscreener.com/solana`,
    `https://evil.com/solana/${USDC}`,
    `https://dexscreener.com.evil.com/solana/${USDC}`,
    `https://user@dexscreener.com/solana/${USDC}`,
    `https://dexscreener.com:8443/solana/${USDC}`,
    `javascript://dexscreener.com/solana/${USDC}`,
    `ftp://solscan.io/token/${USDC}`,
    `https://solscan.io/token/${USDC}?cluster=devnet`,
    `https://solscan.io/tx/${USDC}`,
    `https://birdeye.so/token/${USDC}?chain=ethereum`,
    `https://birdeye.so/ethereum/token/${USDC}`,
    `https://pump.fun/board`,
    `https://pump.fun/coin/0OIl`,
    `https://pump.fun/a/b`,
    `${USDC}0`,
  ])('refuse %j', (input) => {
    expect(extractSolanaAddress(input)).toBeNull();
  });

  it('refuse une saisie trop longue', () => {
    expect(extractSolanaAddress(`${USDC} ${'x'.repeat(ANALYSIS_INPUT_MAX_LENGTH)}`)).toBeNull();
  });
});
