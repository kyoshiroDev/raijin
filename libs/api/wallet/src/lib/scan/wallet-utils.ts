import { hmac } from '@raijin/api-core';
import type { TokenAmount } from '@raijin/shared-contracts';

/**
 * Empreinte HMAC-SHA-256 (tronquée) d'une adresse de wallet : seule forme sous laquelle l'adresse
 * apparaît dans une clé Redis (cache, verrou, anti-double-comptage du quota). Jamais en base.
 */
export function walletKey(secret: string, address: string): string {
  return hmac(secret, `wallet:${address}`).slice(0, 32);
}

const U64_MAX = (1n << 64n) - 1n;

/** Normalise un montant brut (chaîne décimale u64) ; hors bornes ou mal formé → `"0"`. */
export function normalizeRaw(raw: string): string {
  if (!/^\d{1,20}$/.test(raw)) return '0';
  const value = BigInt(raw);
  return value > U64_MAX ? U64_MAX.toString() : value.toString();
}

/** Montant contractuel : brut + décimal exact (`raw / 10^decimals`, sans zéros superflus). */
export function tokenAmount(raw: string, decimals: number): TokenAmount {
  const normalized = normalizeRaw(raw);
  const safeDecimals = Math.min(255, Math.max(0, Math.trunc(decimals)));
  if (safeDecimals === 0) return { raw: normalized, decimals: 0, ui: normalized };
  const padded = normalized.padStart(safeDecimals + 1, '0');
  const whole = padded.slice(0, padded.length - safeDecimals);
  const fraction = padded.slice(padded.length - safeDecimals).replace(/0+$/, '');
  return { raw: normalized, decimals: safeDecimals, ui: fraction ? `${whole}.${fraction}` : whole };
}

/** `a ≥ b` sur des montants bruts u64. */
export function rawGte(a: string, b: string): boolean {
  return BigInt(normalizeRaw(a)) >= BigInt(normalizeRaw(b));
}

/** Tranche du nombre de tokens pour l'événement produit (jamais le nombre exact ni les mints). */
export function tokenCountBucket(count: number): '0' | '1-5' | '6-20' | '21-100' | '>100' {
  if (count <= 0) return '0';
  if (count <= 5) return '1-5';
  if (count <= 20) return '6-20';
  if (count <= 100) return '21-100';
  return '>100';
}
