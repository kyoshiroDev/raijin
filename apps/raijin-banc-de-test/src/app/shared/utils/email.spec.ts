import { describe, expect, it } from 'vitest';
import { isPlausibleEmail, normalizeEmail } from './email';

describe('email utils', () => {
  it('accepts plausible addresses and rejects the rest', () => {
    expect(isPlausibleEmail(' me@example.com ')).toBe(true);
    expect(isPlausibleEmail('me@example')).toBe(false);
    expect(isPlausibleEmail('me example@x.co')).toBe(false);
    expect(isPlausibleEmail(`${'a'.repeat(250)}@x.co`)).toBe(false);
  });

  it('normalises case and whitespace', () => {
    expect(normalizeEmail(' Me@Example.COM ')).toBe('me@example.com');
  });
});
