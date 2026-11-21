/**
 * Front mirror of Supabase Auth (GoTrue) password checks. Must stay STRICTLY identical to
 * `supabase/config.toml` (a spec asserts it):
 *   minimum_password_length = 12
 *   password_requirements   = "lower_upper_letters_digits_symbols"
 *
 * GoTrue (internal/api/password.go, checkPasswordStrength):
 *   - `len(password) > 72` → rejected: the maximum is counted in UTF-8 BYTES (bcrypt limit);
 *   - `utf8.RuneCountInString(password) < MinLength` → rejected: the minimum is counted in
 *     Unicode code points;
 *   - every required character set must match at least once (`strings.ContainsAny`).
 * The sets come from the Supabase CLI / Management API mapping of
 * "lower_upper_letters_digits_symbols": ASCII a-z, ASCII A-Z, ASCII 0-9 and the fixed
 * symbol list below. Accented letters, €, spaces… never satisfy a class.
 */
export const PASSWORD_MIN_LENGTH = 12;
/** Maximum in UTF-8 bytes (bcrypt): "é" counts 2, "€" counts 3. */
export const PASSWORD_MAX_BYTES = 72;
export const PASSWORD_REQUIREMENTS = 'lower_upper_letters_digits_symbols';

export const PASSWORD_LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
export const PASSWORD_UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const PASSWORD_DIGITS = '0123456789';
/** Exactly GoTrue's symbol set (32 ASCII punctuation characters, no space). */
export const PASSWORD_SYMBOLS = '!@#$%^&*()_+-=[]{};\'\\:"|<>?,./`~';

export type PasswordRuleId = 'length' | 'uppercase' | 'lowercase' | 'digit' | 'symbol' | 'match';

export interface PasswordRuleResult {
  readonly id: PasswordRuleId;
  readonly label: string;
  readonly ok: boolean;
}

const encoder = new TextEncoder();

/** Length as GoTrue's `utf8.RuneCountInString` (code points). */
export function passwordCodePoints(password: string): number {
  return Array.from(password).length;
}

/** Length as GoTrue's `len()` (UTF-8 bytes). */
export function passwordBytes(password: string): number {
  return encoder.encode(password).length;
}

/** GoTrue's `strings.ContainsAny`. */
function containsAny(password: string, charset: string): boolean {
  for (const char of password) {
    if (charset.includes(char)) return true;
  }
  return false;
}

export function isPasswordTooLong(password: string): boolean {
  return passwordBytes(password) > PASSWORD_MAX_BYTES;
}

/** Live checklist for a new password and its confirmation. */
export function evaluatePassword(password: string, confirmation: string): PasswordRuleResult[] {
  return [
    {
      id: 'length',
      label: `Au moins ${PASSWORD_MIN_LENGTH} caractères`,
      ok: passwordCodePoints(password) >= PASSWORD_MIN_LENGTH,
    },
    { id: 'uppercase', label: 'Une majuscule sans accent (A-Z)', ok: containsAny(password, PASSWORD_UPPERCASE) },
    { id: 'lowercase', label: 'Une minuscule sans accent (a-z)', ok: containsAny(password, PASSWORD_LOWERCASE) },
    { id: 'digit', label: 'Un chiffre (0-9)', ok: containsAny(password, PASSWORD_DIGITS) },
    { id: 'symbol', label: `Un symbole parmi ${PASSWORD_SYMBOLS}`, ok: containsAny(password, PASSWORD_SYMBOLS) },
    { id: 'match', label: 'Les deux mots de passe sont identiques', ok: password.length > 0 && password === confirmation },
  ];
}

export function isPasswordAcceptable(password: string, confirmation: string): boolean {
  return !isPasswordTooLong(password) && evaluatePassword(password, confirmation).every((rule) => rule.ok);
}
