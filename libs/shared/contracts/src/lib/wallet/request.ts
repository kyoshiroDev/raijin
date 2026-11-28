import * as z from '../zod';
import { walletAddressSchema } from '../address';

/**
 * Adresses connues qui ne sont **pas** des wallets : programmes système et mints très courants.
 * Refus immédiat (front et API) sans appel réseau ; l'API complète par la lecture du compte
 * (`getAccountInfo` : programme exécutable, mint, compte de token → refus, 1 crédit).
 */
export const KNOWN_NON_WALLET_ADDRESSES: Readonly<Record<string, 'program' | 'mint'>> = {
  '11111111111111111111111111111111': 'program', // System Program
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'program', // SPL Token
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'program', // Token-2022
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'program', // Associated Token Account
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: 'program', // Metaplex Token Metadata
  ComputeBudget111111111111111111111111111111: 'program',
  BPFLoaderUpgradeab1e11111111111111111111111: 'program',
  Stake11111111111111111111111111111111111111: 'program',
  Vote111111111111111111111111111111111111111: 'program',
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'program', // Jupiter v6
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'program', // Raydium AMM v4
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'program', // pump.fun
  So11111111111111111111111111111111111111112: 'mint', // SOL enveloppé
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'mint', // USDC
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'mint', // USDT
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'mint', // BONK
};

/** Nature connue d'une adresse qui n'est pas un wallet, sinon `null`. */
export function knownNonWalletKind(address: string): 'program' | 'mint' | null {
  return Object.hasOwn(KNOWN_NON_WALLET_ADDRESSES, address) ? (KNOWN_NON_WALLET_ADDRESSES[address] ?? null) : null;
}

/**
 * Corps de `POST /api/v1/wallet-scans` : adresse **publique** d'un wallet. Aucune connexion de
 * wallet, aucune signature, aucune clé privée ni phrase de récupération ne transitent jamais.
 * Une adresse connue de programme ou de mint est refusée (`WALLET_INVALID` / `WALLET_IS_TOKEN`
 * côté API) ; le message Zod sert seulement à l'aperçu immédiat du formulaire.
 */
export const walletScanRequestSchema = z
  .object({
    address: walletAddressSchema.refine((address) => knownNonWalletKind(address) === null, {
      message: 'Cette adresse n’est pas un wallet.',
    }),
  })
  .strict();
export type WalletScanRequest = z.infer<typeof walletScanRequestSchema>;
