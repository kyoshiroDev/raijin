-- Raijin — prudent liquidity: Jupiter's liquidity next to DexScreener's.
-- liquidity_usd stays the DexScreener value (best pair). liquidity_jup_usd = Jupiter tokens v2 `liquidity` (USD),
-- null when Jupiter was not queried or gave no usable value (missing, 0, non-finite).
-- The score uses min(liquidity_usd, liquidity_jup_usd) (docs/ARCHITECTURE.md §Scoring).
--
-- RLS / grants unchanged: RLS stays enabled on public.tokens, the select policy covers every column, and
-- `grant select on public.tokens to authenticated` (init migration) is table-level, so the new column is
-- readable by signed-in users; writes stay service_role only. Realtime publishes the whole row.

alter table public.tokens
  add column liquidity_jup_usd numeric
    check (liquidity_jup_usd is null or liquidity_jup_usd >= 0);

comment on column public.tokens.liquidity_jup_usd is
  'Jupiter tokens v2 liquidity (USD), null if unknown. Score uses min(liquidity_usd, liquidity_jup_usd).';
