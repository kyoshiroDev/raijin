-- feat/strategy-lab, part B — candle storage and backtest laboratory (docs/contracts/strategy-lab.md §B).
-- SIMULATION ONLY: replays of past detections on stored candles; no wallet, no key, no signature, no transaction.
--
-- What changes
--   ohlcv_candles          : ONE compact row per (detection window, timeframe): parallel arrays ts / o / h / l / c / v
--                            (ts = offsets in seconds from ts_start; GeckoTerminal gaps kept as they are). Written by
--                            label-outcomes (1m / 5m capture queue) and by scripts/candle-catchup.ts (backlog, 15m
--                            seed), purged after 30 days (supabase/sql/schedule_backtest.sql).
--   ohlcv_candles_flat     : readable view, one row per candle (unnest), security_invoker (RLS of the caller applies).
--   signal_outcomes /      : capture queue columns candles_1m_at (detection + 6 h), candles_5m_at (detection + 72 h),
--   preset_signals           candles_attempts. null = captured or useless. Set on insert by a BEFORE INSERT trigger
--                            (same pattern as set_first_label_checkpoint), backfilled for the detections < 30 days.
--                            The radar (early_outcomes) is NOT covered (GeckoTerminal budget).
--   backtest_runs          : one run of the laboratory (queued → running → done | failed), worker state in cursor.
--   backtest_trades        : per run and detection, the net return of each of the 384 strategy combinations
--                            (intermediate, kept for the last 3 runs by backtest-run).
--   backtest_results       : per run, metrics per variant × preset × narrative × split.
--   backtest_request_run() : authenticated RPC, queues a 'manual' run unless one is queued / running or the last one
--                            started < 10 min ago (French error, errcode 23514).
--   backtest_enqueue_nightly(): pg_cron 03:40, queues a 'nightly' run unless one is queued / running (same lock).
--   backtest_trades_slice()  : service_role read of a run's trades with only a slice of returns (aggregation chunks).
--
-- Security
--   Every new table: RLS enabled, SELECT policy for authenticated only, no insert / update / delete policy (writes are
--   service_role only: label-outcomes, backtest-run, local scripts through the CLI). Supabase default privileges grant
--   ALL on new tables, so everything is revoked from anon and authenticated first, then SELECT is granted back to
--   authenticated (same pattern as 20261119070000). The view is security_invoker (it reads ohlcv_candles with the
--   caller's rights, i.e. its RLS) and gets the same privileges. New queue columns inherit the table grants
--   (SELECT for authenticated, writes service_role). backtest_request_run: security definer, search_path = '',
--   auth.uid() required, EXECUTE for authenticated only (revoked from public / anon). Trigger function: EXECUTE revoked
--   from public / anon / authenticated. backtest_enqueue_nightly (pg_cron 03:40): EXECUTE for service_role only
--   (pg_cron runs it as postgres, the owner). backtest_trades_slice: security invoker, search_path = '', EXECUTE for
--   service_role only, inputs bounded.
-- Units: *_pct are PERCENT; *_sol for a 0.1 SOL stake; prices in USD.
-- Upper bounds also reject 'Infinity' / 'NaN' (NaN sorts above every number in Postgres).

-- ---------------------------------------------------------------------------
-- 1. ohlcv_candles (compact) + flat view
-- ---------------------------------------------------------------------------
create table public.ohlcv_candles (
  id           bigint generated always as identity primary key,
  mint         text not null check (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  pool         text not null check (pool ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  tf           text not null check (tf in ('1m', '5m', '15m')),
  ts_start     timestamptz not null,
  step_s       integer not null check (step_s in (60, 300, 900)),
  ts           integer[] not null,
  o            real[] not null,
  h            real[] not null,
  l            real[] not null,
  c            real[] not null,
  v            real[] not null,
  source       text not null check (source in ('signal_outcomes', 'preset_signals')),
  detected_at  timestamptz not null,
  fetched_at   timestamptz not null default now(),

  constraint ohlcv_candles_mint_tf_start_key unique (mint, tf, ts_start),
  constraint ohlcv_candles_tf_step check (
    (tf = '1m' and step_s = 60) or (tf = '5m' and step_s = 300) or (tf = '15m' and step_s = 900)
  ),
  -- One-dimensional arrays of the same length, 1..1000 candles (1m: 360, 5m: 864, 15m seed: <= 673).
  constraint ohlcv_candles_lengths check (
    array_ndims(ts) = 1 and cardinality(ts) between 1 and 1000
    and cardinality(o) = cardinality(ts) and cardinality(h) = cardinality(ts) and cardinality(l) = cardinality(ts)
    and cardinality(c) = cardinality(ts) and cardinality(v) = cardinality(ts)
    and array_ndims(o) = 1 and array_ndims(h) = 1 and array_ndims(l) = 1 and array_ndims(c) = 1 and array_ndims(v) = 1
  ),
  -- Offsets: the first candle opens at ts_start; every offset within 30 days (no NULL element: ALL would be NULL).
  constraint ohlcv_candles_offsets check (ts[1] = 0 and 0 <= all (ts) and 2592000 >= all (ts)),
  -- Prices strictly positive and finite, volumes >= 0 and finite (rejects NULL elements, NaN and Infinity).
  constraint ohlcv_candles_values check (
    0 < all (o) and 1e12 > all (o) and 0 < all (h) and 1e12 > all (h)
    and 0 < all (l) and 1e12 > all (l) and 0 < all (c) and 1e12 > all (c)
    and 0 <= all (v) and 1e15 > all (v)
  ),
  constraint ohlcv_candles_times check (
    fetched_at >= detected_at - interval '1 day' and ts_start >= detected_at - interval '8 days'
    and ts_start <= detected_at + interval '8 days'
  )
);

comment on table public.ohlcv_candles is
  'Compact candles (GeckoTerminal, USD price of the mint): one row per detection window and timeframe, parallel arrays. 1m: detection → +6 h, 5m: detection → +72 h, 15m: seed from the local label cache. Purged after 30 days.';
comment on column public.ohlcv_candles.ts is 'Offsets in seconds from ts_start (opening of each candle); GeckoTerminal gaps are kept.';
comment on column public.ohlcv_candles.source is 'Table of the originating detection (signal_outcomes = scan, preset_signals = preset match).';
comment on column public.ohlcv_candles.detected_at is 'detected_at of the originating detection.';

-- Purge (detected_at < now() - 30 days) and the backtest data version.
create index ohlcv_candles_detected_idx on public.ohlcv_candles (detected_at);

create view public.ohlcv_candles_flat
  with (security_invoker = true)
as
select oc.mint,
       oc.pool,
       oc.tf,
       oc.ts_start + make_interval(secs => u.off) as ts,
       u.o, u.h, u.l, u.c, u.v
  from public.ohlcv_candles oc
 cross join lateral unnest(oc.ts, oc.o, oc.h, oc.l, oc.c, oc.v) as u(off, o, h, l, c, v);

comment on view public.ohlcv_candles_flat is 'ohlcv_candles, one row per candle (readability only; security_invoker).';

-- ---------------------------------------------------------------------------
-- 2. Capture queue on the detections (signal_outcomes = scan, preset_signals = presets)
-- ---------------------------------------------------------------------------
alter table public.signal_outcomes
  add column candles_1m_at    timestamptz,
  add column candles_5m_at    timestamptz,
  add column candles_attempts smallint not null default 0
    constraint signal_outcomes_candles_attempts_check check (candles_attempts between 0 and 10000);
alter table public.preset_signals
  add column candles_1m_at    timestamptz,
  add column candles_5m_at    timestamptz,
  add column candles_attempts smallint not null default 0
    constraint preset_signals_candles_attempts_check check (candles_attempts between 0 and 10000);

comment on column public.signal_outcomes.candles_1m_at is 'Candle capture queue: 1-minute window due at (detection + 6 h); null = captured or useless.';
comment on column public.signal_outcomes.candles_5m_at is 'Candle capture queue: 5-minute window due at (detection + 72 h); null = captured or useless.';
comment on column public.signal_outcomes.candles_attempts is 'Candle capture attempts (failures included, 429 excluded).';
comment on column public.preset_signals.candles_1m_at is 'Candle capture queue: 1-minute window due at (detection + 6 h); null = captured or useless.';
comment on column public.preset_signals.candles_5m_at is 'Candle capture queue: 5-minute window due at (detection + 72 h); null = captured or useless.';
comment on column public.preset_signals.candles_attempts is 'Candle capture attempts (failures included, 429 excluded).';

-- Due times on insert (the inserters do not need to know about them). A detection older than the 30-day retention
-- gets none (its candles would be purged right away). Runs as the caller (service_role).
create function public.set_first_candle_checkpoint()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.detected_at > now() - interval '30 days' then
    new.candles_1m_at := coalesce(new.candles_1m_at, new.detected_at + interval '6 hours');
    new.candles_5m_at := coalesce(new.candles_5m_at, new.detected_at + interval '72 hours');
  end if;
  return new;
end;
$$;

revoke execute on function public.set_first_candle_checkpoint() from public, anon, authenticated;

create trigger signal_outcomes_first_candle_checkpoint
  before insert on public.signal_outcomes
  for each row execute function public.set_first_candle_checkpoint();
create trigger preset_signals_first_candle_checkpoint
  before insert on public.preset_signals
  for each row execute function public.set_first_candle_checkpoint();

-- Backfill: detections < 30 days get their due times (already past for most: the queue catches up oldest first,
-- the local script candle-catchup.ts takes the bulk).
update public.signal_outcomes
   set candles_1m_at = detected_at + interval '6 hours',
       candles_5m_at = detected_at + interval '72 hours'
 where detected_at > now() - interval '30 days';
update public.preset_signals
   set candles_1m_at = detected_at + interval '6 hours',
       candles_5m_at = detected_at + interval '72 hours'
 where detected_at > now() - interval '30 days';

-- label-outcomes capture queue: due rows, oldest due time first (one read per timeframe).
create index signal_outcomes_candles_1m_idx on public.signal_outcomes (candles_1m_at) where candles_1m_at is not null;
create index signal_outcomes_candles_5m_idx on public.signal_outcomes (candles_5m_at) where candles_5m_at is not null;
create index preset_signals_candles_1m_idx  on public.preset_signals  (candles_1m_at) where candles_1m_at is not null;
create index preset_signals_candles_5m_idx  on public.preset_signals  (candles_5m_at) where candles_5m_at is not null;

-- ---------------------------------------------------------------------------
-- 3. backtest_runs / backtest_trades / backtest_results
-- ---------------------------------------------------------------------------
create table public.backtest_runs (
  id                   bigint generated always as identity primary key,
  status               text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  requested_by         uuid references auth.users (id) on delete set null,
  trigger              text not null check (trigger in ('nightly', 'manual')),
  -- Grid announced in the report (exits, SL, breakeven, time exits, delays, presets, counts).
  params               jsonb not null default '{}'::jsonb
                       check (jsonb_typeof(params) = 'object' and pg_column_size(params) <= 16384),
  -- Data snapshot: detections, resolutions (1m / 5m / 15m only), train / test cutoff, max detected_at.
  data_version         jsonb check (data_version is null
                                    or (jsonb_typeof(data_version) = 'object' and pg_column_size(data_version) <= 16384)),
  n_detections         integer check (n_detections is null or n_detections between 0 and 10000000),
  n_variants           integer check (n_variants is null or n_variants between 0 and 100000),
  n_distinct_variants  integer check (n_distinct_variants is null or n_distinct_variants between 0 and 100000),
  progress             numeric not null default 0 check (progress >= 0 and progress <= 1),
  -- Worker state (backtest-run): phase, position in the detections / aggregation. Internal, bounded.
  cursor               jsonb check (cursor is null or (jsonb_typeof(cursor) = 'object' and pg_column_size(cursor) <= 4096)),
  -- Lease of the worker call that owns the run (a second concurrent call skips it).
  locked_until         timestamptz,
  error                text check (error is null or char_length(error) <= 500),
  created_at           timestamptz not null default now(),
  started_at           timestamptz,
  finished_at          timestamptz,
  constraint backtest_runs_manual_requester check (trigger = 'manual' or requested_by is null),
  constraint backtest_runs_status_columns check (
    case status
      when 'queued'  then started_at is null and finished_at is null
      when 'running' then started_at is not null and finished_at is null
      else started_at is not null and finished_at is not null
    end
  ),
  constraint backtest_runs_variants check (n_distinct_variants is null or n_variants is null or n_distinct_variants <= n_variants)
);

comment on table public.backtest_runs is
  'Strategy laboratory runs (backtest-run worker, every minute). Backtest ≠ future result: simulation on stored candles.';
comment on column public.backtest_runs.progress is 'Share of the run done (0..1): simulation then aggregation.';
comment on column public.backtest_runs.cursor is 'Worker state (internal): phase, last detection processed, aggregation step.';

create index backtest_runs_created_idx on public.backtest_runs (created_at desc);
create index backtest_runs_active_idx  on public.backtest_runs (created_at) where status in ('queued', 'running');

create table public.backtest_trades (
  run_id        bigint not null references public.backtest_runs (id) on delete cascade,
  source        text not null check (source in ('signal_outcomes', 'preset_signals')),
  mint          text not null check (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  detected_at   timestamptz not null,
  split         text not null check (split in ('train', 'test')),
  -- Presets of the grid matched AT DETECTION, bitset of backtest.ts PRESET_BIT: all = 1 (always set), momentum = 2,
  -- young_24h = 4, young_3h = 8, mc_300k_1m = 16.
  preset_flags  smallint not null check (preset_flags between 1 and 31 and preset_flags % 2 = 1),
  narrative     text not null check (narrative in ('gta', 'other')),
  -- Net return in PERCENT of the stake for each of the 384 combinations (backtest.ts COMBOS order, rounded to 4
  -- decimals); NULL element = no trade for that combination (no entry candle).
  returns       real[] not null check (array_ndims(returns) = 1 and cardinality(returns) = 384),
  -- open_at_end flags of the 384 combinations as a 96-hex-char bitset (backtest.ts encodeFlags).
  open_at_end   text check (open_at_end is null or open_at_end ~ '^[0-9a-f]{96}$'),
  constraint backtest_trades_pkey primary key (run_id, source, mint, detected_at)
);

comment on table public.backtest_trades is
  'Backtest intermediate: per run and detection, the net return (percent of the stake, fees included) of each of the 384 strategy combinations. Kept for the last 3 runs.';

-- Aggregation reads one run in chronological order.
create index backtest_trades_run_detected_idx on public.backtest_trades (run_id, detected_at);

create table public.backtest_results (
  run_id               bigint not null references public.backtest_runs (id) on delete cascade,
  preset               text not null check (preset in ('all', 'momentum', 'young_24h', 'young_3h', 'mc_300k_1m')),
  exit                 text not null check (exit in ('all_x2', 'half_x2_rest_x3', 'thirds_x2_x3_x4', 'all_x1_5')),
  sl_pct               smallint not null check (sl_pct between 1 and 90),
  breakeven            boolean not null,
  -- 0 = no time exit (backtest.ts null), else 1 / 6 / 24.
  time_exit_h          smallint not null check (time_exit_h between 0 and 168),
  delay_min            smallint not null check (delay_min between 0 and 60),
  narrative            text not null check (narrative in ('all', 'gta', 'other')),
  split                text not null check (split in ('train', 'test')),
  trades               integer not null check (trades between 0 and 10000000),
  win_rate             real check (win_rate is null or (win_rate >= 0 and win_rate <= 1)),
  avg_win_pct          real check (avg_win_pct is null or (avg_win_pct > -1e6 and avg_win_pct < 1e6)),
  avg_loss_pct         real check (avg_loss_pct is null or (avg_loss_pct > -1e6 and avg_loss_pct < 1e6)),
  avg_net_pct          real check (avg_net_pct is null or (avg_net_pct > -1e6 and avg_net_pct < 1e6)),
  avg_net_sol          real check (avg_net_sol is null or (avg_net_sol > -1e6 and avg_net_sol < 1e6)),
  -- null when there is no loss (infinite) or no trade.
  profit_factor        real check (profit_factor is null or (profit_factor >= 0 and profit_factor < 1e9)),
  max_drawdown_sol     real check (max_drawdown_sol is null or (max_drawdown_sol >= 0 and max_drawdown_sol < 1e9)),
  worst_losing_streak  integer check (worst_losing_streak is null or worst_losing_streak between 0 and 10000000),
  ci_low               real check (ci_low is null or (ci_low > -1e6 and ci_low < 1e6)),
  ci_high              real check (ci_high is null or (ci_high > -1e6 and ci_high < 1e6)),
  ci_contains_zero     boolean,
  open_at_end          integer not null default 0 check (open_at_end between 0 and 10000000),
  retained             boolean not null default false,
  robust               boolean not null default false,
  constraint backtest_results_pkey
    primary key (run_id, preset, exit, sl_pct, breakeven, time_exit_h, delay_min, narrative, split),
  constraint backtest_results_robust check (not robust or retained),
  constraint backtest_results_ci check (ci_low is null or ci_high is null or ci_low <= ci_high)
);

comment on table public.backtest_results is
  'Backtest metrics per variant (exit × SL × breakeven × time exit × delay) × preset × narrative × split (train = oldest 70 %, test = newest 30 %). retained = avg net > 0 in train AND test with >= 30 test trades; robust = retained AND 95 % bootstrap CI (test) excluding 0.';

-- Rows: the DISTINCT variants only (breakeven on a single-leg exit is not written): per run 5 presets × 288 × 3
-- narratives × 2 splits = 8 640 rows. retained / robust repeated on the train and test rows of a variant.
-- Laboratory screen: retained variants of a run, best test average first.
create index backtest_results_run_rank_idx on public.backtest_results (run_id, narrative, split, avg_net_pct desc)
  where retained;

-- Privileges (defense in depth, on top of RLS). service_role is left untouched.
revoke all on public.ohlcv_candles, public.ohlcv_candles_flat, public.backtest_runs, public.backtest_trades,
              public.backtest_results
  from anon, authenticated;
grant select on public.ohlcv_candles, public.ohlcv_candles_flat, public.backtest_trades, public.backtest_results
  to authenticated;
-- backtest_runs: column-level SELECT only. requested_by (another user's id), cursor / locked_until (worker internals)
-- and error (raw internal messages) stay service_role only.
grant select (id, status, trigger, params, data_version, n_detections, n_variants, n_distinct_variants, progress,
              created_at, started_at, finished_at)
  on public.backtest_runs to authenticated;

alter table public.ohlcv_candles    enable row level security;
alter table public.backtest_runs    enable row level security;
alter table public.backtest_trades  enable row level security;
alter table public.backtest_results enable row level security;

create policy "candles are readable by signed-in users"
  on public.ohlcv_candles for select to authenticated using (true);
create policy "backtest runs are readable by signed-in users"
  on public.backtest_runs for select to authenticated using (true);
create policy "backtest trades are readable by signed-in users"
  on public.backtest_trades for select to authenticated using (true);
create policy "backtest results are readable by signed-in users"
  on public.backtest_results for select to authenticated using (true);

-- No insert / update / delete policy: writes are service_role only (label-outcomes, backtest-run, purge cron,
-- local scripts through the CLI). Runs are queued by users only through backtest_request_run() below.

-- ---------------------------------------------------------------------------
-- 4. backtest_request_run(): queue a manual run
-- ---------------------------------------------------------------------------
create function public.backtest_request_run()
returns public.backtest_runs
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_last  timestamptz;
  v_row   public.backtest_runs;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  -- Serialise concurrent requests (and the nightly enqueue, which takes the same lock).
  perform pg_advisory_xact_lock(hashtextextended('raijin-backtest-request', 0));
  if exists (select 1 from public.backtest_runs r where r.status in ('queued', 'running')) then
    raise exception 'Un backtest est déjà en cours : attendez qu''il se termine avant d''en relancer un.'
      using errcode = '23514';
  end if;
  select max(r.started_at) into v_last from public.backtest_runs r;
  if v_last is not null and v_last > now() - interval '10 minutes' then
    raise exception 'Le dernier backtest a démarré il y a moins de 10 min : réessayez après %.',
      to_char((v_last + interval '10 minutes') at time zone 'Europe/Paris', 'HH24:MI')
      using errcode = '23514';
  end if;
  insert into public.backtest_runs (status, requested_by, trigger)
  values ('queued', v_uid, 'manual')
  returning * into v_row;
  return v_row;
end;
$$;

comment on function public.backtest_request_run() is
  'Queues a manual backtest run for the caller. Refused (23514, French message) while a run is queued / running or when the last run started less than 10 min ago.';

revoke execute on function public.backtest_request_run() from public, anon, authenticated;
grant execute on function public.backtest_request_run() to authenticated;

-- Nightly enqueue (pg_cron, supabase/sql/schedule_backtest.sql): same lock, no run added while one is queued /
-- running. service_role / postgres only.
create function public.backtest_enqueue_nightly()
returns bigint
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_id bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('raijin-backtest-request', 0));
  if exists (select 1 from public.backtest_runs r where r.status in ('queued', 'running')) then
    return null;
  end if;
  insert into public.backtest_runs (status, trigger) values ('queued', 'nightly') returning id into v_id;
  return v_id;
end;
$$;

comment on function public.backtest_enqueue_nightly() is 'pg_cron 03:40: queues a nightly backtest run unless one is queued / running.';

revoke execute on function public.backtest_enqueue_nightly() from public, anon, authenticated;
grant execute on function public.backtest_enqueue_nightly() to service_role;

-- ---------------------------------------------------------------------------
-- 5. backtest_trades_slice(): aggregation reads of backtest-run (service_role only). One page of the run's trades
--    whose preset_flags contain p_bit, chronological, with ONLY the returns slice [p_lo, p_hi] (0-based combo
--    indexes, SQL returns[p_lo + 1 : p_hi + 1]): the worker parses ~1/6 of the 384 values per chunk. open_at_end is
--    returned whole (96 hex chars, sliced by backtest.ts parseTradeRow). Bounded: p_limit 1..1000.
-- ---------------------------------------------------------------------------
create function public.backtest_trades_slice(
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
  if p_run is null or p_bit is null or p_bit not in (1, 2, 4, 8, 16) or p_lo is null or p_hi is null
     or p_lo < 0 or p_hi < p_lo or p_hi > 383 or p_offset is null or p_offset < 0
     or p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'backtest_trades_slice: invalid input' using errcode = '22023';
  end if;
  return query
    select t.source, t.mint, t.detected_at, t.split, t.preset_flags, t.narrative,
           t.returns[p_lo + 1 : p_hi + 1], t.open_at_end
      from public.backtest_trades t
     where t.run_id = p_run and (t.preset_flags & p_bit) <> 0
     order by t.detected_at, t.source, t.mint
    offset p_offset
     limit p_limit;
end;
$$;

comment on function public.backtest_trades_slice(bigint, integer, integer, integer, integer, integer) is
  'backtest-run (service_role): one chronological page of a run''s trades for a preset bit, returns sliced to [p_lo, p_hi].';

revoke execute on function public.backtest_trades_slice(bigint, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.backtest_trades_slice(bigint, integer, integer, integer, integer, integer) to service_role;
