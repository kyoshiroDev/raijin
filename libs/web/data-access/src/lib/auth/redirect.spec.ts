import { DEFAULT_AFTER_LOGIN, safeRedirect } from './redirect';

describe('safeRedirect (anti-redirection ouverte)', () => {
  it.each([
    '/compte',
    '/analyse?mint=So11111111111111111111111111111111111111112',
    '/suivis#liste',
  ])('accepte le chemin interne %s', (path) => {
    expect(safeRedirect(path)).toBe(path);
  });

  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    'evil.example/compte',
    '/%5Cevil.example',
    '/%2F%2Fevil.example',
    '/\tevil',
    '/%E0%A4%A',
    '',
    null,
    undefined,
    42,
  ])('refuse %s', (value) => {
    expect(safeRedirect(value)).toBe(DEFAULT_AFTER_LOGIN);
  });

  it('refuse un renvoi vers un écran d’auth (boucle)', () => {
    expect(safeRedirect('/compte/connexion?redirect=/compte')).toBe(DEFAULT_AFTER_LOGIN);
    expect(safeRedirect('/compte/inscription')).toBe(DEFAULT_AFTER_LOGIN);
    expect(safeRedirect('/compte/connexions-wallet')).toBe('/compte/connexions-wallet');
  });

  it('utilise la valeur de repli fournie', () => {
    expect(safeRedirect('//x', '/analyse')).toBe('/analyse');
  });
});
