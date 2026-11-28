-- Raijin — more candidate sources (feat/more-sources).
--
-- scan-tokens now also collects candidates from GeckoTerminal (trending pools, pools by 24 h volume), Jupiter
-- Tokens API v2 toplists (trending / organic score / traded, 1h and 6h) and pump.fun → PumpSwap/Raydium
-- migrations, on top of the DexScreener lists. Market-cap and liquidity filters are unchanged.
--
-- New columns
--   tokens.sources           : sources that brought the token in the LAST scan that kept it (allowlisted names,
--                              canonical order, <= 10). Written by scan-tokens only (upsert payload).
--   scan_runs.source_counts  : per source { seen, kept, unique, uniqueKept } for the run (bounded jsonb object).
--   scan_runs.sol_usd        : SOL price (USD) at scan time, Jupiter (same request as the SOL 24 h change).
--   scan_runs.eur_usd        : EUR/USD at scan time = Jupiter price of EURC (HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr).
-- Changed default
--   alert_settings.stake_sol : 0.1 -> 0.05 for FUTURE rows only. Existing rows are NOT updated.
--
-- Security
--   No new table, no new function, no policy change. RLS stays enabled on tokens, scan_runs, alert_settings:
--   tokens / scan_runs = SELECT for authenticated (writes are service_role only, no insert/update/delete policy),
--   alert_settings = owner-only CRUD. New columns inherit the table-level grants (authenticated SELECT on
--   tokens/scan_runs); anon has nothing. Adding a source name later requires a new migration (CHECK allowlist).
-- Upper bounds also reject 'Infinity' / 'NaN' (numeric accepts both).

-- ---------------------------------------------------------------------------
-- tokens.sources
-- ---------------------------------------------------------------------------
-- Constant default: no table rewrite (Postgres >= 11).
alter table public.tokens
  add column sources text[] not null default '{}'
    constraint tokens_sources_check check (
      cardinality(sources) <= 10
      and array_position(sources, null) is null
      and sources <@ array[
        'dex_profiles', 'dex_boosts_latest', 'dex_boosts_top', 'dex_cto', 'dex_search',
        'gecko_trending', 'gecko_volume',
        'jup_trending_1h', 'jup_trending_6h', 'jup_organic_1h', 'jup_organic_6h', 'jup_traded_1h', 'jup_traded_6h',
        'migration'
      ]::text[]
    );

comment on column public.tokens.sources is
  'Candidate sources that brought the token in the last scan that kept it (allowlist, <= 10, written by scan-tokens).';

-- The front may filter on a source (e.g. migrations only).
create index tokens_sources_idx on public.tokens using gin (sources);

-- ---------------------------------------------------------------------------
-- scan_runs: per-source counters and market context
-- ---------------------------------------------------------------------------
alter table public.scan_runs
  add column source_counts jsonb
    constraint scan_runs_source_counts_check check (
      source_counts is null
      or (jsonb_typeof(source_counts) = 'object' and octet_length(source_counts::text) <= 8192)
    ),
  add column sol_usd numeric
    constraint scan_runs_sol_usd_check check (sol_usd is null or (sol_usd > 0 and sol_usd < 100000)),
  add column eur_usd numeric
    constraint scan_runs_eur_usd_check check (eur_usd is null or (eur_usd > 0.5 and eur_usd < 2));

comment on column public.scan_runs.source_counts is
  'Per source: { seen, kept, unique, uniqueKept } (mints brought by the source / kept by the filters / brought only by it).';
comment on column public.scan_runs.sol_usd is 'SOL price in USD at scan time (Jupiter), null when unavailable.';
comment on column public.scan_runs.eur_usd is 'EUR/USD at scan time (Jupiter price of EURC), null when unavailable.';

-- ---------------------------------------------------------------------------
-- alert_settings: stake default for future rows (existing rows untouched on purpose)
-- ---------------------------------------------------------------------------
alter table public.alert_settings
  alter column stake_sol set default 0.05;
