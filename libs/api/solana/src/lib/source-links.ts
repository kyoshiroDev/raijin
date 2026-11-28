import { DATA_SOURCE_NAMES, dataSourceRefSchema, type DataSourceId, type DataSourceRef } from '@raijin/shared-contracts';

/**
 * Liens vers les pages **publiques** des sources, construits par Raijin à partir de gabarits fixes
 * (jamais une URL fournie par une source, jamais un endpoint d'API) et validés par le contrat
 * (`https` + `EXTERNAL_LINK_HOSTS`).
 */
const TEMPLATES: Readonly<Record<DataSourceId, (mint: string) => string>> = {
  helius: (mint) => `https://solscan.io/token/${mint}`,
  solana_rpc: (mint) => `https://explorer.solana.com/address/${mint}`,
  dexscreener: (mint) => `https://dexscreener.com/solana/${mint}`,
  geckoterminal: (mint) => `https://www.geckoterminal.com/solana/tokens/${mint}`,
  jupiter: (mint) => `https://jup.ag/tokens/${mint}`,
  rugcheck: (mint) => `https://rugcheck.xyz/tokens/${mint}`,
};

export function sourceRef(id: DataSourceId, mint: string): DataSourceRef {
  const parsed = dataSourceRefSchema.safeParse({ id, name: DATA_SOURCE_NAMES[id], url: TEMPLATES[id](encodeURIComponent(mint)) });
  /* istanbul ignore next -- gabarits fixes sur des hôtes autorisés : le repli n'arrive qu'en cas de régression. */
  return parsed.success ? parsed.data : { id, name: DATA_SOURCE_NAMES[id], url: null };
}
