import { isSolanaAddress } from '@raijin/shared-util';
import { z } from 'zod';

/** Adresse Solana (clé publique base58, 32 à 44 caractères, 32 octets décodés). */
export const solanaAddressSchema = z
  .string()
  .trim()
  .refine(isSolanaAddress, { message: 'Adresse Solana invalide.' });

/** Adresse de mint d'un token SPL. */
export const mintAddressSchema = solanaAddressSchema;

/** Adresse publique d'un wallet (scan en lecture seule, aucune signature). */
export const walletAddressSchema = solanaAddressSchema;

export type SolanaAddress = z.infer<typeof solanaAddressSchema>;
export type MintAddress = z.infer<typeof mintAddressSchema>;
export type WalletAddress = z.infer<typeof walletAddressSchema>;
