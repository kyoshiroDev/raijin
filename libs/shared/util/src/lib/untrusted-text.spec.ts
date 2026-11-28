import { sanitizeUntrustedText } from './untrusted-text';

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

describe('sanitizeUntrustedText', () => {
  it('laisse intact un texte propre', () => {
    expect(sanitizeUntrustedText('Bonk', 32)).toBe('Bonk');
  });

  it('retire les contrôles bidirectionnels et les caractères invisibles', () => {
    const hostile = `US${cp(0x200b)}DC${cp(0x202e, 0x2066, 0xfeff, 0x00ad, 0x3164)}`;
    expect(sanitizeUntrustedText(hostile, 32)).toBe('USDC');
  });

  it('remplace les contrôles par une espace et réduit les espaces', () => {
    expect(sanitizeUntrustedText(`  a${cp(0x00)}${cp(0x0a)}${cp(0x09)}b${cp(0x85)}c `, 32)).toBe('a b c');
  });

  it('ne fait pas d’échappement HTML (réservé à l’affichage)', () => {
    expect(sanitizeUntrustedText('<img src=x onerror=alert(1)>', 64)).toBe('<img src=x onerror=alert(1)>');
  });

  it('tronque en points de code avec une ellipse', () => {
    const rocket = cp(0x1f680);
    expect(sanitizeUntrustedText('abcdefgh', 5)).toBe(`abcd${cp(0x2026)}`);
    expect(sanitizeUntrustedText(rocket.repeat(4), 3)).toBe(`${rocket}${rocket}${cp(0x2026)}`);
    expect(sanitizeUntrustedText('abc', 3)).toBe('abc');
    expect(sanitizeUntrustedText('ab cdef', 4)).toBe(`ab${cp(0x2026)}`);
  });

  it('normalise en NFC', () => {
    expect(sanitizeUntrustedText(`e${cp(0x0301)}`, 8)).toBe(cp(0x00e9));
  });

  it('renvoie une chaîne vide pour une valeur non textuelle ou une longueur invalide', () => {
    expect(sanitizeUntrustedText(42, 8)).toBe('');
    expect(sanitizeUntrustedText(null, 8)).toBe('');
    expect(sanitizeUntrustedText('abc', 0)).toBe('');
  });
});
