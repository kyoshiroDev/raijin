/**
 * Sous-chemin `@raijin/api-solana/testing` : rejeu des fixtures sans réseau (tests, démonstration).
 * Hors de l'index principal : le code de production n'y accède que si l'hôte l'importe explicitement.
 */
export {
  FIXTURES_DIR,
  createFixtureFetch,
  fixtureFiles,
  loadAllFixtures,
  loadFixture,
  type Fixture,
  type FixtureFetch,
  type RecordedCall,
} from './lib/testing/fixture-fetch';
