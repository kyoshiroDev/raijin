-- fix/young-sources — three new candidate source names in the tokens.sources allowlist (CHECK).
--   'gecko_trending_1h' : GeckoTerminal trending pools over 1 h (pools younger than 24 h only, ≤ 2 pages, 2 scans / 3).
--   'gecko_pumpswap'    : GeckoTerminal PumpSwap pools by 24 h tx count (pools younger than 24 h only, 1 page, 2 scans / 3).
--   'young_watch'       : tokens persisted with a pair younger than 24 h and kept in the last 10 min, re-fetched by every
--                         scan (DexScreener only) until they age out or fail the scan filters.
-- scan-tokens degrades gracefully without this migration (its upsert retries with the 14 legacy names), but the new
-- names are then missing from tokens.sources: apply it BEFORE deploying the function.
--
-- Security: no new table, column, policy or grant. RLS unchanged (tokens: SELECT for authenticated, writes
-- service_role only). The constraint is re-created with the same bounds (≤ 10 entries, no null, allowlist).
-- Existing rows only hold legacy names (subset of the new list): the validation cannot fail. public.tokens is small
-- (a few thousand rows), the lock lasts milliseconds; apply between two scans (the scan runs at even minutes).

alter table public.tokens drop constraint if exists tokens_sources_check;

alter table public.tokens
  add constraint tokens_sources_check check (
    cardinality(sources) <= 10
    and array_position(sources, null) is null
    and sources <@ array[
      'dex_profiles', 'dex_boosts_latest', 'dex_boosts_top', 'dex_cto', 'dex_search',
      'gecko_trending', 'gecko_volume', 'gecko_trending_1h', 'gecko_pumpswap',
      'jup_trending_1h', 'jup_trending_6h', 'jup_organic_1h', 'jup_organic_6h', 'jup_traded_1h', 'jup_traded_6h',
      'migration', 'young_watch'
    ]::text[]
  );
