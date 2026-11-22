/**
 * Sous-chemin `@raijin/api-solana/testing` : rejeu des fixtures sans réseau (tests, démonstration).
 * Hors de l'index principal : le code de production n'y accède que si l'hôte l'importe explicitement.
 */
export {
  FIXTURES_DIR,
  createFixtureFetch,
  createFixtureSequence,
  fixtureAddress,
  fixtureFiles,
  fixtureSequenceNames,
  loadAllFixtures,
  loadFixture,
  loadFixtureSequence,
  type Fixture,
  type FixtureFetch,
  type FixtureSequence,
  type RecordedCall,
} from './lib/testing/fixture-fetch';
export { WALLET_FIXTURE_ACCOUNTS, WALLET_FIXTURE_ADDRESSES } from './lib/testing/wallet-fixtures';
