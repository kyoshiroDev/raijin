-- Raijin — « Radar précoce » (feat/early-radar): tokens in their first minutes/hours, SEPARATE from the main list.
--
-- Written by the new Edge Function scan-early (cron at odd minutes, see supabase/sql/schedule_early.sql).
--
-- New tables
--   early_candidates   : latest observation + early score of each radar candidate (one row per mint). Read by the
--                        front (« Radar » screen). first_seen_at / mc_at_detection / price_at_detection are set once.
--   early_observations : one row per candidate per scan-early run (acceleration vs the previous run). Purged > 48 h.
--   early_outcomes     : FIRST eligibility of each candidate (entry price) then its outcome, labelled from
--                        GeckoTerminal candles by label-outcomes exactly like signal_outcomes (×2/×3/×5, −50 % first,
--                        max multiple over 7 days). Separate from signal_outcomes on purpose: signal_outcomes.mint
--                        references tokens (most radar tokens are below the main scan's 50 k$ floor) and is the
--                        training set of the ×3 model and the « Performance » screen; radar rows there would block
--                        the main scan's first detection of the same mint (PK on mint) and pollute the model.
--   early_runs         : one row per scan-early run (counters, error) + overlap guard. Purged > 7 days.
-- Changed tables
--   alert_settings     : early_enabled (default false), early_min_score (default 75, 0–100), owner-editable.
--   alert_log.kind     : 'early' allowed (radar push). alert_log_single_has_plan now applies to kind = 'single' only;
--                        an 'early' row never carries a tracked position (tracking_until null).
--
-- Security
--   RLS enabled on every new table. No insert/update/delete policy for authenticated anywhere: writes are
--   service_role only (Edge Functions). early_candidates and early_outcomes: SELECT for authenticated.
--   early_observations and early_runs: no policy at all (service_role only). Supabase default privileges grant
--   ALL on new tables, so everything is revoked from anon and authenticated first (TRUNCATE, REFERENCES, TRIGGER and
--   MAINTAIN included), then SELECT is granted back where there is a policy. anon gets nothing.
--   alert_settings / alert_log: policies unchanged (owner CRUD / owner SELECT); new columns inherit the table grants.
-- Units: *_pct are PERCENT 0–100; pro_trader_share is a FRACTION 0–1; money in USD.
-- Upper bounds also reject 'Infinity' / 'NaN' (numeric accepts both and NaN sorts above everything).

-- ---------------------------------------------------------------------------
-- early_candidates
-- ---------------------------------------------------------------------------
create table public.early_candidates (
  mint                      text primary key check (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- Sanitised server-side (sanitizeText: control/bidi chars and angle brackets stripped). Hostile anyway.
  symbol                    text not null default '' check (char_length(symbol) <= 32),
  name                      text not null default '' check (char_length(name) <= 64),
  first_seen_at             timestamptz not null default now(),
  last_seen_at              timestamptz not null default now(),
  mc_at_detection           numeric check (mc_at_detection is null or (mc_at_detection >= 0 and mc_at_detection < 1e15)),
  price_at_detection        numeric check (price_at_detection is null or (price_at_detection > 0 and price_at_detection < 1e12)),
  first_eligible_at         timestamptz,
  -- Last observation
  mc                        numeric check (mc is null or (mc >= 0 and mc < 1e15)),
  price                     numeric check (price is null or (price > 0 and price < 1e12)),
  liquidity                 numeric check (liquidity is null or (liquidity >= 0 and liquidity < 1e13)),
  holders                   integer check (holders is null or holders between 0 and 1000000000),
  txns_5m                   integer check (txns_5m is null or txns_5m between 0 and 10000000),
  volume_5m_usd             numeric check (volume_5m_usd is null or (volume_5m_usd >= 0 and volume_5m_usd < 1e13)),
  buys_5m                   integer check (buys_5m is null or buys_5m between 0 and 10000000),
  sells_5m                  integer check (sells_5m is null or sells_5m between 0 and 10000000),
  organic_score             numeric check (organic_score is null or organic_score between 0 and 100),
  pro_trader_share          numeric check (pro_trader_share is null or pro_trader_share between 0 and 1),
  top10_pct                 numeric check (top10_pct is null or top10_pct between 0 and 100),
  bundlers_pct              numeric check (bundlers_pct is null or bundlers_pct between 0 and 100),
  snipers_pct               numeric check (snipers_pct is null or snipers_pct between 0 and 100),
  dev_pct                   numeric check (dev_pct is null or dev_pct between 0 and 100),
  mint_authority_disabled   boolean,
  freeze_authority_disabled boolean,
  age_minutes               numeric check (age_minutes is null or (age_minutes >= 0 and age_minutes < 10000000)),
  migrated_at               timestamptz,
  -- Early score (_shared/early.ts)
  early_score               smallint not null default 0 check (early_score between 0 and 100),
  eligible                  boolean not null default false,
  excluded_by               text[] not null default '{}' check (
                              cardinality(excluded_by) <= 6
                              and array_position(excluded_by, null) is null
                              and octet_length(array_to_string(excluded_by, '|')) <= 600
                            ),
  signals                   text[] not null default '{}' check (
                              cardinality(signals) <= 6
                              and array_position(signals, null) is null
                              and octet_length(array_to_string(signals, '|')) <= 600
                            ),
  -- Radar sources that brought the mint in the last run (allowlist).
  sources                   text[] not null default '{}' check (
                              cardinality(sources) <= 6
                              and array_position(sources, null) is null
                              and sources <@ array[
                                'jup_trending_5m', 'jup_organic_5m', 'jup_traded_5m', 'gecko_trending_5m',
                                'migration', 'tracked'
                              ]::text[]
                            ),
  pair_address              text check (pair_address is null or pair_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  dex_id                    text check (dex_id is null or char_length(dex_id) <= 32),
  -- Jupiter round trip 0.1 SOL (PERCENT), top eligible candidates only; null = not quoted / unknown.
  roundtrip_cost_pct        numeric check (roundtrip_cost_pct is null or roundtrip_cost_pct between -100 and 100),
  roundtrip_at              timestamptz,
  updated_at                timestamptz not null default now()
);

comment on table public.early_candidates is 'Radar précoce: latest observation and early score of each very young token (scan-early, service_role).';
comment on column public.early_candidates.first_eligible_at is 'First run where the candidate was eligible (an early_outcomes row is created then).';
comment on column public.early_candidates.pro_trader_share is 'FRACTION 0-1. No source exposes it yet: always null for now.';
comment on column public.early_candidates.bundlers_pct is 'PERCENT. No source used by scan-early exposes it yet: always null for now.';
comment on column public.early_candidates.snipers_pct is 'PERCENT. No source used by scan-early exposes it yet: always null for now.';
comment on column public.early_candidates.top10_pct is 'Jupiter audit.topHoldersPercentage (PERCENT).';

-- Front: eligible = true|false, seen in the last 2 h, best early score first.
create index early_candidates_eligible_score_idx on public.early_candidates (eligible, early_score desc);
create index early_candidates_last_seen_idx on public.early_candidates (last_seen_at desc);

-- ---------------------------------------------------------------------------
-- early_observations
-- ---------------------------------------------------------------------------
create table public.early_observations (
  id                        bigint generated always as identity primary key,
  mint                      text not null references public.early_candidates (mint) on delete cascade
                            check (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  at                        timestamptz not null default now(),
  mc                        numeric check (mc is null or (mc >= 0 and mc < 1e15)),
  price                     numeric check (price is null or (price > 0 and price < 1e12)),
  liquidity                 numeric check (liquidity is null or (liquidity >= 0 and liquidity < 1e13)),
  holders                   integer check (holders is null or holders between 0 and 1000000000),
  txns_5m                   integer check (txns_5m is null or txns_5m between 0 and 10000000),
  volume_5m_usd             numeric check (volume_5m_usd is null or (volume_5m_usd >= 0 and volume_5m_usd < 1e13)),
  buys_5m                   integer check (buys_5m is null or buys_5m between 0 and 10000000),
  sells_5m                  integer check (sells_5m is null or sells_5m between 0 and 10000000),
  organic_score             numeric check (organic_score is null or organic_score between 0 and 100),
  pro_trader_share          numeric check (pro_trader_share is null or pro_trader_share between 0 and 1),
  top10_pct                 numeric check (top10_pct is null or top10_pct between 0 and 100),
  bundlers_pct              numeric check (bundlers_pct is null or bundlers_pct between 0 and 100),
  snipers_pct               numeric check (snipers_pct is null or snipers_pct between 0 and 100),
  dev_pct                   numeric check (dev_pct is null or dev_pct between 0 and 100),
  mint_authority_disabled   boolean,
  freeze_authority_disabled boolean,
  age_minutes               numeric check (age_minutes is null or (age_minutes >= 0 and age_minutes < 10000000)),
  migrated_at               timestamptz,
  early_score               smallint check (early_score is null or early_score between 0 and 100),
  eligible                  boolean
);

comment on table public.early_observations is 'Radar précoce: one observation per candidate per scan-early run (acceleration). Purged after 48 h.';

create index early_observations_mint_at_idx on public.early_observations (mint, at desc);
create index early_observations_at_idx on public.early_observations (at);

-- ---------------------------------------------------------------------------
-- early_outcomes (same label columns as signal_outcomes: label-outcomes reuses its pure helpers)
-- ---------------------------------------------------------------------------
create table public.early_outcomes (
  mint             text primary key check (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  pair_address     text not null check (pair_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  detected_at      timestamptz not null,
  entry_price      numeric not null check (entry_price > 0 and entry_price < 1e12),
  entry_mc         numeric check (entry_mc is null or (entry_mc >= 0 and entry_mc < 1e15)),
  entry_score      smallint check (entry_score is null or entry_score between 0 and 100),
  entry_age_minutes numeric check (entry_age_minutes is null or (entry_age_minutes >= 0 and entry_age_minutes < 10000000)),
  entry_dex_id     text check (entry_dex_id is null or char_length(entry_dex_id) <= 32),
  status           text not null default 'pending' check (status in ('pending', 'final')),
  hit_x2           boolean,
  hit_x3           boolean,
  hit_x5           boolean,
  dd50_first       boolean,
  max_multiple_7d  numeric check (max_multiple_7d is null or (max_multiple_7d >= 0 and max_multiple_7d < 1e9)),
  hours_to_x3      numeric check (hours_to_x3 is null or hours_to_x3 between 0 and 744),
  observed_hours   numeric check (observed_hours is null or observed_hours between 0 and 744),
  labelled_at      timestamptz,
  label_attempts   smallint not null default 0 check (label_attempts between 0 and 10000),
  label_error      text check (label_error is null or char_length(label_error) <= 200),
  created_at       timestamptz not null default now(),
  constraint early_outcomes_final_has_labels check (
    status = 'pending'
    or (hit_x2 is not null and hit_x3 is not null and hit_x5 is not null and dd50_first is not null
        and max_multiple_7d is not null and observed_hours is not null and labelled_at is not null)
  )
);

comment on table public.early_outcomes is 'Radar précoce: first eligibility of each candidate (entry) and its 7-day outcome labelled from candles by label-outcomes. Not used by the x3 model.';

create index early_outcomes_status_detected_idx on public.early_outcomes (status, detected_at desc);
create index early_outcomes_pending_queue_idx on public.early_outcomes (labelled_at nulls first, detected_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- early_runs
-- ---------------------------------------------------------------------------
create table public.early_runs (
  id             bigint generated always as identity primary key,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  candidates     integer not null default 0 check (candidates between 0 and 100000),
  observed       integer not null default 0 check (observed between 0 and 100000),
  eligible       integer not null default 0 check (eligible between 0 and 100000),
  outcomes       integer not null default 0 check (outcomes between 0 and 100000),
  alerts         integer not null default 0 check (alerts between 0 and 100000),
  stats          jsonb check (stats is null or (jsonb_typeof(stats) = 'object' and octet_length(stats::text) <= 8192)),
  error          text check (error is null or char_length(error) <= 1000)
);

comment on table public.early_runs is 'One row per scan-early run (counters, error); also its overlap guard. service_role only. Purged after 7 days.';

create index early_runs_started_at_idx on public.early_runs (started_at desc);

-- ---------------------------------------------------------------------------
-- alert_settings: radar alerts (owner-editable like the other preferences)
-- ---------------------------------------------------------------------------
alter table public.alert_settings
  add column early_enabled   boolean  not null default false,
  add column early_min_score smallint not null default 75 check (early_min_score between 0 and 100);

comment on column public.alert_settings.early_enabled is 'Radar alerts (very early tokens, very risky). Off by default. Independent of enabled.';
comment on column public.alert_settings.early_min_score is 'Minimum early score (0-100) of a radar alert.';

create index alert_settings_early_enabled_idx on public.alert_settings (user_id) where early_enabled;

-- ---------------------------------------------------------------------------
-- alert_log: kind 'early'
-- ---------------------------------------------------------------------------
-- The inline check of 20261116200000 is named alert_log_kind_check by Postgres.
alter table public.alert_log drop constraint alert_log_kind_check;
alter table public.alert_log
  add constraint alert_log_kind_check check (kind in ('single', 'grouped', 'early'));

-- Only SINGLE alerts carry a tracked position. NOT VALID as before (rows sent before 20261117120000 have no plan).
alter table public.alert_log drop constraint alert_log_single_has_plan;
alter table public.alert_log
  add constraint alert_log_single_has_plan check (
    kind <> 'single'
    or (entry_price is not null and target_price is not null and stop_price is not null and rr is not null
        and entry_score is not null and entry_zone is not null and stake_sol is not null
        and max_price is not null and min_price is not null and last_price is not null
        and last_price_at is not null and tracking_until is not null)
  ) not valid,
  -- A radar alert is never a tracked position (scan-tokens' tracking reads tracking_until).
  add constraint alert_log_early_untracked check (kind <> 'early' or tracking_until is null);

-- ---------------------------------------------------------------------------
-- Privileges (defense in depth, on top of RLS). service_role is left untouched.
-- ---------------------------------------------------------------------------
revoke all on public.early_candidates, public.early_observations, public.early_outcomes, public.early_runs
  from anon, authenticated;
grant select on public.early_candidates, public.early_outcomes to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.early_candidates   enable row level security;
alter table public.early_observations enable row level security;
alter table public.early_outcomes     enable row level security;
alter table public.early_runs         enable row level security;

create policy "early candidates are readable by signed-in users"
  on public.early_candidates for select to authenticated using (true);

create policy "early outcomes are readable by signed-in users"
  on public.early_outcomes for select to authenticated using (true);

-- early_observations, early_runs: no policy (service_role only).
