import { describe, expect, it } from 'vitest';
import { hasRecoveryError } from './recovery-url';

describe('hasRecoveryError', () => {
  it('is false for a clean URL or a PKCE code', () => {
    expect(hasRecoveryError('', '')).toBe(false);
    expect(hasRecoveryError('?code=abc', '')).toBe(false);
  });

  it('detects errors in the query string', () => {
    expect(hasRecoveryError('?error=access_denied&error_description=Expired', '')).toBe(true);
  });

  it('detects errors in the hash fragment', () => {
    expect(hasRecoveryError('', '#error_code=otp_expired')).toBe(true);
  });
});
