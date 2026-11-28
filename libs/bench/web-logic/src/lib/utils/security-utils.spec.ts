import { describe, expect, it } from 'vitest';
import { isSolanaAddress, shortAddress } from './solana-address';
import { safeExternalUrl } from './safe-url';

describe('isSolanaAddress', () => {
  it('accepts real mints', () => {
    expect(isSolanaAddress('So11111111111111111111111111111111111111112')).toBe(true);
    expect(isSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true);
  });
  it('rejects invalid base58, wrong lengths and non-strings', () => {
    expect(isSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDtlv')).toBe(false); // l is not base58
    expect(isSolanaAddress('So111')).toBe(false);
    expect(isSolanaAddress(undefined)).toBe(false);
  });
  it('shortens for display', () => {
    expect(shortAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe('EPjF…Dt1v');
  });
});

describe('safeExternalUrl', () => {
  it('rejects dangerous schemes', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,x')).toBeNull();
    expect(safeExternalUrl('http://site.com')).toBeNull();
  });
  it('enforces social allowlists', () => {
    expect(safeExternalUrl('https://x.com/a', 'x')).toBe('https://x.com/a');
    expect(safeExternalUrl('https://x.com.phish.io/a', 'x')).toBeNull();
    expect(safeExternalUrl('https://t.me/a', 'telegram')).toBe('https://t.me/a');
    expect(safeExternalUrl('https://evil.io/img.png', 'image')).toBeNull();
  });
  it('rejects credentials and IP literals', () => {
    expect(safeExternalUrl('https://a:b@site.com')).toBeNull();
    expect(safeExternalUrl('https://10.0.0.1')).toBeNull();
  });
});
