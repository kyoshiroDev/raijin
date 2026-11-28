-- Raijin — « ×3 minimum » model (feat/x3-model).
--
-- New tables
--   signal_outcomes : one row per token = its FIRST detection (entry price + feature snapshot), then labelled
--                     from GeckoTerminal candles by the label-outcomes Edge Function (x2 / x3 / x5, −50 % first,
--                     max multiple over 7 days). Training data of the logistic model.
--   model_weights   : versioned calibrated models (ModelWeights JSON, _shared/x3-types.ts), at most one active.
-- New columns
--   token_snapshots : feature history (holders, 1 h volume/txns, dex id, organic score).
--   tokens          : model outputs (p_x3, p_dd50, rr, version, calibrated), narrative, latest features,
--                     RugCheck insiders / creator history (written by enrich-tokens).
--   alert_settings  : model-based alert thresholds (used only when the model is calibrated).
-- Functions (service_role only): x3_snapshot_history (feature history for scan-tokens, one call per scan),
--   x3_backfill_candidates (tokens without an outcome row + their first snapshot, for label-outcomes).
--
-- Security
--   RLS enabled on both new tables, SELECT policy for authenticated only; no insert/update/delete policy
--   (writes are service_role only, which bypasses RLS). Table privileges: authenticated = SELECT only
--   (Supabase default privileges grant ALL on new tables, so everything is revoked first, MAINTAIN included);
--   anon = nothing. New columns on existing tables inherit the existing table-level grants (tokens /
--   token_snapshots: SELECT for authenticated; alert_settings: owner-only RLS CRUD).
-- Units: probabilities are FRACTIONS 0–1; *_pct are PERCENT; multiples are ratios (3 = ×3).
-- Upper bounds also reject 'Infinity' / 'NaN' (Postgres numeric accepts both and NaN sorts above everything).

-- ---------------------------------------------------------------------------
-- signal_outcomes
-- ---------------------------------------------------------------------------
create table public.signal_outcomes (
  mint                 text primary key references public.tokens (mint) on delete cascade
                       check (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- Pool whose candles label the outcome (the token's best pair at detection).
  pair_address         text not null check (pair_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- 'scan' = recorded live by scan-tokens; 'backfill' = rebuilt by label-outcomes from the first snapshot
  -- (fewer known features).
  source               text not null default 'scan' check (source in ('scan', 'backfill')),
  detected_at          timestamptz not null,
  entry_price          numeric not null check (entry_price > 0 and entry_price < 1e12),
  entry_mc             numeric check (entry_mc is null or (entry_mc >= 0 and entry_mc < 1e15)),
  entry_liq_eff        numeric check (entry_liq_eff is null or (entry_liq_eff >= 0 and entry_liq_eff < 1e13)),
  entry_roundtrip_pct  numeric check (entry_roundtrip_pct is null or entry_roundtrip_pct between -100 and 100),
  entry_score          smallint check (entry_score is null or entry_score between 0 and 100),
  entry_zone           text check (entry_zone is null or entry_zone in ('in', 'wait', 'deep', 'broken', 'none')),
  -- FeatureVector (feature name -> number | null), bounded in size.
  features             jsonb not null
                       check (jsonb_typeof(features) = 'object' and pg_column_size(features) <= 8192),
  model_version        text check (model_version is null or char_length(model_version) between 1 and 64),
  p_x3                 numeric check (p_x3 is null or p_x3 between 0 and 1),
  p_dd50               numeric check (p_dd50 is null or p_dd50 between 0 and 1),
  status               text not null default 'pending' check (status in ('pending', 'final')),
  hit_x2               boolean,
  hit_x3               boolean,
  hit_x5               boolean,
  dd50_first           boolean,
  max_multiple_7d      numeric check (max_multiple_7d is null or (max_multiple_7d >= 0 and max_multiple_7d < 1e9)),
  hours_to_x3          numeric check (hours_to_x3 is null or hours_to_x3 between 0 and 744),
  observed_hours       numeric check (observed_hours is null or observed_hours between 0 and 744),
  labelled_at          timestamptz,
  label_attempts       smallint not null default 0 check (label_attempts between 0 and 10000),
  label_error          text check (label_error is null or char_length(label_error) <= 200),
  created_at           timestamptz not null default now(),
  -- A final row carries every label.
  constraint signal_outcomes_final_has_labels check (
    status = 'pending'
    or (hit_x2 is not null and hit_x3 is not null and hit_x5 is not null and dd50_first is not null
        and max_multiple_7d is not null and observed_hours is not null and labelled_at is not null)
  )
);

comment on table public.signal_outcomes is 'First detection of each token (entry + features) and its outcome labelled from candles (training data of the x3 model).';
comment on column public.signal_outcomes.features is 'FeatureVector at detection (_shared/x3-types.ts), null values = unknown.';
comment on column public.signal_outcomes.dd50_first is '-50 % from entry reached before x3 (or without ever reaching x3).';
comment on column public.signal_outcomes.max_multiple_7d is 'Max high / entry price over the observed window (<= 7 days).';

create index signal_outcomes_status_detected_idx on public.signal_outcomes (status, detected_at desc);
-- label-outcomes queue: never-attempted rows first, then the least recently labelled.
create index signal_outcomes_pending_queue_idx on public.signal_outcomes (labelled_at nulls first, detected_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- model_weights
-- ---------------------------------------------------------------------------
create table public.model_weights (
  id          bigint generated always as identity primary key,
  version     text not null unique check (char_length(version) between 1 and 64),
  trained_at  timestamptz not null,
  payload     jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 65536),
  active      boolean not null default false,
  created_at  timestamptz not null default now()
);

comment on table public.model_weights is 'Versioned calibrated models (ModelWeights JSON). At most one active row.';

create unique index model_weights_one_active_idx on public.model_weights (active) where active;

-- ---------------------------------------------------------------------------
-- token_snapshots: feature history
-- ---------------------------------------------------------------------------
alter table public.token_snapshots
  add column holder_count  integer check (holder_count is null or holder_count >= 0),
  add column volume_1h     numeric check (volume_1h is null or (volume_1h >= 0 and volume_1h < 1e15)),
  add column txns_1h       integer check (txns_1h is null or txns_1h >= 0),
  add column dex_id        text check (dex_id is null or char_length(dex_id) <= 32),
  add column organic_score numeric check (organic_score is null or organic_score between 0 and 100);

comment on column public.token_snapshots.holder_count is 'Jupiter holderCount at capture (null if not audited this scan).';
comment on column public.token_snapshots.volume_1h is 'DexScreener 1 h volume (USD) of the best pair.';
comment on column public.token_snapshots.txns_1h is 'DexScreener 1 h buys + sells of the best pair.';

-- ---------------------------------------------------------------------------
-- tokens: model outputs, narrative, latest features, RugCheck insiders / creator
-- ---------------------------------------------------------------------------
alter table public.tokens
  add column p_x3                numeric check (p_x3 is null or p_x3 between 0 and 1),
  add column p_dd50              numeric check (p_dd50 is null or p_dd50 between 0 and 1),
  add column rr                  numeric check (rr is null or (rr >= 0 and rr < 1e6)),
  add column model_version       text check (model_version is null or char_length(model_version) between 1 and 64),
  add column model_calibrated    boolean not null default false,
  add column narrative           text check (narrative is null or char_length(narrative) between 1 and 24),
  add column narrative_rank      smallint check (narrative_rank is null or narrative_rank between 0 and 10000),
  add column features            jsonb
    check (features is null or (jsonb_typeof(features) = 'object' and pg_column_size(features) <= 8192)),
  -- Written by enrich-tokens (RugCheck), like the other rugcheck_* columns.
  add column insiders_detected   boolean,
  add column creator_rug_history boolean;

comment on column public.tokens.p_x3 is 'Model probability of x3 within 7 days (FRACTION), null unless model_calibrated.';
comment on column public.tokens.p_dd50 is 'Model probability of -50 % before x3 (FRACTION), null unless model_calibrated.';
comment on column public.tokens.rr is 'Risk/reward (tp1 - price) / (price - invalidation), null if not computable.';
comment on column public.tokens.model_calibrated is 'true when p_x3/p_dd50 come from an active model trained on enough labelled outcomes.';
comment on column public.tokens.narrative is 'Narrative group of the token (keywords), null if none.';
comment on column public.tokens.narrative_rank is '1 = largest MC in its narrative group among the scanned tokens.';
comment on column public.tokens.features is 'Latest FeatureVector computed by scan-tokens.';
comment on column public.tokens.insiders_detected is 'RugCheck report graphInsidersDetected > 0 (null = unknown).';
comment on column public.tokens.creator_rug_history is 'RugCheck risk « Creator history of rugged tokens » present (null = unknown).';

-- ---------------------------------------------------------------------------
-- alert_settings: model thresholds (only applied to calibrated tokens)
-- ---------------------------------------------------------------------------
alter table public.alert_settings
  add column min_p_x3   numeric not null default 0.25 check (min_p_x3 between 0 and 1),
  add column max_p_dd50 numeric not null default 0.4  check (max_p_dd50 between 0 and 1),
  add column min_rr     numeric not null default 3    check (min_rr between 0 and 50);

comment on column public.alert_settings.min_p_x3 is 'Calibrated model only: minimum P(x3 in 7 days) to alert (0-1).';
comment on column public.alert_settings.max_p_dd50 is 'Calibrated model only: maximum P(-50 % first) to alert (0-1).';
comment on column public.alert_settings.min_rr is 'Calibrated model only: minimum risk/reward to alert (0-50).';

-- ---------------------------------------------------------------------------
-- Service-role helpers (PostgREST rpc). security invoker + empty search_path; EXECUTE revoked from
-- public/anon/authenticated (Postgres grants EXECUTE to PUBLIC by default).
-- ---------------------------------------------------------------------------

-- Feature history for scan-tokens: at most one sample per mint per 15-minute bucket (the latest of the
-- bucket) since p_since (clamped to the last 48 h), aggregated per mint so the response stays small
-- (<= 200 mints x 192 samples) and is not cut by the API max-rows limit.
create function public.x3_snapshot_history(p_mints text[], p_since timestamptz)
returns table (mint text, samples jsonb)
language sql
stable
security invoker
set search_path = ''
as $$
  select b.mint,
         jsonb_agg(
           jsonb_build_object(
             't', floor(extract(epoch from b.captured_at) * 1000),
             'price', b.price_usd,
             'holders', b.holder_count,
             'volume_1h', b.volume_1h,
             'txns_1h', b.txns_1h,
             'dex', b.dex_id
           ) order by b.captured_at
         )
  from (
    select distinct on (s.mint, date_bin('15 minutes', s.captured_at, timestamptz '2000-01-01'))
           s.mint, s.captured_at, s.price_usd, s.holder_count, s.volume_1h, s.txns_1h, s.dex_id
    from public.token_snapshots s
    where s.mint = any (p_mints[1:200])
      and s.captured_at >= greatest(p_since, now() - interval '48 hours')
    order by s.mint, date_bin('15 minutes', s.captured_at, timestamptz '2000-01-01'), s.captured_at desc
  ) b
  group by b.mint;
$$;

comment on function public.x3_snapshot_history(text[], timestamptz) is
  'scan-tokens (service_role): 15-min downsampled snapshot history per mint (<= 200 mints, <= 48 h).';

-- Backfill queue for label-outcomes: tokens without a signal_outcomes row, with their FIRST snapshot
-- (oldest first). Uses token_snapshots_mint_time_idx (backward scan) per token.
create function public.x3_backfill_candidates(p_limit integer)
returns table (
  mint text,
  pair_address text,
  symbol text,
  name text,
  pair_created_at timestamptz,
  insiders_detected boolean,
  creator_rug_history boolean,
  captured_at timestamptz,
  price_usd numeric,
  market_cap numeric,
  liquidity_usd numeric,
  volume_24h numeric,
  score smallint,
  zone_status text,
  holder_count integer,
  volume_1h numeric,
  txns_1h integer,
  dex_id text,
  organic_score numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select t.mint, t.pair_address, t.symbol, t.name, t.pair_created_at, t.insiders_detected, t.creator_rug_history,
         f.captured_at, f.price_usd, f.market_cap, f.liquidity_usd, f.volume_24h, f.score, f.zone_status,
         f.holder_count, f.volume_1h, f.txns_1h, f.dex_id, f.organic_score
  from public.tokens t
  cross join lateral (
    select s.captured_at, s.price_usd, s.market_cap, s.liquidity_usd, s.volume_24h, s.score, s.zone_status,
           s.holder_count, s.volume_1h, s.txns_1h, s.dex_id, s.organic_score
    from public.token_snapshots s
    where s.mint = t.mint
    order by s.captured_at asc
    limit 1
  ) f
  where not exists (select 1 from public.signal_outcomes o where o.mint = t.mint)
    and f.price_usd > 0
  order by f.captured_at asc
  limit least(greatest(coalesce(p_limit, 0), 0), 500);
$$;

comment on function public.x3_backfill_candidates(integer) is
  'label-outcomes (service_role): tokens without an outcome row and their first snapshot (<= 500).';

revoke execute on function public.x3_snapshot_history(text[], timestamptz) from public, anon, authenticated;
revoke execute on function public.x3_backfill_candidates(integer) from public, anon, authenticated;
grant execute on function public.x3_snapshot_history(text[], timestamptz) to service_role;
grant execute on function public.x3_backfill_candidates(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Privileges (defense in depth, on top of RLS)
-- ---------------------------------------------------------------------------
revoke all on public.signal_outcomes, public.model_weights from anon, authenticated;
grant select on public.signal_outcomes, public.model_weights to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security: read for signed-in users, writes service_role only (no write policy).
-- ---------------------------------------------------------------------------
alter table public.signal_outcomes enable row level security;
alter table public.model_weights   enable row level security;

create policy "signal outcomes are readable by signed-in users"
  on public.signal_outcomes for select to authenticated using (true);

create policy "model weights are readable by signed-in users"
  on public.model_weights for select to authenticated using (true);
