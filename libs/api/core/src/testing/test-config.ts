import { loadConfig, type AppConfig } from '../lib/config/app-config';

/** Configuration de test (valeurs factices, secrets fixes de 48 caractères). */
export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    COOKIE_SECRET: 'c'.repeat(48),
    ...env,
  });
}
