/** Alphabet base58 de Bitcoin/Solana (sans 0, O, I, l). */
export const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const BASE58_MAP: ReadonlyMap<string, number> = new Map(
  [...BASE58_ALPHABET].map((char, index) => [char, index]),
);

/** Longueurs admises pour une adresse Solana encodée (clé publique de 32 octets). */
export const SOLANA_ADDRESS_MIN_LENGTH = 32;
export const SOLANA_ADDRESS_MAX_LENGTH = 44;

/** Vrai si la chaîne n'est composée que de caractères base58. */
export function isBase58(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  for (const char of value) {
    if (!BASE58_MAP.has(char)) {
      return false;
    }
  }
  return true;
}

/**
 * Décode une chaîne base58 en octets. Renvoie `null` si un caractère est invalide.
 * Implémentation pure (sans Buffer ni dépendance Node), utilisable côté web.
 */
export function decodeBase58(value: string): Uint8Array | null {
  if (!isBase58(value)) {
    return null;
  }
  const bytes: number[] = [];
  for (const char of value) {
    let carry = BASE58_MAP.get(char) ?? 0;
    for (let i = 0; i < bytes.length; i++) {
      carry += (bytes[i] ?? 0) * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of value) {
    if (char !== '1') {
      break;
    }
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

/**
 * Vrai si la chaîne est une adresse Solana plausible : base58, 32 à 44 caractères,
 * et décodage en exactement 32 octets.
 */
export function isSolanaAddress(value: string): boolean {
  if (
    value.length < SOLANA_ADDRESS_MIN_LENGTH ||
    value.length > SOLANA_ADDRESS_MAX_LENGTH
  ) {
    return false;
  }
  return decodeBase58(value)?.length === 32;
}
