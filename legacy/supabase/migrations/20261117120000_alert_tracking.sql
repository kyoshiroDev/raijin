-- Raijin — alert stability, exit plan and 7-day position tracking (fix/alerts).
--
-- Root cause fixed (alerts of 17/11/2026): the zone flipped between 'in' (candles) and 'wait' (approx) every scan
-- because candles are fetched for the top 10 only, and an alert fired on a single favourable scan.
--
-- New columns
--   tokens.zone_candles_at   : when the candle zone (zone_source = 'candles') was computed from real candles.
--                              scan-tokens reuses that swing for 10 min instead of falling back to approx.
--   token_snapshots.source   : 'scan' (token kept by the scan filters) or 'tracking' (token followed after an alert
--                              although it failed the scan filters). Persistence and x3 history read 'scan' only.
--   alert_log.*              : the alert becomes a tracked position (exit plan at send time, max/min/last price,
--                              first hit of target/stop, follow-up notification, tracking window of 7 days).
-- Changed default
--   alert_settings.min_rr    : 3 -> 1 for FUTURE rows only (the exit plan is +20 % / -20 % at most, so its R/R is
--                              <= 1 unless the Fibonacci invalidation is tighter). Existing rows are NOT updated.
-- Function
--   apply_alert_tracking(jsonb) : set-based update of the tracked positions (one call per scan), service_role only.
--   x3_snapshot_history         : now ignores 'tracking' snapshots (same signature, same output).
--
-- Security
--   No new table. RLS stays enabled on tokens, token_snapshots, alert_log, alert_settings; policies unchanged:
--   alert_log = owner SELECT only (no insert/update/delete policy, writes are service_role), token_snapshots and
--   tokens = SELECT for authenticated, alert_settings = owner-only CRUD. New columns inherit the table-level grants.
--   anon has nothing. The new function: security invoker, search_path = '', EXECUTE revoked from
--   public/anon/authenticated and granted to service_role only, input bounded (<= 1000 rows).
-- Upper bounds also reject 'Infinity' / 'NaN' (numeric accepts both).

-- ---------------------------------------------------------------------------
-- tokens: time of the persisted candle zone
-- ---------------------------------------------------------------------------
alter table public.tokens
  add column zone_candles_at timestamptz;

comment on column public.tokens.zone_candles_at is
  'When the candle swing (zone_source = candles) was computed from GeckoTerminal candles; null for approx zones.';

-- ---------------------------------------------------------------------------
-- token_snapshots: origin of the row
-- ---------------------------------------------------------------------------
-- Constant default: no table rewrite (Postgres >= 11).
alter table public.token_snapshots
  add column source text not null default 'scan' check (source in ('scan', 'tracking'));

comment on column public.token_snapshots.source is
  'scan = token kept by the scan filters; tracking = price sample of a token followed after an alert (score/zone = last known values).';

-- ---------------------------------------------------------------------------
-- alert_settings: R/R default for future rows (existing rows untouched on purpose)
-- ---------------------------------------------------------------------------
alter table public.alert_settings
  alter column min_rr set default 1;

comment on column public.alert_settings.min_rr is
  'Minimum reward/risk of the exit plan (target <= +20 %, stop >= -20 %), applied to every alert (0-50).';
comment on column public.alert_settings.min_p_x3 is
  'Calibrated model only, on top of score/zone: minimum P(x3 in 7 days) to alert (0-1).';
comment on column public.alert_settings.max_p_dd50 is
  'Calibrated model only, on top of score/zone: maximum P(-50 % first) to alert (0-1).';

-- ---------------------------------------------------------------------------
-- alert_log: tracked position
-- ---------------------------------------------------------------------------
alter table public.alert_log
  add column entry_price         numeric check (entry_price is null or (entry_price > 0 and entry_price < 1e12)),
  add column target_price        numeric check (target_price is null or (target_price > 0 and target_price < 1e12)),
  add column stop_price          numeric check (stop_price is null or (stop_price > 0 and stop_price < 1e12)),
  add column rr                  numeric check (rr is null or (rr >= 0 and rr < 1e6)),
  add column entry_score         smallint check (entry_score is null or entry_score between 0 and 100),
  add column entry_zone          text check (entry_zone is null or entry_zone in ('in', 'wait', 'deep', 'broken', 'none')),
  add column entry_roundtrip_pct numeric check (entry_roundtrip_pct is null or entry_roundtrip_pct between -100 and 100),
  add column stake_sol           numeric check (stake_sol is null or (stake_sol >= 0.01 and stake_sol <= 100)),
  add column max_price           numeric check (max_price is null or (max_price >= 0 and max_price < 1e12)),
  add column min_price           numeric check (min_price is null or (min_price >= 0 and min_price < 1e12)),
  add column last_price          numeric check (last_price is null or (last_price >= 0 and last_price < 1e12)),
  add column last_price_at       timestamptz,
  add column first_hit           text check (first_hit is null or first_hit in ('target', 'stop')),
  add column first_hit_at        timestamptz,
  add column followup_sent_at    timestamptz,
  add column tracking_until      timestamptz;

-- NOT VALID: rows sent before this migration have no plan; every NEW (or updated) single row must carry one.
-- Only grouped notification rows (« N nouvelles opportunités ») may keep the plan columns null.
alter table public.alert_log
  add constraint alert_log_single_has_plan check (
    kind = 'grouped'
    or (entry_price is not null and target_price is not null and stop_price is not null and rr is not null
        and entry_score is not null and entry_zone is not null and stake_sol is not null
        and max_price is not null and min_price is not null and last_price is not null
        and last_price_at is not null and tracking_until is not null)
  ) not valid,
  add constraint alert_log_plan_order check (
    entry_price is null or target_price is null or stop_price is null
    or (stop_price < entry_price and entry_price < target_price)
  ),
  add constraint alert_log_first_hit_pair check ((first_hit is null) = (first_hit_at is null)),
  add constraint alert_log_tracking_window check (
    tracking_until is null or tracking_until <= sent_at + interval '8 days'
  );

comment on column public.alert_log.entry_price is 'DexScreener price at alert time (entry of the exit plan).';
comment on column public.alert_log.target_price is 'min(entry x 1.20, tp1 if tp1 > entry).';
comment on column public.alert_log.stop_price is 'max(entry x 0.80, invalidation if 0 < invalidation < entry).';
comment on column public.alert_log.rr is '(target - entry) / (entry - stop) at alert time.';
comment on column public.alert_log.stake_sol is 'User stake (alert_settings.stake_sol) at alert time.';
comment on column public.alert_log.first_hit is 'First of target / stop reached by a 2-min snapshot price (wicks between samples can be missed).';
comment on column public.alert_log.tracking_until is 'sent_at + 7 days: scan-tokens samples the price until then.';

-- scan-tokens: open positions (tracking_until > now()).
create index alert_log_tracking_idx on public.alert_log (tracking_until desc) where tracking_until is not null;

-- ---------------------------------------------------------------------------
-- apply_alert_tracking: one set-based update per scan (service_role only)
-- p_rows = [{ id, max_price, min_price, last_price, last_price_at, first_hit, first_hit_at }], computed by the pure
-- helper trackPosition (_shared/alert-tracking.ts). First hit wins: an existing first_hit is never overwritten.
-- Returns the ids whose first_hit was set by THIS call (follow-up candidates).
-- ---------------------------------------------------------------------------
create function public.apply_alert_tracking(p_rows jsonb)
returns table (id bigint, first_hit text)
language sql
volatile
security invoker
set search_path = ''
as $$
  with input as (
    select x.id, x.max_price, x.min_price, x.last_price, x.last_price_at, x.first_hit, x.first_hit_at
    from jsonb_to_recordset(
      case
        when jsonb_typeof(p_rows) = 'array' and jsonb_array_length(p_rows) <= 1000 then p_rows
        else '[]'::jsonb
      end
    ) as x(id bigint, max_price numeric, min_price numeric, last_price numeric, last_price_at timestamptz,
           first_hit text, first_hit_at timestamptz)
    where x.id is not null and x.last_price > 0
  ),
  -- Every sub-statement sees the same snapshot: `before` reads the rows as they were before the update.
  before as (
    select a.id, a.first_hit is null as was_open
    from public.alert_log a
    join input i on i.id = a.id
  ),
  updated as (
    update public.alert_log a
       set max_price     = greatest(a.max_price, i.max_price),
           min_price     = least(a.min_price, i.min_price),
           last_price    = i.last_price,
           last_price_at = i.last_price_at,
           first_hit     = coalesce(a.first_hit, i.first_hit),
           first_hit_at  = case when a.first_hit is null and i.first_hit is not null then i.first_hit_at
                                else a.first_hit_at end
      from input i
     where a.id = i.id
       and a.tracking_until > now()
       and a.entry_price is not null
    returning a.id, a.first_hit
  )
  select u.id, u.first_hit
  from updated u
  join before b on b.id = u.id
  where b.was_open and u.first_hit is not null;
$$;

comment on function public.apply_alert_tracking(jsonb) is
  'scan-tokens (service_role): applies the tracked-position updates (<= 1000 rows); returns ids whose first hit was set now.';

revoke execute on function public.apply_alert_tracking(jsonb) from public, anon, authenticated;
grant execute on function public.apply_alert_tracking(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- x3_snapshot_history: ignore tracking samples (same signature: create or replace keeps the grants)
-- ---------------------------------------------------------------------------
create or replace function public.x3_snapshot_history(p_mints text[], p_since timestamptz)
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
      and s.source = 'scan'
    order by s.mint, date_bin('15 minutes', s.captured_at, timestamptz '2000-01-01'), s.captured_at desc
  ) b
  group by b.mint;
$$;

-- Re-assert (create or replace keeps them, repeated for clarity).
revoke execute on function public.x3_snapshot_history(text[], timestamptz) from public, anon, authenticated;
grant execute on function public.x3_snapshot_history(text[], timestamptz) to service_role;
