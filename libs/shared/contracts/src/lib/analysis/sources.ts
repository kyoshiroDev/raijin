import { isAllowedHttpsUrl } from '@raijin/shared-util';
import { z } from 'zod';

/** Sources de données de l'analyse. `solana_rpc` = RPC public, utilisé tant que la clé Helius manque. */
export const DATA_SOURCE_IDS = [
  'helius',
  'solana_rpc',
  'dexscreener',
  'geckoterminal',
  'jupiter',
  'rugcheck',
] as const;

export const dataSourceIdSchema = z.enum(DATA_SOURCE_IDS);
export type DataSourceId = z.infer<typeof dataSourceIdSchema>;

/** Noms affichés des sources. */
export const DATA_SOURCE_NAMES: Readonly<Record<DataSourceId, string>> = {
  helius: 'Helius',
  solana_rpc: 'RPC Solana public',
  dexscreener: 'DexScreener',
  geckoterminal: 'GeckoTerminal',
  jupiter: 'Jupiter',
  rugcheck: 'RugCheck',
};

/**
 * Domaines autorisés pour tout lien externe affiché (PROMPT.md §8). Un lien de source pointe
 * vers une **page publique lisible par l'utilisateur** (ex. `https://dexscreener.com/solana/<mint>`),
 * jamais vers un endpoint d'API (dont l'URL peut contenir une clé).
 */
export const EXTERNAL_LINK_HOSTS = [
  'dexscreener.com',
  'geckoterminal.com',
  'jup.ag',
  'rugcheck.xyz',
  'solscan.io',
  'explorer.solana.com',
  'pump.fun',
  'birdeye.so',
] as const;

/** URL externe : `https://` uniquement, hôte dans `EXTERNAL_LINK_HOSTS` (sous-domaines compris). */
export const externalUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => isAllowedHttpsUrl(value, EXTERNAL_LINK_HOSTS), {
    message: 'Lien externe non autorisé.',
  });

/** Source citée par un contrôle : nom affiché et lien vers la page publique (ou `null`). */
export const dataSourceRefSchema = z.object({
  id: dataSourceIdSchema,
  name: z.string().min(1).max(40),
  url: externalUrlSchema.nullable(),
});
export type DataSourceRef = z.infer<typeof dataSourceRefSchema>;
