-- fix/lab-priority-exploratory (docs/contracts/lab-v2.md §1 and §2 « Exploratoire »). SIMULATION ONLY.
--
-- What changes
--   backfill_progress()    : categories renumbered to the new label-outcomes queue order (GeckoTerminal is the
--                            bottleneck; _shared/candle-queue.ts WORK_PRIORITY):
--                              1 candles_1m (scan + preset detections, pair < 48 h)  2 event_candles (1 min)
--                              3 preset_labels  4 scan_labels  5 radar_labels  6 candles_5m (last)
--                            The cumulative ETA follows that order. Same body otherwise; still security invoker,
--                            stable, search_path = '', EXECUTE for authenticated only.
--   backtest_events.preset : + 'momentum_explo', 'young_24h_explo', 'young_3h_explo' = EXPLORATORY event presets
--                            (Momentum / Jeune & fort criteria WITHOUT the top 10 requirement). Inserted ONCE by
--                            scripts/explo-events.ts from the snapshots stored at that time (service role through the
--                            CLI); the live event scanner of backtest-run never produces them (events.ts EVENT_PRESETS
--                            unchanged). Their 1-minute candles go through the normal queue (event candles, rank 2):
--                            the insert trigger sets candles_1m_at / candles_5m_at as for any event.
--   backtest_trades        : event rows may carry the exploratory bits 128 / 256 / 512 (backtest.ts PRESET_BIT).
--   backtest_results       : exploratory presets accepted; + exploratory boolean GENERATED from preset (stored, cannot
--                            disagree with it; read by the Laboratoire; the worker never writes it). Exploratory rows
--                            may be retained / robust but are never a candidate (buildRunSummary ignores them).
--   backtest_trades_slice(): bits 128 / 256 / 512 accepted.
--
-- Security
--   No new table, no new policy, no grant change: backtest_results keeps its table-level SELECT for authenticated (the
--   new column is covered), writes stay service_role only. Functions replaced with the same signature, attributes and
--   grants (re-stated below, idempotent). Nothing in alerting (presets.ts, notify.ts, scan-tokens) reads these presets.

-- ---------------------------------------------------------------------------
-- 1. Exploratory presets
-- ---------------------------------------------------------------------------
alter table public.backtest_events drop constraint backtest_events_preset_check;
alter table public.backtest_events add constraint backtest_events_preset_check check (
  preset in ('momentum', 'young_24h', 'young_3h', 'post_migration', 'narrative_leader',
             'momentum_explo', 'young_24h_explo', 'young_3h_explo')
);
comment on column public.backtest_events.preset is
  'Event preset. *_explo = exploratory (Momentum / Jeune & fort without the top 10 requirement), inserted once by scripts/explo-events.ts, never by the live scanner, never a candidate.';

alter table public.backtest_trades drop constraint backtest_trades_preset_flags_check;
alter table public.backtest_trades add constraint backtest_trades_preset_flags_check check (
  (source <> 'backtest_events' and preset_flags between 1 and 31 and preset_flags % 2 = 1)
  or (source = 'backtest_events' and preset_flags in (2, 4, 8, 32, 64, 128, 256, 512))
);

alter table public.backtest_results drop constraint backtest_results_preset_check;
alter table public.backtest_results add constraint backtest_results_preset_check check (
  preset in ('all', 'mc_300k_1m', 'momentum', 'young_24h', 'young_3h', 'post_migration', 'narrative_leader',
             'momentum_explo', 'young_24h_explo', 'young_3h_explo')
);
alter table public.backtest_results
  add column exploratory boolean
    generated always as (preset in ('momentum_explo', 'young_24h_explo', 'young_3h_explo')) stored;
comment on column public.backtest_results.exploratory is
  'true for the exploratory presets (*_explo, no top 10 requirement): shown apart, never a candidate. Derived from preset.';

-- Same signature, exploratory bits accepted.
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
  if p_run is null or p_bit is null or p_bit not in (1, 2, 4, 8, 16, 32, 64, 128, 256, 512) or p_lo is null or p_hi is null
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
-- 2. backfill_progress(): new queue order
-- ---------------------------------------------------------------------------
-- Categories in queue priority order (label-outcomes, fix/lab-priority-exploratory):
--   1 candles_1m (scan + preset detections, pair < 48 h)  2 event_candles (1 min, exploratory events included)
--   3 preset_labels  4 scan_labels  5 radar_labels  6 candles_5m (scan, preset and event windows, best effort)
-- Definitions of done / total / due_now / last_24h, rows_per_hour and eta unchanged (see 20261119100000_lab_v2.sql);
-- eta_hours per category = rows due now in this category and every category before it / rows_per_hour.
create or replace function public.backfill_progress()
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
    select 'preset_labels'::text as category, 3 as priority, p.status, p.labelled_at, p.next_label_at, p.detected_at
      from public.preset_signals p
    union all
    select 'scan_labels', 4, o.status, o.labelled_at, o.next_label_at, o.detected_at from public.signal_outcomes o
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
    select 'candles_1m', 1,
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
      from (values ('candles_1m', 1), ('event_candles', 2), ('preset_labels', 3), ('scan_labels', 4),
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