-- Raijin — cross-source enrichment (feat/data-consensus).
--
-- Written by the enrich-tokens Edge Function (service_role), 1 minute after each scan:
--   GeckoTerminal pool (liquidity + price), RugCheck summary (LP locked, risk score, dangers),
--   Jupiter round trip 0.1 SOL -> token -> SOL (real trading cost).
-- Written by scan-tokens: price_jup_usd (Jupiter tokens v2 usdPrice) and the derived consensus columns
-- (liquidity_effective_usd, liquidity_divergence, data_confidence), which enrich-tokens also refreshes.
-- Units: *_pct columns are PERCENT (4.2 = 4.2 %); liquidity_divergence is a FRACTION (0.25 = 25 %).
-- null = unknown / not fetched.
--
-- RLS / grants unchanged: RLS stays enabled on public.tokens and public.alert_settings.
--   tokens: `grant select on public.tokens to authenticated` (init migration) is table-level, so the new
--   columns are readable by signed-in users; no insert/update/delete for authenticated (service_role only);
--   anon has nothing (revoke all in init). Realtime publishes the whole row.
--   alert_settings: table-level select/insert/update/delete for authenticated + owner-only policies
--   (push migration), so stake_sol is editable by its owner only; anon has nothing.
-- Upper bounds also reject 'Infinity' / 'NaN' (Postgres numeric accepts both and NaN sorts above everything).

alter table public.tokens
  -- Same value as liquidity_usd (DexScreener, best pair) under the explicit name, without double writes.
  -- Generated: never written by the Edge Functions (PostgREST rejects writes to generated columns).
  add column liquidity_dex_usd       numeric generated always as (liquidity_usd) stored,
  add column liquidity_gecko_usd     numeric
    check (liquidity_gecko_usd is null or (liquidity_gecko_usd >= 0 and liquidity_gecko_usd < 1e13)),
  add column liquidity_effective_usd numeric
    check (liquidity_effective_usd is null or (liquidity_effective_usd >= 0 and liquidity_effective_usd < 1e13)),
  add column liquidity_divergence    numeric
    check (liquidity_divergence is null or (liquidity_divergence >= 0 and liquidity_divergence < 1e9)),
  add column roundtrip_cost_pct      numeric
    check (roundtrip_cost_pct is null or roundtrip_cost_pct between -100 and 100),
  add column roundtrip_fee_pct       numeric
    check (roundtrip_fee_pct is null or roundtrip_fee_pct between 0 and 100),
  add column buy_impact_pct          numeric
    check (buy_impact_pct is null or buy_impact_pct between -100 and 100),
  add column lp_locked_pct           numeric
    check (lp_locked_pct is null or lp_locked_pct between 0 and 100),
  add column rugcheck_score          numeric
    check (rugcheck_score is null or (rugcheck_score >= 0 and rugcheck_score < 1e9)),
  add column rugcheck_dangers        text[] not null default '{}'
    check (
      cardinality(rugcheck_dangers) <= 5
      and array_position(rugcheck_dangers, null) is null
      and char_length(array_to_string(rugcheck_dangers, '')) <= 200  -- 5 names x 40 chars
    ),
  add column price_jup_usd           numeric
    check (price_jup_usd is null or (price_jup_usd >= 0 and price_jup_usd < 1e12)),
  add column price_gecko_usd         numeric
    check (price_gecko_usd is null or (price_gecko_usd >= 0 and price_gecko_usd < 1e12)),
  add column data_confidence         text
    check (data_confidence is null or data_confidence in ('high', 'medium', 'low')),
  add column quote_at                timestamptz,
  add column rugcheck_at             timestamptz,
  add column enriched_at             timestamptz;

comment on column public.tokens.liquidity_dex_usd is 'DexScreener liquidity (USD), generated from liquidity_usd.';
comment on column public.tokens.liquidity_gecko_usd is 'GeckoTerminal pool reserve_in_usd for pair_address (USD), null if unknown.';
comment on column public.tokens.liquidity_effective_usd is 'Liquidity retained by the score across DexScreener/Jupiter/GeckoTerminal (USD).';
comment on column public.tokens.liquidity_divergence is 'Liquidity disagreement (max - min) / min across sources, FRACTION (0.25 = 25 %), null if < 2 sources.';
comment on column public.tokens.roundtrip_cost_pct is 'Jupiter round trip 0.1 SOL -> token -> SOL: (1 - SOL back / 0.1) x 100, PERCENT.';
comment on column public.tokens.roundtrip_fee_pct is 'Approximate non-size-dependent part: max(0, cost - buy impact - sell impact), PERCENT.';
comment on column public.tokens.buy_impact_pct is 'Jupiter priceImpactPct of the 0.1 SOL buy leg, PERCENT.';
comment on column public.tokens.lp_locked_pct is 'RugCheck lpLockedPct, PERCENT 0-100.';
comment on column public.tokens.rugcheck_score is 'RugCheck summary raw score (higher = riskier).';
comment on column public.tokens.rugcheck_dangers is 'RugCheck risks with level danger: sanitised names, <= 5, <= 40 chars each.';
comment on column public.tokens.price_jup_usd is 'Jupiter tokens v2 usdPrice (USD), written by scan-tokens.';
comment on column public.tokens.price_gecko_usd is 'GeckoTerminal pool price of this token (USD).';
comment on column public.tokens.data_confidence is 'Cross-source agreement: high / medium / low, null if not computed.';
comment on column public.tokens.quote_at is 'Last successful Jupiter round-trip quote.';
comment on column public.tokens.rugcheck_at is 'Last successful RugCheck fetch (cache: refreshed after 30 min).';
comment on column public.tokens.enriched_at is 'Last enrich-tokens update (GeckoTerminal values are as of this time).';

-- « Ma mise habituelle (SOL) », edited by the owner in the app.
alter table public.alert_settings
  add column stake_sol numeric not null default 0.1
    check (stake_sol >= 0.01 and stake_sol <= 100);

comment on column public.alert_settings.stake_sol is 'Usual stake in SOL (0.01-100), used to show the real trading cost.';

-- ---------------------------------------------------------------------------
-- Hardening: Supabase default privileges also granted REFERENCES and TRIGGER to
-- authenticated on the scanner tables. Signed-in users only need SELECT there.
-- ---------------------------------------------------------------------------
revoke references, trigger on public.tokens, public.token_snapshots, public.scan_runs from authenticated;
