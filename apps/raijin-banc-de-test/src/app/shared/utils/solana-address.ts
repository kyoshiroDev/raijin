// Keep identical to the legacy Edge Functions _shared/solana.ts and the bench API (same tests on both sides).

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

export function base58Decode(input: string): Uint8Array | null {
  if (input.length === 0) return null;
  const bytes: number[] = [];
  for (const ch of input) {
    const value = INDEX.get(ch);
    if (value === undefined) return null;
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of input) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

/** A Solana public key is base58 and decodes to exactly 32 bytes. */
export function isSolanaAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length < 32 || value.length > 44) return false;
  const decoded = base58Decode(value);
  return decoded !== null && decoded.length === 32;
}

export function addressHead(address: string, n = 4): string {
  return address.slice(0, n);
}

export function addressTail(address: string, n = 4): string {
  return address.slice(-n);
}

export function shortAddress(address: string): string {
  return address.length > 10 ? `${addressHead(address)}…${addressTail(address)}` : address;
}
