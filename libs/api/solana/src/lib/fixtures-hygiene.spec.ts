import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { FIXTURES_DIR, fixtureFiles, type Fixture } from './testing/fixture-fetch';

/** ARCHITECTURE.md §9.9 : aucune clé, aucune URL complète d'endpoint, aucun en-tête dans les fixtures. */
describe('hygiène des fixtures', () => {
  const files = fixtureFiles();

  it('au moins un scénario par source', () => {
    const sources = new Set(files.map((file) => relative(FIXTURES_DIR, file).split('/')[0]));
    expect([...sources].sort()).toEqual(['dexscreener', 'geckoterminal', 'helius', 'jupiter', 'rugcheck', 'solana-rpc']);
  });

  it.each(files.map((file) => [relative(FIXTURES_DIR, file), file]))('%s : format et absence de secret', (_name, file) => {
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toMatch(/api-key/i);
    expect(raw).not.toMatch(/helius-rpc\.com\/?\?/i);
    expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    // Aucune URL d'endpoint appelé (les URL présentes dans les corps sont des données externes, jamais suivies).
    expect(raw).not.toMatch(
      /https?:\/\/(?:api\.dexscreener\.com|api\.geckoterminal\.com|(?:lite-)?api\.jup\.ag|api\.rugcheck\.xyz\/v1|mainnet\.helius-rpc\.com|api\.mainnet-beta\.solana\.com)/i,
    );

    const fixture = JSON.parse(raw) as Fixture & Record<string, unknown>;
    expect(Object.keys(fixture).sort()).toEqual(
      expect.arrayContaining(['body', 'recordedAt', 'request', 'source', 'status']),
    );
    expect(fixture).not.toHaveProperty('headers');
    expect(fixture).not.toHaveProperty('url');
    expect(fixture.request).not.toHaveProperty('headers');
    expect(fixture.request).not.toHaveProperty('url');
    expect(fixture.request.path === undefined || fixture.request.path.startsWith('/')).toBe(true);
    expect(Number.isNaN(Date.parse(fixture.recordedAt))).toBe(false);
  });
});
