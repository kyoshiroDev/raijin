import {
  VERDICT_LABELS,
  apiErrorSchema,
  checkStatusSchema,
  mintAddressSchema,
  verdictSchema,
} from '../index';

describe('mintAddressSchema', () => {
  it('accepte une adresse de mint valide (espaces retirés)', () => {
    const result = mintAddressSchema.safeParse(
      '  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v ',
    );
    expect(result.success).toBe(true);
    expect(result.data).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  it('refuse une adresse invalide avec un message en français', () => {
    const result = mintAddressSchema.safeParse('pas-une-adresse');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Adresse Solana invalide.');
  });
});

describe('verdictSchema', () => {
  it('accepte safe, warn et danger uniquement', () => {
    expect(verdictSchema.options).toEqual(['safe', 'warn', 'danger']);
    expect(verdictSchema.safeParse('moon').success).toBe(false);
  });

  it('a un libellé pour chaque verdict', () => {
    expect(VERDICT_LABELS).toEqual({
      safe: 'Sain',
      warn: 'Prudence',
      danger: 'Danger',
    });
  });

  it('connaît le statut indisponible', () => {
    expect(checkStatusSchema.safeParse('unavailable').success).toBe(true);
  });
});

describe('apiErrorSchema', () => {
  it('valide le format {code, message}', () => {
    expect(
      apiErrorSchema.safeParse({ code: 'NOT_FOUND', message: 'Introuvable.' })
        .success,
    ).toBe(true);
  });

  it('refuse un code inconnu ou un message vide', () => {
    expect(
      apiErrorSchema.safeParse({ code: 'TEAPOT', message: 'x' }).success,
    ).toBe(false);
    expect(
      apiErrorSchema.safeParse({ code: 'NOT_FOUND', message: '' }).success,
    ).toBe(false);
  });
});
