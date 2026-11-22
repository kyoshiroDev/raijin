import { URL_MAX_LENGTH, isAllowedHttpsUrl, isHostAllowed, parseUrlLike } from './external-url';

const HOSTS = ['dexscreener.com', 'rugcheck.xyz'] as const;

describe('parseUrlLike', () => {
  it('découpe schéma, hôte, segments et requête', () => {
    expect(parseUrlLike('HTTPS://WWW.Example.com/a//b/?x=1&y&x=2#h')).toEqual({
      scheme: 'https',
      host: 'example.com',
      segments: ['a', 'b'],
      query: { x: '1', y: '' },
    });
  });

  it('accepte une URL sans schéma', () => {
    expect(parseUrlLike('example.com')).toEqual({ scheme: null, host: 'example.com', segments: [], query: {} });
  });

  it.each([
    '',
    'a b.com',
    'https://ex\\ample.com',
    'https://user:pw@example.com/',
    'https://example.com:443/',
    'https://localhost/',
    'https://-bad.com/',
    'https:///path',
    `https://example.com/${'a'.repeat(URL_MAX_LENGTH)}`,
  ])('refuse %j', (value) => {
    expect(parseUrlLike(value)).toBeNull();
  });
});

describe('isAllowedHttpsUrl', () => {
  it('accepte https sur un domaine autorisé ou un sous-domaine', () => {
    expect(isAllowedHttpsUrl('https://dexscreener.com/solana/x', HOSTS)).toBe(true);
    expect(isAllowedHttpsUrl('https://api.rugcheck.xyz/v1', HOSTS)).toBe(true);
  });

  it.each([
    'http://dexscreener.com/',
    'dexscreener.com/solana',
    'javascript:alert(1)',
    'data:text/html,<script>',
    'https://dexscreener.com.evil.com/',
    'https://evildexscreener.com/',
    'https://evil.com/?u=https://dexscreener.com',
  ])('refuse %j', (value) => {
    expect(isAllowedHttpsUrl(value, HOSTS)).toBe(false);
  });

  it('compare les hôtes sans tenir compte de la casse', () => {
    expect(isHostAllowed('RugCheck.XYZ', HOSTS)).toBe(true);
    expect(isHostAllowed('xyz', HOSTS)).toBe(false);
  });
});
