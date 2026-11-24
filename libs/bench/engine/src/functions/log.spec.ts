import { engineLog } from './log';

describe('engineLog (journal des fonctions portées)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('masque clés et identifiants, retire les retours à la ligne, garde nombres et mints', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mint = 'So11111111111111111111111111111111111111112';
    engineLog.warn('enrich update', 'fetch https://api.helius.xyz/?api-key=abc123 failed\nBearer eyJhbGciOi.x', 3, mint, '');
    const [label, text, n, m, empty] = warn.mock.calls[0] as unknown[];
    expect(label).toBe('enrich update');
    expect(text).toBe('fetch https://api.helius.xyz/?api-key=*** failed Bearer ***');
    expect(n).toBe(3);
    expect(m).toBe(mint);
    expect(empty).toBe('');
  });

  it('erreur : message nettoyé, jamais la pile ; objet remplacé par son type', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    engineLog.error('scan failed', new TypeError('postgres://user:secret@db/x'), { password: 'p' });
    expect(error.mock.calls[0]).toEqual(['scan failed', 'TypeError: postgres://***@db/x', '[object]']);
  });
});
