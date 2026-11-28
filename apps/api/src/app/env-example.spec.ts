import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadBillingConfig } from '@raijin/api-billing';
import { loadConfig, withoutEmptyEnv } from '@raijin/api-core';

/**
 * Démarrage en dev avec un `.env` copié de `.env.example` (valeurs factices, variables laissées vides = « défaut ») :
 * modèle lu dans le premier bloc `dotenv` de docs/ENV.md (miroir de `.env.example`, jamais le `.env` réel).
 * Régression : `NOM=` était converti en `0` par `z.coerce.number()` (« RATE_LIMIT_AUTH_PER_MINUTE : Too small »).
 */
function envExample(): Record<string, string> {
  const doc = readFileSync(resolve(__dirname, '../../../../docs/ENV.md'), 'utf8');
  const block = /```dotenv\n([\s\S]*?)```/.exec(doc)?.[1];
  if (!block) throw new Error('bloc dotenv introuvable dans docs/ENV.md');
  const env: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1]) env[match[1]] = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

describe('configuration chargée depuis le modèle .env.example (dev)', () => {
  const example = envExample();

  it('le modèle contient des variables vides (cas à couvrir)', () => {
    expect(example['RATE_LIMIT_AUTH_PER_MINUTE']).toBe('');
    expect(Object.keys(example).length).toBeGreaterThan(50);
  });

  it('valeurs du modèle : configuration API et facturation valides, défauts appliqués aux variables vides', () => {
    const env = { ...example, NODE_ENV: 'development' };
    const config = loadConfig(env);
    expect(config.env).toBe('development');
    expect(config.rateLimit.authPerMinute).toBeGreaterThanOrEqual(1);
    expect(config.rateLimit.analysisPerMinute).toBeGreaterThanOrEqual(1);
    expect(config.rateLimit.walletScanPerMinute).toBeGreaterThanOrEqual(1);
    expect(() => loadBillingConfig(env, config)).not.toThrow();
  });

  it('toutes les variables vides (ou espaces) : identique à un environnement sans ces variables', () => {
    const empty = Object.fromEntries(Object.keys(example).map((key) => [key, key === 'NODE_ENV' ? 'development' : ' ']));
    const config = loadConfig(empty);
    const absent = loadConfig({ NODE_ENV: 'development' });
    expect(config.rateLimit).toEqual(absent.rateLimit);
    expect(config.port).toBe(absent.port);
    expect(config.wallet).toEqual(absent.wallet);
    expect(() => loadBillingConfig(empty, config)).not.toThrow();
  });

  it('withoutEmptyEnv : retire les valeurs vides ou blanches, garde les autres telles quelles', () => {
    expect(withoutEmptyEnv({ A: '', B: '  ', C: ' 5 ', D: undefined, E: '0' })).toEqual({ C: ' 5 ', E: '0' });
  });
});
