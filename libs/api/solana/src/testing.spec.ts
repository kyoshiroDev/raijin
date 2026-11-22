import * as main from './index';
import { FIXTURES_DIR, createFixtureFetch, loadAllFixtures } from './testing';

describe('sous-chemin @raijin/api-solana/testing', () => {
  it('expose le rejeu des fixtures, absent de l’index principal', async () => {
    expect(Object.keys(main)).not.toContain('createFixtureFetch');
    const fixtures = loadAllFixtures(FIXTURES_DIR);
    expect(fixtures.length).toBeGreaterThan(30);
    const { fetch, calls } = createFixtureFetch(fixtures);
    const response = await fetch('https://api.dexscreener.com/token-pairs/v1/solana/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ source: 'dexscreener', route: '/token-pairs/v1/solana/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' }]);
  });
});
