import { base32Decode, base32Encode, generateTotpSecret, hotp, matchTotp, otpauthUri, totpAt, totpStep } from './totp';

const SHA1_KEY = Buffer.from('12345678901234567890', 'ascii');
const SHA256_KEY = Buffer.from('12345678901234567890123456789012', 'ascii');
const SHA512_KEY = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'ascii');
const at = (seconds: number) => new Date(seconds * 1000);

describe('HOTP (RFC 4226, annexe D)', () => {
  it.each([
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [3, '969429'],
    [4, '338314'],
    [5, '254676'],
    [6, '287922'],
    [7, '162583'],
    [8, '399871'],
    [9, '520489'],
  ])('compteur %i → %s', (counter, expected) => {
    expect(hotp(SHA1_KEY, counter)).toBe(expected);
  });
});

describe('TOTP (RFC 6238, annexe B, 8 chiffres)', () => {
  it.each([
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ])('T = %i s', (seconds, sha1, sha256, sha512) => {
    expect(totpAt(SHA1_KEY, at(seconds), 8, 'sha1')).toBe(sha1);
    expect(totpAt(SHA256_KEY, at(seconds), 8, 'sha256')).toBe(sha256);
    expect(totpAt(SHA512_KEY, at(seconds), 8, 'sha512')).toBe(sha512);
  });

  it('pas de 30 s', () => {
    expect(totpStep(at(59))).toBe(1);
    expect(totpStep(at(60))).toBe(2);
  });
});

describe('base32 (RFC 4648 §10, sans remplissage)', () => {
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('%j ↔ %s', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain))).toBe(encoded);
    expect(base32Decode(encoded).toString()).toBe(plain);
  });

  it('secret de 20 octets → 32 caractères, aller-retour, caractère invalide refusé', () => {
    const secret = generateTotpSecret();
    const encoded = base32Encode(secret);
    expect(encoded).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(encoded).equals(secret)).toBe(true);
    expect(base32Decode(`${encoded}====`).equals(secret)).toBe(true);
    expect(() => base32Decode('ABC1')).toThrow('BASE32_INVALID');
  });
});

describe('matchTotp', () => {
  const now = at(1_700_000_000);
  const step = totpStep(now);

  it('accepte le pas courant et ±1 (décalage d’horloge), refuse au-delà', () => {
    expect(matchTotp(SHA1_KEY, hotp(SHA1_KEY, step), now, null)).toBe(step);
    expect(matchTotp(SHA1_KEY, hotp(SHA1_KEY, step - 1), now, null)).toBe(step - 1);
    expect(matchTotp(SHA1_KEY, hotp(SHA1_KEY, step + 1), now, null)).toBe(step + 1);
    expect(matchTotp(SHA1_KEY, hotp(SHA1_KEY, step + 2), now, null)).toBeNull();
    expect(matchTotp(SHA1_KEY, hotp(SHA1_KEY, step - 2), now, null)).toBeNull();
  });

  it('rejeu refusé : pas ≤ dernier pas utilisé', () => {
    const code = hotp(SHA1_KEY, step);
    expect(matchTotp(SHA1_KEY, code, now, step)).toBeNull();
    expect(matchTotp(SHA1_KEY, code, now, step + 1)).toBeNull();
    expect(matchTotp(SHA1_KEY, code, now, step - 1)).toBe(step);
  });

  it('format invalide refusé', () => {
    expect(matchTotp(SHA1_KEY, '12345', now, null)).toBeNull();
    expect(matchTotp(SHA1_KEY, 'abcdef', now, null)).toBeNull();
  });
});

describe('otpauthUri', () => {
  it('URI Key Uri Format avec émetteur et compte encodés', () => {
    const uri = otpauthUri('Raijin Shield', 'jean+test@exemple.fr', 'JBSWY3DPEHPK3PXP');
    expect(uri.startsWith('otpauth://totp/Raijin%20Shield:jean%2Btest%40exemple.fr?')).toBe(true);
    const params = new URL(uri.replace('otpauth://', 'https://')).searchParams;
    expect(params.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(params.get('issuer')).toBe('Raijin Shield');
    expect(params.get('digits')).toBe('6');
    expect(params.get('period')).toBe('30');
    expect(params.get('algorithm')).toBe('SHA1');
  });
});
