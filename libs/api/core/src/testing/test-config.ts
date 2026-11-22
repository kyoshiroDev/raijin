import { loadConfig, type AppConfig } from '../lib/config/app-config';

/** Configuration de test (valeurs factices, secrets fixes de 48 caractères, clé TOTP fixe). */
export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    COOKIE_SECRET: 'c'.repeat(48),
    IP_HASH_SECRET: 'i'.repeat(48),
    // Clé TOTP factice fixe (32 octets) : la 2FA admin se déchiffre d'un test à l'autre.
    TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    ...env,
  });
}
