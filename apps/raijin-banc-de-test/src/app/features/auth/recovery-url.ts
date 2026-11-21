/**
 * True when Supabase redirected back with an error (expired / reused link…).
 * Errors can arrive in the query string or in the hash fragment.
 */
export function hasRecoveryError(search: string, hash: string): boolean {
  const query = new URLSearchParams(search.replace(/^\?/, ''));
  const fragment = new URLSearchParams(hash.replace(/^#/, ''));
  return [query, fragment].some(
    (params) => params.has('error') || params.has('error_code') || params.has('error_description'),
  );
}
