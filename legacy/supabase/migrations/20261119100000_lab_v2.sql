-- feat/lab-v2 (docs/contracts/lab-v2.md) — point-in-time snapshots, event backtest, server-side catch-up gauge.
-- SIMULATION ONLY: replays of past snapshots / detections on stored candles; no wallet, no key, no signature.
--
-- What changes
--   token_snapshots        : point-in-time columns written by scan-tokens from the token row known AT SCAN TIME
--                            (mint / freeze authority, top 10, insiders, round-trip cost, change_1h). Nullable, bounded,
--                            never backfilled (older snapshots stay null: the backtest only uses what was known).
--                            Index (captured_at, id) for the incremental event scanner (keyset).
--   backtest_events        : one event per (preset, mint) = the FIRST snapshot where the preset's conditions became
--                            true (momentum, young_24h, young_3h, post_migration, narrative_leader), with its own candle
--                            capture queue (candles_1m_at = event + 6 h, candles_5m_at = event + 72 h, set on insert by
--                            a trigger). Kept 30 days (supabase/sql/schedule_backtest.sql), past the 3-day snapshot purge.
--   backtest_event_state   : event scanner state (backtest-run): key 'cursor' = keyset position + counters (+ lease);
--                            key = mint → per-mint replay state (first dex seen, recent prices, migration time…). Internal.
--   ohlcv_candles.source   : + 'backtest_events'.
--   candles_1m_at          : 1-minute candles are no longer requested for detections whose pair was >= 48 h old at
--                            detection (tokens.pair_created_at): queue column set to null now and by the insert trigger.
--   backtest_runs.summary  : nightly summary (§3), added to the column-level SELECT grant.
--   backtest_trades /      : event presets (post_migration, narrative_leader) and event rows (source backtest_events,
--   backtest_results         preset_flags = ONE event bit: 2, 4, 8, 32, 64); the trades primary key includes
--                            preset_flags (two presets firing on the same snapshot give two rows). The 70 / 30 cutoff is
--                            now computed per preset by the aggregation (backtest.ts), the split column stays global.
--   backtest_trades_slice(): preset bits 32 / 64 accepted, deterministic order includes preset_flags.
--   label_runs             : compact journal of label-outcomes (one row per call: requests, 429, rows written) for the
--                            measured throughput of the gauge. Purged after 7 days.
--   backfill_progress()    : authenticated, read-only gauge of the catch-up (§1): per category done / total / due_now /
--                            last_24h, measured throughput over 6 h and ETA.
--
-- Security
--   New tables: RLS enabled. backtest_events and label_runs: SELECT policy for authenticated only, everything revoked
--   from anon / authenticated then SELECT granted back (Supabase default privileges grant ALL on new tables).
--   backtest_event_state: RLS enabled, NO policy, everything revoked from anon / authenticated → service_role only.
--   No insert / update / delete policy anywhere: writes are service_role only (scan-tokens, label-outcomes,
--   backtest-run, purge crons). New columns inherit the table grants (token_snapshots: SELECT for authenticated).
--   backfill_progress(): security definer (aggregates only, of tables already readable by authenticated, plus the
--   label_runs counts), stable, search_path = '', no argument, EXECUTE for authenticated only.
--   Trigger functions: EXECUTE revoked from public / anon / authenticated.
-- Units: *_pct are PERCENT. Upper bounds also reject 'Infinity' / 'NaN' (NaN sorts above every number in Postgres).

-- ---------------------------------------------------------------------------
-- 1. token_snapshots: values known at scan time (~30 bytes per row)
-- ---------------------------------------------------------------------------
alter table public.token_snapshots
  add column mint_authority_disabled   boolean,
  add column freeze_authority_disabled boolean,
  add column top10_pct                 numeric
    constraint token_snapshots_top10_pct_check check (top10_pct is null or (top10_pct >= 0 and top10_pct <= 100)),
  add column insiders_detected         boolean,
  add column roundtrip_cost_pct        numeric
    constraint token_snapshots_roundtrip_check check (roundtrip_cost_pct is null or (roundtrip_cost_pct >= -100 and roundtrip_cost_pct <= 100)),
  add column change_1h                 numeric
    constraint token_snapshots_change_1h_check check (change_1h is null or (change_1h >= -100 and change_1h < 1e9));

comment on column public.token_snapshots.mint_authority_disabled is 'Jupiter audit at scan time (null = unknown / not written: snapshot older than lab-v2).';
comment on column public.token_snapshots.freeze_authority_disabled is 'Jupiter audit at scan time (null = unknown).';
comment on column public.token_snapshots.top10_pct is 'Jupiter top 10 holders at scan time, PERCENT (null = unknown).';
comment on column public.token_snapshots.insiders_detected is 'RugCheck insiders known at scan time (null = unknown).';
comment on column public.token_snapshots.roundtrip_cost_pct is 'Fresh Jupiter round-trip cost known at scan time, PERCENT (null = unknown).';
comment on column public.token_snapshots.change_1h is 'DexScreener 1 h price change at scan time, PERCENT (null = unknown).';

-- Event scanner keyset (captured_at, id), chronological.
create index token_snapshots_time_id_idx on public.token_snapshots (captured_at, id);

-- ---------------------------------------------------------------------------
-- 2. ohlcv_candles: candles captured for the backtest events
-- ---------------------------------------------------------------------------
alter table public.ohlcv_candles drop constraint ohlcv_candles_source_check;
alter table public.ohlcv_candles add constraint ohlcv_candles_source_check
  check (source in ('signal_outcomes', 'preset_signals', 'backtest_events'));
comment on column public.ohlcv_candles.source is
  'Table of the originating detection (signal_outcomes = scan, preset_signals = preset match, backtest_events = event of the backtest).';

-- Gauge (backfill_progress): candles written in the last 24 h.
create index ohlcv_candles_fetched_idx on public.ohlcv_candles (fetched_at);

-- ---------------------------------------------------------------------------
-- 3. backtest_events
-- ---------------------------------------------------------------------------
create table public.backtest_events (
  id                 bigint generated always as identity primary key,
  preset             text not null check (preset in ('momentum', 'young_24h', 'young_3h', 'post_migration', 'narrative_leader')),
  mint               text not null check (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- Pool whose candles are captured (the token's best pair known when the event is recorded).
  pool               text not null check (pool ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  event_at           timestamptz not null,
  -- token_snapshots.id of the entry snapshot (no foreign key: snapshots are purged after 3 days, events kept 30).
  entry_snapshot_id  bigint not null check (entry_snapshot_id > 0),
  price_at_event     numeric not null check (price_at_event > 0 and price_at_event < 1e12),
  mc                 numeric check (mc is null or (mc >= 0 and mc < 1e15)),
  -- liquidity_usd of the snapshot (no historical effective liquidity).
  liquidity          numeric check (liquidity is null or (liquidity >= 0 and liquidity < 1e13)),
  narrative          text check (narrative is null or char_length(narrative) between 1 and 24),
  pair_age_h         real check (pair_age_h is null or (pair_age_h >= -1 and pair_age_h < 1e6)),
  roundtrip_known    boolean not null,
  -- Round-trip cost known at the event (PERCENT), null = unknown (the simulation then charges the 3 % default).
  roundtrip_pct      numeric check (roundtrip_pct is null or (roundtrip_pct >= -100 and roundtrip_pct <= 100)),
  -- Values of the conditions at the event (numbers / booleans / fixed strings), bounded.
  conditions         jsonb not null default '{}'::jsonb
                     check (jsonb_typeof(conditions) = 'object' and pg_column_size(conditions) <= 4096),
  candles_1m_at      timestamptz,
  candles_5m_at      timestamptz,
  candles_attempts   smallint not null default 0 check (candles_attempts between 0 and 10000),
  created_at         timestamptz not null default now(),
  constraint backtest_events_preset_mint_key unique (preset, mint),
  constraint backtest_events_roundtrip_known check (roundtrip_known = (roundtrip_pct is not null)),
  constraint backtest_events_times check (created_at >= event_at - interval '1 day')
);

comment on table public.backtest_events is
  'Event backtest (lab-v2): first snapshot per (preset, mint) where the preset conditions became true, computed from point-in-time data only. Kept 30 days. Simulation only.';
comment on column public.backtest_events.candles_1m_at is 'Candle capture queue: 1-minute window due at (event + 6 h); null = captured or useless.';
comment on column public.backtest_events.candles_5m_at is 'Candle capture queue: 5-minute window due at (event + 72 h); null = captured or useless.';
comment on column public.backtest_events.candles_attempts is 'Candle capture attempts (failures included, 429 excluded).';

create index backtest_events_event_at_idx on public.backtest_events (event_at);
create index backtest_events_candles_1m_idx on public.backtest_events (candles_1m_at) where candles_1m_at is not null;
create index backtest_events_candles_5m_idx on public.backtest_events (candles_5m_at) where candles_5m_at is not null;

create function public.set_event_candle_checkpoint()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.event_at > now() - interval '30 days' then
    new.candles_1m_at := coalesce(new.candles_1m_at, new.event_at + interval '6 hours');
    new.candles_5m_at := coalesce(new.candles_5m_at, new.event_at + interval '72 hours');
  end if;
  return new;
end;
$$;

revoke execute on function public.set_event_candle_checkpoint() from public, anon, authenticated;

create trigger backtest_events_first_candle_checkpoint
  before insert on public.backtest_events
  for each row execute function public.set_event_candle_checkpoint();

-- ---------------------------------------------------------------------------
-- 4. backtest_event_state (service_role only)
-- ---------------------------------------------------------------------------
create table public.backtest_event_state (
  key         text primary key check (key = 'cursor' or key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  state       jsonb not null check (
                jsonb_typeof(state) = 'object'
                and pg_column_size(state) <= case when key = 'cursor' then 16384 else 32768 end
              ),
  -- Lease of the backtest-run call that owns the scanner (row 'cursor' only): a concurrent call skips the scan.
  locked_until timestamptz check (locked_until is null or key = 'cursor'),
  updated_at  timestamptz not null default now()
);

comment on table public.backtest_event_state is
  'Event scanner state of backtest-run (internal): key cursor = keyset position on token_snapshots (captured_at, id) + counters; key = mint → per-mint replay state (events.ts ReplayState). Stale mint rows purged after 7 days.';

create index backtest_event_state_updated_idx on public.backtest_event_state (updated_at);

-- ---------------------------------------------------------------------------
-- 5. 1-minute candles only for pairs younger than 48 h at detection
-- ---------------------------------------------------------------------------
-- Replaces the function of 20261119090000 (same name, same triggers). Unknown pair age → still requested.
create or replace function public.set_first_candle_checkpoint()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_created timestamptz;
begin
  if new.detected_at > now() - interval '30 days' then
    select t.pair_created_at into v_created from public.tokens t where t.mint = new.mint;
    if v_created is null or new.detected_at - v_created < interval '48 hours' then
      new.candles_1m_at := coalesce(new.candles_1m_at, new.detected_at + interval '6 hours');
    else
      new.candles_1m_at := null;
    end if;
    new.candles_5m_at := coalesce(new.candles_5m_at, new.detected_at + interval '72 hours');
  end if;
  return new;
end;
$$;

revoke execute on function public.set_first_candle_checkpoint() from public, anon, authenticated;

update public.signal_outcomes o
   set candles_1m_at = null
  from public.tokens t
 where t.mint = o.mint and o.candles_1m_at is not null
   and o.detected_at - t.pair_created_at >= interval '48 hours';
update public.preset_signals p
   set candles_1m_at = null
  from public.tokens t
 where t.mint = p.mint and p.candles_1m_at is not null
   and p.detected_at - t.pair_created_at >= interval '48 hours';

-- ---------------------------------------------------------------------------
-- 6. backtest_runs.summary, event presets in trades / results
-- ---------------------------------------------------------------------------
alter table public.backtest_runs
  add column summary jsonb
    constraint backtest_runs_summary_check check (summary is null or (jsonb_typeof(summary) = 'object' and pg_column_size(summary) <= 8192));
comment on column public.backtest_runs.summary is
  'Nightly summary (lab-v2 §3): { verdict none | candidate, text (French), run_at, n_detections, n_events, candidate? }.';

grant select (summary) on public.backtest_runs to authenticated;

-- Event rows: source backtest_events, detected_at = event_at, preset_flags = the single bit of the event preset
-- (backtest.ts PRESET_BIT: momentum 2, young_24h 4, young_3h 8, post_migration 32, narrative_leader 64). Detection rows
-- keep an odd bitset <= 31 (v1 rows of the last runs included; since lab-v2 only 1 or 17).
alter table public.backtest_trades drop constraint backtest_trades_source_check;
alter table public.backtest_trades add constraint backtest_trades_source_check
  check (source in ('signal_outcomes', 'preset_signals', 'backtest_events'));
alter table public.backtest_trades drop constraint backtest_trades_preset_flags_check;
alter table public.backtest_trades add constraint backtest_trades_preset_flags_check check (
  (source <> 'backtest_events' and preset_flags between 1 and 31 and preset_flags % 2 = 1)
  or (source = 'backtest_events' and preset_flags in (2, 4, 8, 32, 64))
);
alter table public.backtest_trades drop constraint backtest_trades_pkey;
alter table public.backtest_trades add constraint backtest_trades_pkey
  primary key (run_id, source, mint, detected_at, preset_flags);

alter table public.backtest_results drop constraint backtest_results_preset_check;
alter table public.backtest_results add constraint backtest_results_preset_check check (
  preset in ('all', 'mc_300k_1m', 'momentum', 'young_24h', 'young_3h', 'post_migration', 'narrative_leader')
);

-- Same signature, bits of the event presets accepted.
create or replace function public.backtest_trades_slice(
  p_run    bigint,
  p_bit    integer,
  p_lo     integer,
  p_hi     integer,
  p_offset integer,
  p_limit  integer
)
returns table (
  source       text,
  mint         text,
  detected_at  timestamptz,
  split        text,
  preset_flags smallint,
  narrative    text,
  returns      real[],
  open_at_end  text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_run is null or p_bit is null or p_bit not in (1, 2, 4, 8, 16, 32, 64) or p_lo is null or p_hi is null
     or p_lo < 0 or p_hi < p_lo or p_hi > 383 or p_offset is null or p_offset < 0
     or p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'backtest_trades_slice: invalid input' using errcode = '22023';
  end if;
  return query
    select t.source, t.mint, t.detected_at, t.split, t.preset_flags, t.narrative,
           t.returns[p_lo + 1 : p_hi + 1], t.open_at_end
      from public.backtest_trades t
     where t.run_id = p_run and (t.preset_flags & p_bit) <> 0
     order by t.detected_at, t.source, t.mint, t.preset_flags
    offset p_offset
     limit p_limit;
end;
$$;

revoke execute on function public.backtest_trades_slice(bigint, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.backtest_trades_slice(bigint, integer, integer, integer, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 7. label_runs: journal of label-outcomes (counts only)
-- ---------------------------------------------------------------------------
create table public.label_runs (
  id             bigint generated always as identity primary key,
  at             timestamptz not null default now(),
  -- GeckoTerminal requests made, of which answered 429 (the call stops at the first one).
  requests       smallint not null check (requests between 0 and 100),
  rate_limited   smallint not null check (rate_limited between 0 and 100),
  -- Queue rows written: labels + candle items done (captured, empty or already covered).
  rows_written   smallint not null check (rows_written between 0 and 100),
  labels         smallint not null check (labels between 0 and 100),
  candles        smallint not null check (candles between 0 and 100),
  failed         smallint not null check (failed between 0 and 100),
  queued         smallint not null check (queued between 0 and 100),
  ms             integer not null check (ms between 0 and 600000),
  constraint label_runs_rate_limited check (rate_limited <= requests),
  constraint label_runs_rows check (rows_written = labels + candles)
);

comment on table public.label_runs is 'label-outcomes journal (one row per call, counts only): measured hosted catch-up throughput. Purged after 7 days.';

create index label_runs_at_idx on public.label_runs (at);

-- ---------------------------------------------------------------------------
-- 8. Privileges and RLS of the new tables
-- ---------------------------------------------------------------------------
revoke all on public.backtest_events, public.backtest_event_state, public.label_runs from anon, authenticated;
grant select on public.backtest_events, public.label_runs to authenticated;

alter table public.backtest_events      enable row level security;
alter table public.backtest_event_state enable row level security;
alter table public.label_runs           enable row level security;

create policy "backtest events are readable by signed-in users"
  on public.backtest_events for select to authenticated using (true);
create policy "label runs are readable by signed-in users"
  on public.label_runs for select to authenticated using (true);
-- backtest_event_state: no policy (service_role only).

-- ---------------------------------------------------------------------------
-- 9. backfill_progress(): catch-up gauge of the Laboratoire
-- ---------------------------------------------------------------------------
-- Categories in queue priority order (label-outcomes):
--   1 preset_labels  2 event_candles (1 min)  3 scan_labels  4 candles_1m (scan + preset detections, pair < 48 h)
--   5 radar_labels   6 candles_5m (scan, preset and event windows, best effort)
-- Labels : total = rows detected between 14 days and 1 h ago (label-outcomes window); done = labelled at least once
--          (or final); due_now = pending with a reached checkpoint (or never labelled without checkpoint); last_24h =
--          rows whose labelled_at is in the last 24 h.
-- Candles: total = windows already complete (detection / event + 6 h for 1 min, + 72 h for 5 min) within the 30-day
--          retention (1 min of detections: pair < 48 h or unknown at detection); done = queue column null (captured,
--          empty or abandoned); due_now = queue column <= now; last_24h = ohlcv_candles rows fetched in the last 24 h.
-- rows_per_hour = rows written by label-outcomes (label_runs) over the last 6 h (over the covered span when the journal
-- is younger than 6 h, at least 30 min); eta_hours = rows due now / rows_per_hour (per category: cumulative in priority
-- order). Returns one jsonb object: { categories: [...], rows_per_hour, eta_hours, eta_at, due_now, measured_hours,
-- runs_6h, requests_6h, rate_limited_6h, generated_at }.
create function public.backfill_progress()
returns jsonb
language plpgsql
stable
-- invoker: the caller's RLS applies (every table read here is SELECT-able by authenticated today).
security invoker
set search_path = ''
as $$
declare
  v_now      timestamptz := now();
  v_rows     bigint;
  v_runs     bigint;
  v_req      bigint;
  v_429      bigint;
  v_oldest   timestamptz;
  v_hours    numeric;
  v_rate     numeric;
  v_cats     jsonb;
  v_due      bigint;
begin
  select coalesce(sum(r.rows_written), 0), count(*), coalesce(sum(r.requests), 0), coalesce(sum(r.rate_limited), 0), min(r.at)
    into v_rows, v_runs, v_req, v_429, v_oldest
    from public.label_runs r
   where r.at > v_now - interval '6 hours';
  if v_runs = 0 then
    v_rate := null;
    v_hours := 0;
  else
    v_hours := least(6, greatest(0.5, extract(epoch from (v_now - v_oldest)) / 3600.0));
    v_rate := round(v_rows / v_hours, 1);
  end if;

  with labels as (
    select 'preset_labels'::text as category, 1 as priority, p.status, p.labelled_at, p.next_label_at, p.detected_at
      from public.preset_signals p
    union all
    select 'scan_labels', 3, o.status, o.labelled_at, o.next_label_at, o.detected_at from public.signal_outcomes o
    union all
    select 'radar_labels', 5, e.status, e.labelled_at, e.next_label_at, e.detected_at from public.early_outcomes e
  ),
  label_stats as (
    select l.category, l.priority,
           count(*) filter (where l.status = 'final' or l.labelled_at is not null) as done,
           count(*) as total,
           count(*) filter (where l.status = 'pending'
                              and (l.next_label_at <= v_now or (l.next_label_at is null and l.labelled_at is null))) as due_now,
           count(*) filter (where l.labelled_at > v_now - interval '24 hours') as last_24h
      from labels l
     where l.detected_at <= v_now - interval '1 hour' and l.detected_at >= v_now - interval '14 days'
     group by l.category, l.priority
  ),
  det_1m as (
    select d.detected_at, d.candles_1m_at
      from (select o.mint, o.detected_at, o.candles_1m_at from public.signal_outcomes o
            union all
            select p.mint, p.detected_at, p.candles_1m_at from public.preset_signals p) d
      left join public.tokens t on t.mint = d.mint
     where d.detected_at > v_now - interval '30 days'
       and d.detected_at + interval '6 hours' <= v_now
       and (t.pair_created_at is null or d.detected_at - t.pair_created_at < interval '48 hours')
  ),
  win_5m as (
    select o.candles_5m_at from public.signal_outcomes o
     where o.detected_at > v_now - interval '30 days' and o.detected_at + interval '72 hours' <= v_now
    union all
    select p.candles_5m_at from public.preset_signals p
     where p.detected_at > v_now - interval '30 days' and p.detected_at + interval '72 hours' <= v_now
    union all
    select e.candles_5m_at from public.backtest_events e
     where e.event_at > v_now - interval '30 days' and e.event_at + interval '72 hours' <= v_now
  ),
  fetched as (
    select count(*) filter (where c.source = 'backtest_events' and c.tf = '1m') as ev_1m,
           count(*) filter (where c.source <> 'backtest_events' and c.tf = '1m') as det_1m,
           count(*) filter (where c.tf = '5m') as all_5m
      from public.ohlcv_candles c
     where c.fetched_at > v_now - interval '24 hours'
  ),
  candle_stats as (
    select 'event_candles'::text as category, 2 as priority,
           count(*) filter (where e.candles_1m_at is null) as done, count(*) as total,
           count(*) filter (where e.candles_1m_at <= v_now) as due_now,
           (select f.ev_1m from fetched f) as last_24h
      from public.backtest_events e
     where e.event_at > v_now - interval '30 days' and e.event_at + interval '6 hours' <= v_now
    union all
    select 'candles_1m', 4,
           count(*) filter (where d.candles_1m_at is null), count(*),
           count(*) filter (where d.candles_1m_at <= v_now),
           (select f.det_1m from fetched f)
      from det_1m d
    union all
    select 'candles_5m', 6,
           count(*) filter (where w.candles_5m_at is null), count(*),
           count(*) filter (where w.candles_5m_at <= v_now),
           (select f.all_5m from fetched f)
      from win_5m w
  ),
  cats as (
    select s.category, s.priority, s.done, s.total, s.due_now, s.last_24h from label_stats s
    union all
    select c.category, c.priority, c.done, c.total, c.due_now, c.last_24h from candle_stats c
  ),
  all_cats as (
    -- Every category, even without rows.
    select k.category, k.priority,
           coalesce(c.done, 0) as done, coalesce(c.total, 0) as total, coalesce(c.due_now, 0) as due_now,
           coalesce(c.last_24h, 0) as last_24h
      from (values ('preset_labels', 1), ('event_candles', 2), ('scan_labels', 3), ('candles_1m', 4),
                   ('radar_labels', 5), ('candles_5m', 6)) as k(category, priority)
      left join cats c on c.category = k.category
  ),
  cumul as (
    select a.*, sum(a.due_now) over (order by a.priority) as due_cumul from all_cats a
  )
  select jsonb_agg(
           jsonb_build_object(
             'category', u.category,
             'priority', u.priority,
             'done', u.done,
             'total', u.total,
             'due_now', u.due_now,
             'last_24h', u.last_24h,
             'eta_hours', case when u.due_cumul = 0 then 0
                               when v_rate is null or v_rate <= 0 then null
                               else round(u.due_cumul / v_rate, 1) end
           ) order by u.priority),
         coalesce(sum(u.due_now), 0)
    into v_cats, v_due
    from cumul u;

  return jsonb_build_object(
    'categories', coalesce(v_cats, '[]'::jsonb),
    'due_now', v_due,
    'rows_per_hour', v_rate,
    'eta_hours', case when v_due = 0 then 0 when v_rate is null or v_rate <= 0 then null else round(v_due / v_rate, 1) end,
    'eta_at', case when v_due = 0 then v_now when v_rate is null or v_rate <= 0 then null
                   else v_now + make_interval(secs => (v_due / v_rate) * 3600) end,
    'measured_hours', round(v_hours, 2),
    'runs_6h', v_runs,
    'requests_6h', v_req,
    'rate_limited_6h', v_429,
    'generated_at', v_now
  );
end;
$$;

comment on function public.backfill_progress() is
  'Laboratoire catch-up gauge (aggregates only): per category done / total / due_now / last_24h in queue priority order, measured label-outcomes throughput over 6 h and ETA.';

revoke execute on function public.backfill_progress() from public, anon, authenticated;
grant execute on function public.backfill_progress() to authenticated;
