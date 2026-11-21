import type { SupabaseClient } from '@supabase/supabase-js';
import { TOKEN_COLUMNS, parseTokenRow, type TokenRow } from '../../shared/models/token';
import { isSolanaAddress } from '../../shared/utils/solana-address';

/** Loads one token by mint (RLS: authenticated read). Never queries with an invalid mint. */
export async function fetchTokenByMint(supabase: SupabaseClient, mint: string, signal?: AbortSignal): Promise<TokenRow | null> {
  if (!isSolanaAddress(mint)) return null;
  let query = supabase.from('tokens').select(TOKEN_COLUMNS).eq('mint', mint);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error('token query failed');
  return parseTokenRow(data);
}
