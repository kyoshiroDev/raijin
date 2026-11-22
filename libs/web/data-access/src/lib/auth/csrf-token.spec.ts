import { csrfTokenSchema } from '@raijin/shared-contracts';
import { CSRF_TOKEN_PATTERN, parseCsrfResponse } from './csrf-token';

describe('parseCsrfResponse (sans Zod)', () => {
  const valid = 'csrf-anonymous-token-0123456789abcdef';

  it('lit un jeton conforme au contrat', () => {
    expect(parseCsrfResponse({ csrfToken: valid })).toBe(valid);
  });

  it('rejette une réponse hors contrat', () => {
    for (const body of [null, 'x', {}, { csrfToken: 42 }, { csrfToken: 'court' }, { csrfToken: `${'a'.repeat(40)}<script>` }]) {
      expect(() => parseCsrfResponse(body)).toThrow();
    }
  });

  it('suit exactement le format de csrfTokenSchema', () => {
    const samples = [valid, 'a'.repeat(31), 'a'.repeat(32), 'a'.repeat(256), 'a'.repeat(257), `${'a'.repeat(32)} `, `${'A_b.c-9'.repeat(6)}`, `${'a'.repeat(32)}é`];
    for (const sample of samples) {
      expect(CSRF_TOKEN_PATTERN.test(sample), sample).toBe(csrfTokenSchema.safeParse(sample).success);
    }
  });
});
