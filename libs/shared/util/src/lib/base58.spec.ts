import { decodeBase58, isBase58, isSolanaAddress } from './base58';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

describe('base58', () => {
  it('reconnaît les caractères base58', () => {
    expect(isBase58(USDC_MINT)).toBe(true);
    expect(isBase58('')).toBe(false);
    expect(isBase58('0OIl')).toBe(false);
    expect(isBase58('abc def')).toBe(false);
  });

  it('décode en octets', () => {
    expect(decodeBase58(SYSTEM_PROGRAM)).toEqual(new Uint8Array(32));
    expect(decodeBase58('2g')).toEqual(Uint8Array.from([0x61]));
    expect(decodeBase58('0')).toBeNull();
  });

  it('valide une adresse Solana', () => {
    expect(isSolanaAddress(USDC_MINT)).toBe(true);
    expect(isSolanaAddress(SYSTEM_PROGRAM)).toBe(true);
    expect(isSolanaAddress('So11111111111111111111111111111111111111112')).toBe(true);
  });

  it('refuse les adresses invalides', () => {
    expect(isSolanaAddress('')).toBe(false);
    expect(isSolanaAddress('abc')).toBe(false);
    expect(isSolanaAddress(`${USDC_MINT}xxxx`)).toBe(false);
    expect(isSolanaAddress(USDC_MINT.replace('E', '0'))).toBe(false);
    // 44 caractères base58 mais décodage > 32 octets
    expect(isSolanaAddress('z'.repeat(44))).toBe(false);
  });
});
