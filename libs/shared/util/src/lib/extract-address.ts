import { isSolanaAddress } from './base58';
import { parseUrlLike, type ParsedUrlLike } from './external-url';

/** Longueur maximale de la saisie d'analyse (adresse ou lien collé). */
export const ANALYSIS_INPUT_MAX_LENGTH = 256;

/** Origine de l'adresse extraite. */
export type AddressInputSource = 'raw' | 'dexscreener' | 'pumpfun' | 'solscan' | 'birdeye';

/**
 * Nature probable de l'adresse :
 * - `mint` : la source désigne explicitement un token (pump.fun, page « token » de Solscan ou
 *   Birdeye) ou une adresse brute (supposée être un mint, vérifiée par l'API) ;
 * - `pair_or_mint` : la source accepte indifféremment une paire et un token (DexScreener,
 *   page « account » de Solscan) ; l'API résout la paire vers son token de base.
 */
export type ExtractedAddressKind = 'mint' | 'pair_or_mint';

export interface ExtractedAddress {
  readonly address: string;
  readonly source: AddressInputSource;
  readonly kind: ExtractedAddressKind;
}

function valid(candidate: string | undefined): candidate is string {
  return candidate !== undefined && isSolanaAddress(candidate);
}

function fromUrl(url: ParsedUrlLike): ExtractedAddress | null {
  if (url.scheme !== null && url.scheme !== 'https' && url.scheme !== 'http') {
    return null;
  }
  const [first, second, third] = url.segments;
  switch (url.host) {
    case 'dexscreener.com':
      return first === 'solana' && valid(second)
        ? { address: second, source: 'dexscreener', kind: 'pair_or_mint' }
        : null;
    case 'pump.fun': {
      const coinIndex = url.segments.indexOf('coin');
      const candidate = coinIndex === -1 ? (url.segments.length === 1 ? first : undefined) : url.segments[coinIndex + 1];
      return valid(candidate) ? { address: candidate, source: 'pumpfun', kind: 'mint' } : null;
    }
    case 'solscan.io': {
      const cluster = url.query['cluster'];
      if (cluster !== undefined && cluster !== 'mainnet' && cluster !== 'mainnet-beta') {
        return null;
      }
      if (first === 'token' && valid(second)) {
        return { address: second, source: 'solscan', kind: 'mint' };
      }
      return first === 'account' && valid(second)
        ? { address: second, source: 'solscan', kind: 'pair_or_mint' }
        : null;
    }
    case 'birdeye.so': {
      const chain = url.query['chain'];
      if (first === 'token' && valid(second) && (chain === undefined || chain === 'solana')) {
        return { address: second, source: 'birdeye', kind: 'mint' };
      }
      return first === 'solana' && second === 'token' && valid(third)
        ? { address: third, source: 'birdeye', kind: 'mint' }
        : null;
    }
    default:
      return null;
  }
}

/**
 * Extrait une adresse Solana d'une saisie libre : adresse brute, ou lien DexScreener, pump.fun,
 * Solscan ou Birdeye (avec ou sans `https://`, `www.`, paramètres). Si la saisie contient
 * plusieurs mots (« regarde https://… »), le premier mot reconnu l'emporte.
 * Fonction pure : aucune requête réseau, aucun lien n'est suivi.
 */
export function extractSolanaAddress(input: string): ExtractedAddress | null {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > ANALYSIS_INPUT_MAX_LENGTH) {
    return null;
  }
  for (const word of trimmed.split(/\s+/)) {
    if (isSolanaAddress(word)) {
      return { address: word, source: 'raw', kind: 'mint' };
    }
    const url = parseUrlLike(word);
    const extracted = url ? fromUrl(url) : null;
    if (extracted) {
      return extracted;
    }
  }
  return null;
}
