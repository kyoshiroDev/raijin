import { describe, expect, it } from 'vitest';
import {
  evaluatePassword,
  isPasswordAcceptable,
  isPasswordTooLong,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REQUIREMENTS,
  PASSWORD_SYMBOLS,
  passwordBytes,
  passwordCodePoints,
  type PasswordRuleId,
} from './password-rules';

const STRONG = 'Tonnerre-2026!';

function rule(password: string, id: PasswordRuleId, confirmation = password): boolean {
  const found = evaluatePassword(password, confirmation).find((r) => r.id === id);
  if (!found) throw new Error(`rule ${id} missing`);
  return found.ok;
}

/**
 * Valeurs [auth] de legacy/supabase/config.toml, figées lors de l'import (phase 1 bis).
 * Le test lisait autrefois le fichier directement ; legacy/ étant hors projet Nx, l'import relatif est
 * interdit par @nx/enforce-module-boundaries. À resynchroniser si config.toml change ; caduc au
 * portage (phase 8 bis : auth propre au banc, argon2id + TOTP).
 */
const LEGACY_AUTH_CONFIG = {
  minimum_password_length: 12,
  password_requirements: 'lower_upper_letters_digits_symbols',
} as const;

describe('password rules', () => {
  describe('stay identical to legacy/supabase/config.toml (snapshot)', () => {
    it('minimum_password_length === PASSWORD_MIN_LENGTH', () => {
      expect(LEGACY_AUTH_CONFIG.minimum_password_length).toBe(PASSWORD_MIN_LENGTH);
    });

    it('password_requirements === PASSWORD_REQUIREMENTS', () => {
      expect(LEGACY_AUTH_CONFIG.password_requirements).toBe(PASSWORD_REQUIREMENTS);
    });
  });

  it("uses GoTrue's exact 32-symbol list", () => {
    expect(PASSWORD_SYMBOLS).toBe('!@#$%^&*()_+-=[]{};\'\\:"|<>?,./`~');
    expect(PASSWORD_SYMBOLS).toHaveLength(32);
  });

  it('requires at least 12 characters (code points, like utf8.RuneCountInString)', () => {
    expect(rule('Aa1!aaaaaaa', 'length')).toBe(false);
    expect(rule('Aa1!aaaaaaaa', 'length')).toBe(true);
    // 11 code points but 12+ bytes: still too short for GoTrue.
    expect(rule('Aa1!aaaaaaé', 'length')).toBe(false);
    expect(rule('Aa1!aaaaaaaé', 'length')).toBe(true);
    expect(passwordCodePoints('é€😀')).toBe(3);
  });

  it('requires an ASCII uppercase letter (É does not count)', () => {
    expect(rule('tonnerre-2026!', 'uppercase')).toBe(false);
    expect(rule('Éclair', 'uppercase')).toBe(false);
    expect(rule('éCLAIR', 'uppercase')).toBe(true);
  });

  it('requires an ASCII lowercase letter (é does not count)', () => {
    expect(rule('TONNERRE-2026!', 'lowercase')).toBe(false);
    expect(rule('TONNERRé', 'lowercase')).toBe(false);
    expect(rule('TONNERRe', 'lowercase')).toBe(true);
  });

  it('requires an ASCII digit (non-ASCII digits do not count)', () => {
    expect(rule('Tonnerre-Raijin!', 'digit')).toBe(false);
    expect(rule('Tonnerre٣', 'digit')).toBe(false);
    expect(rule('Tonnerre7', 'digit')).toBe(true);
  });

  it('requires a symbol from the GoTrue list (space, €, § and « do not count)', () => {
    for (const notSymbol of [' ', '€', '§', '«', '£', '¿', '\t']) {
      expect(rule(`Tonnerre2026${notSymbol}`, 'symbol'), JSON.stringify(notSymbol)).toBe(false);
    }
  });

  it('accepts every GoTrue symbol', () => {
    for (const symbol of PASSWORD_SYMBOLS) {
      expect(rule(`Tonnerre2026${symbol}`, 'symbol'), symbol).toBe(true);
      expect(isPasswordAcceptable(`Tonnerre2026${symbol}`, `Tonnerre2026${symbol}`), symbol).toBe(true);
    }
  });

  it('requires the confirmation to match', () => {
    expect(rule(STRONG, 'match', 'Tonnerre-2026?')).toBe(false);
    expect(rule(STRONG, 'match', STRONG)).toBe(true);
    expect(rule('', 'match', '')).toBe(false);
  });

  it('accepts a password only when every rule passes', () => {
    expect(isPasswordAcceptable(STRONG, STRONG)).toBe(true);
    expect(isPasswordAcceptable(STRONG, `${STRONG}x`)).toBe(false);
    expect(isPasswordAcceptable('tonnerre-2026!', 'tonnerre-2026!')).toBe(false);
    expect(isPasswordAcceptable('Éclair 2026 €', 'Éclair 2026 €')).toBe(false);
  });

  describe('maximum of 72 BYTES (len() / bcrypt)', () => {
    it('counts UTF-8 bytes', () => {
      expect(passwordBytes('a')).toBe(1);
      expect(passwordBytes('é')).toBe(2);
      expect(passwordBytes('€')).toBe(3);
      expect(passwordBytes('😀')).toBe(4);
    });

    it('accepts exactly 72 bytes and rejects 73', () => {
      const exact = `${STRONG}${'a'.repeat(PASSWORD_MAX_BYTES - STRONG.length)}`;
      expect(passwordBytes(exact)).toBe(72);
      expect(isPasswordTooLong(exact)).toBe(false);
      expect(isPasswordAcceptable(exact, exact)).toBe(true);
      const over = `${exact}a`;
      expect(isPasswordTooLong(over)).toBe(true);
      expect(isPasswordAcceptable(over, over)).toBe(false);
    });

    it('rejects 39 characters that weigh 74 bytes because of accents', () => {
      const accented = `Aa1!${'é'.repeat(35)}`; // 4 + 35 × 2 = 74 bytes
      expect(passwordCodePoints(accented)).toBe(39);
      expect(passwordBytes(accented)).toBe(74);
      expect(isPasswordAcceptable(accented, accented)).toBe(false);
    });
  });
});
