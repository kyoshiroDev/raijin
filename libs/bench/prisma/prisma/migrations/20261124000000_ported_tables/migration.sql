-- Tables portées de Supabase (docs/BENCH.md §4–§5), schéma `public` de raijin_bench.
-- Produit par rejeu des 29 migrations de legacy/supabase/migrations sur un Postgres 17 jetable, puis
-- transformation (libs/bench/prisma/README.md, « Origine du schéma ») et pg_dump --schema-only :
--   * 21 tables portées, 10 tables mortes et la vue ohlcv_candles_flat retirées (BENCH.md §8) ;
--   * colonnes archivées du 21/11 ni écrites ni lues retirées (P3) : tokens (score, zones, plan, ×3),
--     alert_log.entry_score/entry_zone, 10 colonnes de alert_settings ; celles encore lues sont gardées ;
--   * RLS, policies, grants et publication Realtime retirés (garde applicative, BENCH.md §6) ;
--   * auth.users → public.bench_owner (compte unique, P2), auth.uid() → public.bench_owner_id() ;
--   * fonctions et déclencheurs conservés en SQL, corps identiques (P5), sauf claim_test_push (Redis).
-- NOT VALID conservé sur alert_log_single_has_plan (lignes historiques antérieures à la contrainte).
SET check_function_bodies = false;


--
-- Name: apply_alert_tracking(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_alert_tracking(p_rows jsonb) RETURNS TABLE(id bigint, first_hit text)
    LANGUAGE sql
    SET search_path TO ''
    AS $$
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

--
-- Name: backfill_progress(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.backfill_progress() RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
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
     where p.preset in ('young_calm', 'young_frenzy')
    union all
    select 'scan_labels', 4, o.status, o.labelled_at, o.next_label_at, o.detected_at from public.signal_outcomes o
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
            select p.mint, p.detected_at, p.candles_1m_at from public.preset_signals p
             where p.preset in ('young_calm', 'young_frenzy')) d
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
     where p.preset in ('young_calm', 'young_frenzy')
       and p.detected_at > v_now - interval '30 days' and p.detected_at + interval '72 hours' <= v_now
    union all
    select e.candles_5m_at from public.backtest_events e
     where e.preset in ('young_calm_ev', 'young_frenzy_ev')
       and e.event_at > v_now - interval '30 days' and e.event_at + interval '72 hours' <= v_now
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
     where e.preset in ('young_calm_ev', 'young_frenzy_ev')
       and e.event_at > v_now - interval '30 days' and e.event_at + interval '6 hours' <= v_now
    union all
    select 'candles_1m', 1,
           count(*) filter (where d.candles_1m_at is null), count(*),
           count(*) filter (where d.candles_1m_at <= v_now),
           (select f.det_1m from fetched f)
      from det_1m d
    union all
    select 'candles_5m', 5,
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
                   ('candles_5m', 5)) as k(category, priority)
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

--
-- Name: backtest_enqueue_nightly(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.backtest_enqueue_nightly() RETURNS bigint
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
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

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: backtest_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backtest_runs (
    id bigint NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    requested_by uuid,
    trigger text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    data_version jsonb,
    n_detections integer,
    n_variants integer,
    n_distinct_variants integer,
    progress numeric DEFAULT 0 NOT NULL,
    cursor jsonb,
    locked_until timestamp with time zone,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    summary jsonb,
    CONSTRAINT backtest_runs_cursor_check CHECK (((cursor IS NULL) OR ((jsonb_typeof(cursor) = 'object'::text) AND (pg_column_size(cursor) <= 4096)))),
    CONSTRAINT backtest_runs_data_version_check CHECK (((data_version IS NULL) OR ((jsonb_typeof(data_version) = 'object'::text) AND (pg_column_size(data_version) <= 16384)))),
    CONSTRAINT backtest_runs_error_check CHECK (((error IS NULL) OR (char_length(error) <= 500))),
    CONSTRAINT backtest_runs_manual_requester CHECK (((trigger = 'manual'::text) OR (requested_by IS NULL))),
    CONSTRAINT backtest_runs_n_detections_check CHECK (((n_detections IS NULL) OR ((n_detections >= 0) AND (n_detections <= 10000000)))),
    CONSTRAINT backtest_runs_n_distinct_variants_check CHECK (((n_distinct_variants IS NULL) OR ((n_distinct_variants >= 0) AND (n_distinct_variants <= 100000)))),
    CONSTRAINT backtest_runs_n_variants_check CHECK (((n_variants IS NULL) OR ((n_variants >= 0) AND (n_variants <= 100000)))),
    CONSTRAINT backtest_runs_params_check CHECK (((jsonb_typeof(params) = 'object'::text) AND (pg_column_size(params) <= 16384))),
    CONSTRAINT backtest_runs_progress_check CHECK (((progress >= (0)::numeric) AND (progress <= (1)::numeric))),
    CONSTRAINT backtest_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'done'::text, 'failed'::text]))),
    CONSTRAINT backtest_runs_status_columns CHECK (
CASE status
    WHEN 'queued'::text THEN ((started_at IS NULL) AND (finished_at IS NULL))
    WHEN 'running'::text THEN ((started_at IS NOT NULL) AND (finished_at IS NULL))
    ELSE ((started_at IS NOT NULL) AND (finished_at IS NOT NULL))
END),
    CONSTRAINT backtest_runs_summary_check CHECK (((summary IS NULL) OR ((jsonb_typeof(summary) = 'object'::text) AND (pg_column_size(summary) <= 8192)))),
    CONSTRAINT backtest_runs_trigger_check CHECK ((trigger = ANY (ARRAY['nightly'::text, 'manual'::text]))),
    CONSTRAINT backtest_runs_variants CHECK (((n_distinct_variants IS NULL) OR (n_variants IS NULL) OR (n_distinct_variants <= n_variants)))
);

--
-- Name: backtest_request_run(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.backtest_request_run() RETURNS public.backtest_runs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_uid   uuid := public.bench_owner_id();
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

--
-- Name: backtest_trades_slice(bigint, integer, integer, integer, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.backtest_trades_slice(p_run bigint, p_bit integer, p_lo integer, p_hi integer, p_offset integer, p_limit integer) RETURNS TABLE(source text, mint text, detected_at timestamp with time zone, split text, preset_flags smallint, narrative text, returns real[], open_at_end text)
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
begin
  if p_run is null or p_bit is null
     or p_bit not in (1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192)
     or p_lo is null or p_hi is null
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

--
-- Name: bench_owner_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bench_owner_id() RETURNS uuid
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$ select o.id from public.bench_owner o where o.singleton $$;

--
-- Name: enforce_push_subscription_cap(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_push_subscription_cap() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if (select count(*) from public.push_subscriptions where user_id = new.user_id) >= 10 then
    raise exception 'too many push subscriptions' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

--
-- Name: paper_apply_v2(uuid, text, jsonb, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.paper_apply_v2(p_position uuid, p_expected text, p_step jsonb, p_delta numeric) RETURNS numeric
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_kind     text;
  v_user     uuid;
  v_book     text;
  v_status   text;
  v_balance  numeric;
  v_new      numeric;
  v_fee      numeric;
  v_fill     numeric;
  v_pnl      numeric;
  v_closed   boolean;
  v_n        integer;
  v_m        integer;
  v_legs     integer;
  v_open     integer;
begin
  if p_position is null or p_expected is null or p_step is null or jsonb_typeof(p_step) <> 'object'
     or p_delta is null or p_delta = 'NaN'::numeric or abs(p_delta) >= 1e6 then
    raise exception 'paper_apply_v2: invalid input' using errcode = '22023';
  end if;
  v_kind := p_step ->> 'kind';
  if not ((p_expected = 'pending' and v_kind in ('fill', 'expire')) or (p_expected = 'open' and v_kind = 'legs')) then
    raise exception 'paper_apply_v2: invalid transition' using errcode = '22023';
  end if;
  v_fee := coalesce((p_step ->> 'fees_sol')::numeric, 0);
  if v_fee = 'NaN'::numeric or v_fee < 0 or v_fee >= 1 then
    raise exception 'paper_apply_v2: invalid fee' using errcode = '22023';
  end if;

  -- Shape + delta sign per kind (walletDelta): fill debits, expire is free, legs credit proceeds - exit fees.
  if v_kind = 'fill' then
    v_fill := (p_step ->> 'fill_price')::numeric;
    if v_fill is null or not (v_fill > 0 and v_fill < 1e12) or p_delta >= 0
       or jsonb_typeof(p_step -> 'legs') is distinct from 'array' then
      raise exception 'paper_apply_v2: invalid fill' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_to_recordset(p_step -> 'legs') as x(id uuid, tp_price numeric, stop_price numeric)
                where x.id is null or x.tp_price is null or x.stop_price is null
                   or not (x.tp_price > 0 and x.tp_price < 1e12) or not (x.stop_price > 0 and x.stop_price < 1e12)) then
      raise exception 'paper_apply_v2: invalid fill legs' using errcode = '22023';
    end if;
  elsif v_kind = 'expire' then
    if p_delta <> 0 then
      raise exception 'paper_apply_v2: delta inconsistent with transition' using errcode = '22023';
    end if;
  else
    if jsonb_typeof(p_step -> 'closes') is distinct from 'array' or jsonb_typeof(p_step -> 'moves') is distinct from 'array'
       or jsonb_typeof(p_step -> 'position_closed') is distinct from 'boolean' then
      raise exception 'paper_apply_v2: invalid legs step' using errcode = '22023';
    end if;
    v_closed := (p_step ->> 'position_closed')::boolean;
    v_n := jsonb_array_length(p_step -> 'closes');
    v_m := jsonb_array_length(p_step -> 'moves');
    if v_n = 0 and v_m = 0 then
      raise exception 'paper_apply_v2: empty legs step' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_to_recordset(p_step -> 'closes') as x(id uuid, status text, exit_price numeric)
                where x.id is null or x.status is null or x.status not in ('tp_hit', 'sl_hit', 'breakeven_hit')
                   or x.exit_price is null or not (x.exit_price > 0 and x.exit_price < 1e12))
       or (select count(distinct x.id) from jsonb_to_recordset(p_step -> 'closes') as x(id uuid)) <> v_n then
      raise exception 'paper_apply_v2: invalid closes' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_to_recordset(p_step -> 'moves') as x(id uuid, stop_price numeric)
                where x.id is null or x.stop_price is null or not (x.stop_price > 0 and x.stop_price < 1e12)) then
      raise exception 'paper_apply_v2: invalid moves' using errcode = '22023';
    end if;
    -- No close → no money moves; closes → proceeds (>= 0) - exit fees, so the delta is at least -fees.
    if (v_n = 0 and (p_delta <> 0 or v_fee <> 0 or v_closed)) or (v_n > 0 and p_delta < -v_fee) then
      raise exception 'paper_apply_v2: delta inconsistent with transition' using errcode = '22023';
    end if;
    if v_closed then
      v_pnl := (p_step ->> 'pnl_sol')::numeric;
      if v_pnl is null or v_pnl = 'NaN'::numeric or abs(v_pnl) >= 1e6 then
        raise exception 'paper_apply_v2: invalid pnl' using errcode = '22023';
      end if;
    end if;
  end if;

  select p.user_id, p.book into v_user, v_book from public.paper_positions p where p.id = p_position;
  if not found then
    return null;
  end if;

  -- Wallet first (same lock order as open / reset), then the position row.
  insert into public.paper_wallets (user_id, book) values (v_user, v_book) on conflict (user_id, book) do nothing;
  select w.balance_sol into v_balance from public.paper_wallets w
   where w.user_id = v_user and w.book = v_book for update;
  select p.status into v_status from public.paper_positions p where p.id = p_position for update;
  if v_status is distinct from p_expected then
    return null; -- already applied by another run, cancelled, reset or expired: idempotent no-op
  end if;
  v_new := v_balance + p_delta;
  if v_new < 0 or v_new >= 1e6 then
    return null;
  end if;

  if v_kind = 'fill' then
    select count(*) into v_legs from public.paper_legs l where l.position_id = p_position;
    if jsonb_array_length(p_step -> 'legs') <> v_legs then
      raise exception 'paper_apply_v2: fill legs do not match the position' using errcode = '22023';
    end if;
    update public.paper_legs l
       set tp_price = x.tp_price, stop_price = x.stop_price
      from jsonb_to_recordset(p_step -> 'legs') as x(id uuid, tp_price numeric, stop_price numeric)
     where l.id = x.id and l.position_id = p_position and l.status = 'open';
    get diagnostics v_n = row_count;
    if v_n <> v_legs then
      raise exception 'paper_apply_v2: fill legs do not match the position' using errcode = '22023';
    end if;
    update public.paper_positions p
       set status = 'open', filled_at = now(), fill_price = v_fill, fees_sol = coalesce(p.fees_sol, 0) + v_fee
     where p.id = p_position;

  elsif v_kind = 'expire' then
    update public.paper_positions p set status = 'expired', closed_at = now() where p.id = p_position;

  else
    -- Every closing leg must still be open (a replay finds them closed → no-op, nothing written yet).
    if v_n > 0 and (
      select count(*) from public.paper_legs l
       where l.position_id = p_position and l.status = 'open'
         and l.id in (select x.id from jsonb_to_recordset(p_step -> 'closes') as x(id uuid))
    ) <> v_n then
      return null;
    end if;
    perform 1 from public.paper_legs l where l.position_id = p_position order by l.id for update;
    update public.paper_legs l
       set status = x.status, exit_price = x.exit_price, closed_at = now()
      from jsonb_to_recordset(p_step -> 'closes') as x(id uuid, status text, exit_price numeric)
     where l.id = x.id and l.position_id = p_position and l.status = 'open';
    update public.paper_legs l
       set stop_price = x.stop_price
      from jsonb_to_recordset(p_step -> 'moves') as x(id uuid, stop_price numeric)
     where l.id = x.id and l.position_id = p_position and l.status = 'open';
    select count(*) into v_open from public.paper_legs l where l.position_id = p_position and l.status = 'open';
    if v_closed <> (v_open = 0) then
      raise exception 'paper_apply_v2: position_closed inconsistent with the legs' using errcode = '22023';
    end if;
    update public.paper_positions p
       set status    = case when v_closed then 'closed' else 'open' end,
           closed_at = case when v_closed then now() else null end,
           pnl_sol   = case when v_closed then v_pnl else null end,
           fees_sol  = case when v_fee > 0 then coalesce(p.fees_sol, 0) + v_fee else p.fees_sol end
     where p.id = p_position;
  end if;

  if p_delta <> 0 then
    update public.paper_wallets set balance_sol = v_new where user_id = v_user and book = v_book;
  end if;
  return v_new;
end;
$$;

--
-- Name: paper_book_comparison(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.paper_book_comparison() RETURNS TABLE(book text, trades integer, tp_hits integer, sl_hits integer, tp_pct numeric, sl_pct numeric, pnl_sol numeric, max_drawdown_sol numeric, max_drawdown_pct numeric, worst_losing_streak integer, open_positions integer, target_trades integer, balance_sol numeric, initial_sol numeric, since timestamp with time zone)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  with books(book, ord) as (
    values ('calm_sl30', 1), ('calm_sl40', 2), ('frenzy_sl30', 3)
  ),
  w as (
    select w.book, w.balance_sol, w.initial_sol, w.reset_at
      from public.paper_wallets w
     where w.user_id = (select public.bench_owner_id())
       and w.book in ('calm_sl30', 'calm_sl40', 'frenzy_sl30')
  ),
  -- The caller's positions of the test books since the book's last reset (a reset restarts the test).
  pos as (
    select p.book, p.id, p.status, p.pnl_sol, p.closed_at,
           exists (select 1 from public.paper_legs l
                    where l.position_id = p.id and l.user_id = p.user_id and l.status = 'tp_hit') as is_tp,
           exists (select 1 from public.paper_legs l
                    where l.position_id = p.id and l.user_id = p.user_id and l.status = 'sl_hit') as is_sl
      from public.paper_positions p
      left join w on w.book = p.book
     where p.user_id = (select public.bench_owner_id())
       and p.book in ('calm_sl30', 'calm_sl40', 'frenzy_sl30')
       and (w.reset_at is null or p.created_at > w.reset_at)
  ),
  closed as (
    select c.book, c.id, c.pnl_sol, c.closed_at, c.is_tp, c.is_sl,
           sum(c.pnl_sol) over (partition by c.book order by c.closed_at, c.id
                                rows between unbounded preceding and current row) as cum,
           row_number() over (partition by c.book order by c.closed_at, c.id) as rn,
           row_number() over (partition by c.book, (c.pnl_sol < 0) order by c.closed_at, c.id) as rn_flag
      from pos c
     where c.status = 'closed' and c.pnl_sol is not null
  ),
  curve as (
    select k.book, k.pnl_sol, k.is_tp, k.is_sl, k.cum,
           greatest(0, max(k.cum) over (partition by k.book order by k.closed_at, k.id
                                        rows between unbounded preceding and current row)) as peak
      from closed k
  ),
  agg as (
    select c.book,
           count(*)::integer as trades,
           count(*) filter (where c.is_tp)::integer as tp,
           count(*) filter (where c.is_sl)::integer as sl,
           sum(c.pnl_sol) as pnl,
           max(c.peak - c.cum) as dd_sol,
           max((c.peak - c.cum) / nullif(coalesce(w.initial_sol, 1.0) + c.peak, 0)) * 100 as dd_pct
      from curve c
      left join w on w.book = c.book
     group by c.book
  ),
  streak as (
    select s.book, max(s.len)::integer as worst
      from (select x.book, count(*) as len
              from closed x
             where x.pnl_sol < 0
             group by x.book, x.rn - x.rn_flag) s
     group by s.book
  ),
  live as (
    select o.book, count(*)::integer as open
      from pos o
     where o.status in ('pending', 'open')
     group by o.book
  )
  select b.book,
         coalesce(a.trades, 0),
         coalesce(a.tp, 0),
         coalesce(a.sl, 0),
         case when coalesce(a.trades, 0) > 0 then round(100.0 * a.tp / a.trades, 1) end,
         case when coalesce(a.trades, 0) > 0 then round(100.0 * a.sl / a.trades, 1) end,
         round(coalesce(a.pnl, 0), 6),
         round(coalesce(a.dd_sol, 0), 6),
         round(coalesce(a.dd_pct, 0), 2),
         coalesce(st.worst, 0),
         coalesce(lv.open, 0),
         50,
         w.balance_sol,
         coalesce(w.initial_sol, 1.0),
         w.reset_at
    from books b
    left join agg a on a.book = b.book
    left join streak st on st.book = b.book
    left join live lv on lv.book = b.book
    left join w on w.book = b.book
   order by b.ord;
$$;

--
-- Name: paper_cancel_position(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.paper_cancel_position(p_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_uid uuid := public.bench_owner_id();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  update public.paper_positions
     set status = 'cancelled', closed_at = now()
   where id = p_id and user_id = v_uid and status = 'pending' and book = 'main';
  return found;
end;
$$;

--
-- Name: paper_wallets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.paper_wallets (
    user_id uuid DEFAULT public.bench_owner_id() NOT NULL,
    balance_sol numeric DEFAULT 1.0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reset_at timestamp with time zone,
    book text DEFAULT 'main'::text NOT NULL,
    initial_sol numeric DEFAULT 1.0 NOT NULL,
    CONSTRAINT paper_wallets_balance_sol_check CHECK (((balance_sol >= (0)::numeric) AND (balance_sol < '1000000'::numeric))),
    CONSTRAINT paper_wallets_book_check CHECK ((book = ANY (ARRAY['main'::text, 'half_x2_rest_x3'::text, 'all_x2'::text, 'young_all_x2'::text, 'young_half_x2_rest_x3'::text, 'young_thirds_x2_x3_x4'::text, 'calm_all_x2'::text, 'frenzy_all_x2'::text, 'calm_sl30'::text, 'calm_sl40'::text, 'frenzy_sl30'::text]))),
    CONSTRAINT paper_wallets_initial_check CHECK (((initial_sol >= 0.01) AND (initial_sol <= (1000)::numeric)))
);

--
-- Name: paper_ensure_wallet(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.paper_ensure_wallet(p_book text DEFAULT 'main'::text) RETURNS public.paper_wallets
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_uid uuid := public.bench_owner_id();
  v_row public.paper_wallets;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_book is null or p_book not in ('main', 'calm_sl30', 'calm_sl40', 'frenzy_sl30') then
    raise exception 'paper wallet: invalid book' using errcode = '22023';
  end if;
  insert into public.paper_wallets (user_id, book) values (v_uid, p_book) on conflict (user_id, book) do nothing;
  select * into v_row from public.paper_wallets where user_id = v_uid and book = p_book;
  return v_row;
end;
$$;

--
-- Name: paper_positions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.paper_positions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid DEFAULT public.bench_owner_id() NOT NULL,
    book text DEFAULT 'main'::text NOT NULL,
    mint text NOT NULL,
    symbol text NOT NULL,
    strategy text NOT NULL,
    stake_sol numeric NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    alert_id bigint,
    status text DEFAULT 'pending'::text NOT NULL,
    entry_target_price numeric NOT NULL,
    fill_price numeric,
    sl_price numeric NOT NULL,
    custom_tp_price numeric,
    sl_pct numeric DEFAULT 30 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    filled_at timestamp with time zone,
    closed_at timestamp with time zone,
    pnl_sol numeric,
    fees_sol numeric,
    entry_mode text DEFAULT 'target'::text NOT NULL,
    cancel_reason text,
    CONSTRAINT paper_positions_book_check CHECK ((book = ANY (ARRAY['main'::text, 'half_x2_rest_x3'::text, 'all_x2'::text, 'young_all_x2'::text, 'young_half_x2_rest_x3'::text, 'young_thirds_x2_x3_x4'::text, 'calm_all_x2'::text, 'frenzy_all_x2'::text, 'calm_sl30'::text, 'calm_sl40'::text, 'frenzy_sl30'::text]))),
    CONSTRAINT paper_positions_cancel_reason_check CHECK (((cancel_reason IS NULL) OR (cancel_reason = 'slim_down'::text))),
    CONSTRAINT paper_positions_cancel_reason_status CHECK (((cancel_reason IS NULL) OR (status = 'cancelled'::text))),
    CONSTRAINT paper_positions_custom_tp CHECK (((strategy = 'custom'::text) = (custom_tp_price IS NOT NULL))),
    CONSTRAINT paper_positions_custom_tp_price_check CHECK (((custom_tp_price IS NULL) OR ((custom_tp_price > (0)::numeric) AND (custom_tp_price < '1000000000000'::numeric)))),
    CONSTRAINT paper_positions_entry_mode_check CHECK ((entry_mode = ANY (ARRAY['target'::text, 'next_tick'::text]))),
    CONSTRAINT paper_positions_entry_target_price_check CHECK (((entry_target_price > (0)::numeric) AND (entry_target_price < '1000000000000'::numeric))),
    CONSTRAINT paper_positions_expiry CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '25:00:00'::interval)))),
    CONSTRAINT paper_positions_fees_sol_check CHECK (((fees_sol IS NULL) OR ((fees_sol >= (0)::numeric) AND (fees_sol < (1)::numeric)))),
    CONSTRAINT paper_positions_fill_price_check CHECK (((fill_price IS NULL) OR ((fill_price > (0)::numeric) AND (fill_price < '1000000000000'::numeric)))),
    CONSTRAINT paper_positions_levels CHECK (((custom_tp_price IS NULL) OR (sl_price < custom_tp_price))),
    CONSTRAINT paper_positions_mint_check CHECK ((mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text)),
    CONSTRAINT paper_positions_pnl_sol_check CHECK (((pnl_sol IS NULL) OR ((pnl_sol > '-1000000'::numeric) AND (pnl_sol < '1000000'::numeric)))),
    CONSTRAINT paper_positions_sl_pct_check CHECK (((sl_pct >= (1)::numeric) AND (sl_pct <= (90)::numeric))),
    CONSTRAINT paper_positions_sl_price_check CHECK (((sl_price > (0)::numeric) AND (sl_price < '1000000000000'::numeric))),
    CONSTRAINT paper_positions_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'auto_alert'::text]))),
    CONSTRAINT paper_positions_stake_sol_check CHECK (((stake_sol >= 0.001) AND (stake_sol <= (100)::numeric))),
    CONSTRAINT paper_positions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'open'::text, 'closed'::text, 'cancelled'::text, 'expired'::text]))),
    CONSTRAINT paper_positions_status_columns CHECK (
CASE status
    WHEN 'pending'::text THEN ((filled_at IS NULL) AND (fill_price IS NULL) AND (closed_at IS NULL) AND (pnl_sol IS NULL))
    WHEN 'open'::text THEN ((filled_at IS NOT NULL) AND (fill_price IS NOT NULL) AND (closed_at IS NULL) AND (pnl_sol IS NULL))
    WHEN 'closed'::text THEN ((filled_at IS NOT NULL) AND (fill_price IS NOT NULL) AND (closed_at IS NOT NULL) AND (pnl_sol IS NOT NULL))
    WHEN 'expired'::text THEN ((filled_at IS NULL) AND (fill_price IS NULL) AND (closed_at IS NOT NULL) AND (pnl_sol IS NULL))
    ELSE ((closed_at IS NOT NULL) AND (pnl_sol IS NULL))
END),
    CONSTRAINT paper_positions_strategy_check CHECK ((strategy = ANY (ARRAY['half_x2_rest_x3'::text, 'all_x2'::text, 'thirds_x2_x3_x4'::text, 'custom'::text]))),
    CONSTRAINT paper_positions_symbol_check CHECK ((((char_length(symbol) >= 1) AND (char_length(symbol) <= 32)) AND (symbol !~ '[\u0001-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\uFFF9-\uFFFB<>]'::text)))
);

--
-- Name: paper_open_position(text, text, numeric, numeric, numeric, numeric, numeric, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.paper_open_position(p_mint text, p_strategy text, p_stake numeric, p_entry numeric, p_sl_pct numeric DEFAULT 30, p_custom_tp numeric DEFAULT NULL::numeric, p_custom_sl numeric DEFAULT NULL::numeric, p_book text DEFAULT 'main'::text) RETURNS public.paper_positions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_uid uuid := public.bench_owner_id();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_book is not null and p_book <> 'main' then
    raise exception 'paper position: invalid book' using errcode = '22023';
  end if;
  if p_strategy is null or p_strategy <> 'all_x2' then
    raise exception 'paper position: invalid strategy' using errcode = '22023';
  end if;
  return public.paper_open_position_as(
    v_uid, 'main', p_mint, 'all_x2', p_stake, p_entry, p_sl_pct, p_custom_tp, p_custom_sl, 'manual', null
  );
end;
$$;

--
-- Name: paper_open_position_as(uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, text, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.paper_open_position_as(p_user uuid, p_book text, p_mint text, p_strategy text, p_stake numeric, p_entry numeric, p_sl_pct numeric, p_custom_tp numeric, p_custom_sl numeric, p_source text, p_alert_id bigint, p_entry_mode text DEFAULT 'target'::text) RETURNS public.paper_positions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  v_row       public.paper_positions;
  v_symbol    text;
  v_balance   numeric;
  v_committed numeric;
  v_active    integer;
  v_recent    integer;
  v_sl_pct    numeric;
  v_sl        numeric;
  v_last_stop timestamptz;
  v_mode      text := coalesce(p_entry_mode, 'target');
  v_test_book boolean := p_book in ('calm_sl30', 'calm_sl40', 'frenzy_sl30');
  -- Keep in sync with paper.ts: NETWORK_FEE_PER_TX_SOL + TOKEN_ACCOUNT_RENT_SOL (reservedSol).
  c_overhead  constant numeric := 0.0002 + 0.00204;
begin
  if p_user is null then
    raise exception 'paper position: user required' using errcode = '23502';
  end if;
  -- feat/calm-sl-test: calm_all_x2 / frenzy_all_x2 archived; chore/slim-down archived the other books.
  if p_book is null or p_book not in ('main', 'calm_sl30', 'calm_sl40', 'frenzy_sl30') then
    raise exception 'paper position: invalid book' using errcode = '22023';
  end if;
  -- chore/slim-down: all_x2 is the only strategy (half_x2_rest_x3, thirds_x2_x3_x4 and custom archived).
  if p_strategy is null or p_strategy <> 'all_x2' then
    raise exception 'paper position: invalid strategy' using errcode = '22023';
  end if;
  if p_source is null or p_source not in ('manual', 'auto_alert') then
    raise exception 'paper position: invalid source' using errcode = '22023';
  end if;
  if v_mode not in ('target', 'next_tick') then
    raise exception 'paper position: invalid entry mode' using errcode = '22023';
  end if;
  -- next_tick has no meaningful entry target (filled at the next scan snapshot): auto-paper only.
  if v_mode = 'next_tick' and p_source <> 'auto_alert' then
    raise exception 'paper position: invalid entry mode' using errcode = '22023';
  end if;
  -- Test books: ONE fixed recipe per book (all_x2, auto-paper, market entry at the next scan, 0.1 SOL, the book's stop),
  -- so the three books differ by their stop / preset only.
  if v_test_book and (
       p_source <> 'auto_alert' or v_mode <> 'next_tick' or p_stake is distinct from 0.1
       or coalesce(p_sl_pct, 30) <> (case p_book when 'calm_sl40' then 40 else 30 end)
     ) then
    raise exception 'paper position: invalid book' using errcode = '22023';
  end if;
  if p_mint is null or p_mint !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then
    raise exception 'paper position: invalid mint' using errcode = '22023';
  end if;
  if p_stake is null or not (p_stake >= 0.001 and p_stake <= 100) then
    raise exception 'paper position: invalid stake (0.001-100 SOL)' using errcode = '22023';
  end if;
  if p_entry is null or not (p_entry > 0 and p_entry < 1e12) then
    raise exception 'paper position: invalid entry price' using errcode = '22023';
  end if;
  -- custom levels are not accepted any more (strategy all_x2 only).
  if p_custom_tp is not null or p_custom_sl is not null then
    raise exception 'paper position: invalid strategy' using errcode = '22023';
  end if;

  v_sl_pct := coalesce(p_sl_pct, 30);
  if not (v_sl_pct >= 1 and v_sl_pct <= 90) then
    raise exception 'paper position: invalid stop-loss percent (1-90)' using errcode = '22023';
  end if;
  v_sl := p_entry * (1 - v_sl_pct / 100);
  -- The ×2 TP must stay storable.
  if p_entry * 2 >= 1e12 then
    raise exception 'paper position: invalid entry price' using errcode = '22023';
  end if;

  -- Auto-paper link: the alert must be one of THIS user's single alerts on THIS mint.
  if p_alert_id is not null then
    if p_source <> 'auto_alert' or not exists (
      select 1 from public.alert_log a
       where a.id = p_alert_id and a.user_id = p_user and a.mint = p_mint and a.kind = 'single'
    ) then
      raise exception 'paper position: invalid alert' using errcode = '22023';
    end if;
  end if;

  select t.symbol into v_symbol from public.tokens t where t.mint = p_mint;
  if not found then
    raise exception 'paper position: unknown token' using errcode = '23503';
  end if;

  -- Per-user mutex, wallet of the book created at 1.0 SOL if missing, then EVERY wallet of the user locked in book
  -- order (see 20261118020000): concurrent opens are serialised, caps and balance cannot be overrun.
  perform pg_advisory_xact_lock(hashtextextended('raijin-paper:' || p_user::text, 0));
  insert into public.paper_wallets (user_id, book) values (p_user, p_book) on conflict (user_id, book) do nothing;
  perform 1 from public.paper_wallets w where w.user_id = p_user order by w.book for update;

  -- Test books: no stacking — no new position while one is pending / open on this mint in this book.
  if v_test_book and exists (
    select 1 from public.paper_positions p
     where p.user_id = p_user and p.book = p_book and p.mint = p_mint and p.status in ('pending', 'open')
  ) then
    raise exception 'paper position: already active in this book' using errcode = '23505';
  end if;

  -- 12 h cooldown after a stop on this mint: in the same book for the test books, any book for main.
  select max(l.closed_at) into v_last_stop
    from public.paper_legs l
    join public.paper_positions p on p.id = l.position_id and p.user_id = l.user_id
   where l.user_id = p_user
     and l.status = 'sl_hit'
     and l.closed_at > now() - interval '12 hours'
     and p.mint = p_mint
     and (not v_test_book or p.book = p_book);
  if v_last_stop is not null then
    raise exception 'Stop touché il y a moins de 12 h sur ce token : pas de nouvelle position avant %.',
      to_char((v_last_stop + interval '12 hours') at time zone 'Europe/Paris', 'HH24:MI')
      using errcode = '23514';
  end if;

  select w.balance_sol into v_balance from public.paper_wallets w where w.user_id = p_user and w.book = p_book;

  select count(*) filter (where p.status in ('pending', 'open')),
         count(*) filter (where p.created_at > now() - interval '24 hours'),
         coalesce(sum(p.stake_sol + c_overhead) filter (where p.status = 'pending' and p.book = p_book), 0)
    into v_active, v_recent, v_committed
    from public.paper_positions p
   where p.user_id = p_user
     and (p.status in ('pending', 'open') or p.created_at > now() - interval '24 hours');

  if v_active >= 50 then
    raise exception 'paper position: too many active positions (max 50)' using errcode = '23514';
  end if;
  if v_recent >= 200 then
    raise exception 'paper position: too many positions in 24 h (max 200)' using errcode = '23514';
  end if;
  if v_balance - v_committed - (p_stake + c_overhead) < 0 then
    raise exception 'paper position: insufficient paper balance' using errcode = '23514';
  end if;

  insert into public.paper_positions (
    user_id, book, mint, symbol, strategy, stake_sol, source, alert_id, status, entry_target_price, sl_price,
    custom_tp_price, sl_pct, expires_at, created_at, entry_mode
  ) values (
    p_user, p_book, p_mint, v_symbol, 'all_x2', p_stake, p_source, p_alert_id, 'pending', p_entry, v_sl,
    null, v_sl_pct, now() + interval '24 hours', now(), v_mode
  )
  returning * into v_row;

  -- Mirror of paper.ts planLegs('all_x2'): one 100 % leg, TP ×2, SL −sl_pct.
  insert into public.paper_legs (position_id, user_id, size_pct, tp_price, stop_price)
  values (v_row.id, p_user, 100, p_entry * 2, v_sl);
  return v_row;
end;
$_$;

--
-- Name: paper_positions_before_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.paper_positions_before_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_symbol text;
begin
  select t.symbol into v_symbol from public.tokens t where t.mint = new.mint;
  if not found then
    raise exception 'paper position: unknown token' using errcode = '23503';
  end if;
  new.symbol := v_symbol;
  return new;
end;
$$;

--
-- Name: paper_reset_wallet(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.paper_reset_wallet(p_book text DEFAULT 'main'::text) RETURNS public.paper_wallets
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_uid uuid := public.bench_owner_id();
  v_row public.paper_wallets;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_book is null or p_book not in ('main', 'calm_sl30', 'calm_sl40', 'frenzy_sl30') then
    raise exception 'paper wallet: invalid book' using errcode = '22023';
  end if;
  insert into public.paper_wallets (user_id, book) values (v_uid, p_book) on conflict (user_id, book) do nothing;
  update public.paper_wallets
     set balance_sol = initial_sol, reset_at = now()
   where user_id = v_uid and book = p_book
  returning * into v_row;
  update public.paper_positions
     set status = 'cancelled', closed_at = now()
   where user_id = v_uid and book = p_book and status in ('pending', 'open');
  return v_row;
end;
$$;

--
-- Name: performance_breakdown(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.performance_breakdown() RETURNS TABLE(source text, dimension text, bucket text, n integer, n_final integer, x2 integer, x3 integer, x2_before_sl30 integer, sl30_before_x2 integer, dd50_first integer, median_max_multiple numeric)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  with base as (
    select 'scan'::text as src, coalesce(o.entry_dex_id, t.dex_id) as dex, o.entry_mc as mc,
           o.entry_liq_eff as liq, o.status, o.hit_x2, o.hit_x3, o.x2_before_sl30, o.sl30_before_x2, o.dd50_first,
           o.max_multiple_7d, o.observed_hours
      from public.signal_outcomes o
      left join public.tokens t on t.mint = o.mint
    union all
    select 'preset:' || p.preset, p.entry_dex_id, p.entry_mc, p.entry_liq_eff, p.status, p.hit_x2,
           p.hit_x3, p.x2_before_sl30, p.sl30_before_x2, p.dd50_first, p.max_multiple_7d, p.observed_hours
      from public.preset_signals p
     where p.preset in ('young_calm', 'young_frenzy')
  ),
  labelled as (
    select b.*
      from base b
     where b.max_multiple_7d > 0
       and (b.x2_before_sl30 is true or b.sl30_before_x2 is true or b.observed_hours >= 12)
  ),
  dims as (
    select l.*, d.dimension, d.bucket
      from labelled l
     cross join lateral (values
       ('all', 'all'),
       ('dex', case
                 when l.dex is null then null
                 when l.dex = 'pumpswap' then 'pumpswap'
                 when l.dex = 'pumpfun' then 'pumpfun'
                 when l.dex like 'raydium%' then 'raydium'
                 when l.dex like 'meteora%' then 'meteora'
                 when l.dex like 'orca%' then 'orca'
                 else 'other'
               end),
       ('mc', case
                when l.mc is null then null
                when l.mc < 50000 then '<50k'
                when l.mc < 100000 then '50k-100k'
                when l.mc <= 1000000 then '100k-1M'
                else '>1M'
              end),
       ('liq', case
                 when l.liq is null then null
                 when l.liq < 10000 then '<10k'
                 when l.liq < 20000 then '10k-20k'
                 when l.liq < 50000 then '20k-50k'
                 else '>=50k'
               end)
     ) as d(dimension, bucket)
     where d.bucket is not null
  )
  select src,
         dims.dimension,
         dims.bucket,
         count(*)::integer,
         count(*) filter (where dims.status = 'final')::integer,
         count(*) filter (where dims.hit_x2 is true)::integer,
         count(*) filter (where dims.hit_x3 is true)::integer,
         count(*) filter (where dims.x2_before_sl30 is true)::integer,
         count(*) filter (where dims.sl30_before_x2 is true)::integer,
         count(*) filter (where dims.dd50_first is true)::integer,
         round((percentile_cont(0.5) within group (order by dims.max_multiple_7d::double precision))::numeric, 4)
    from dims
   group by src, dims.dimension, dims.bucket
   order by src, dims.dimension, dims.bucket;
$$;

--
-- Name: performance_by_preset(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.performance_by_preset() RETURNS TABLE(preset text, segment text, signals integer, labelled integer, x2_before_sl30 integer, sl30_before_x2 integer, sim_pnl_sol numeric, trades integer, paper_pnl_sol numeric, paper_open integer)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  with grid as (
    select g.preset, g.segment, g.p_ord, g.s_ord
      from (values
        ('young_calm', 'all', 1, 1), ('young_calm', 'gta', 1, 2), ('young_calm', 'other', 1, 3),
        ('young_frenzy', 'all', 2, 1), ('young_frenzy', 'gta', 2, 2), ('young_frenzy', 'other', 2, 3)
      ) as g(preset, segment, p_ord, s_ord)
  ),
  sig as (
    select s.preset, seg.segment, s.x2_before_sl30 as x2, s.sl30_before_x2 as sl, s.entry_roundtrip_pct as rt
      from public.preset_signals s
     cross join lateral (values ('all'), (case when s.narrative = 'GTA' then 'gta' else 'other' end)) as seg(segment)
     where s.preset in ('young_calm', 'young_frenzy')
  ),
  sig_agg as (
    select sig.preset, sig.segment,
           count(*)::integer as signals,
           count(*) filter (where sig.x2 is not null)::integer as labelled,
           count(*) filter (where sig.x2 is true)::integer as x2,
           count(*) filter (where sig.sl is true)::integer as sl,
           coalesce(sum(
             (case when sig.x2 is true then 0.1 when sig.sl is true then -0.03 else 0 end)
             - 0.1 * coalesce(sig.rt, 0) / 100
           ) filter (where sig.x2 is not null), 0)::numeric as sim
      from sig
     group by sig.preset, sig.segment
  ),
  pos as (
    select case p.book when 'calm_all_x2' then 'young_calm' else 'young_frenzy' end as preset,
           seg.segment, p.status, p.pnl_sol
      from public.paper_positions p
      left join public.tokens t on t.mint = p.mint
     cross join lateral (values ('all'), (case when t.narrative = 'GTA' then 'gta' else 'other' end)) as seg(segment)
     where p.book in ('calm_all_x2', 'frenzy_all_x2')
  ),
  pos_agg as (
    select pos.preset, pos.segment,
           count(*) filter (where pos.status = 'closed')::integer as trades,
           coalesce(sum(pos.pnl_sol) filter (where pos.status = 'closed'), 0)::numeric as pnl,
           count(*) filter (where pos.status in ('pending', 'open'))::integer as open
      from pos
     group by pos.preset, pos.segment
  )
  select g.preset,
         g.segment,
         coalesce(s.signals, 0),
         coalesce(s.labelled, 0),
         coalesce(s.x2, 0),
         coalesce(s.sl, 0),
         coalesce(s.sim, 0),
         coalesce(p.trades, 0),
         coalesce(p.pnl, 0),
         coalesce(p.open, 0)
    from grid g
    left join sig_agg s on s.preset = g.preset and s.segment = g.segment
    left join pos_agg p on p.preset = g.preset and p.segment = g.segment
   order by g.p_ord, g.s_ord;
$$;

--
-- Name: set_event_candle_checkpoint(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_event_candle_checkpoint() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.event_at > now() - interval '30 days' then
    new.candles_1m_at := coalesce(new.candles_1m_at, new.event_at + interval '6 hours');
    new.candles_5m_at := coalesce(new.candles_5m_at, new.event_at + interval '72 hours');
  end if;
  return new;
end;
$$;

--
-- Name: set_first_candle_checkpoint(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_first_candle_checkpoint() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
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

--
-- Name: set_first_label_checkpoint(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_first_label_checkpoint() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  new.next_label_at := coalesce(new.next_label_at, new.detected_at + interval '12 hours');
  return new;
end;
$$;

--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;

--
-- Name: wallet_study_claim(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wallet_study_claim(p_lease_seconds integer) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_token uuid := gen_random_uuid();
  v_ok    boolean;
begin
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 300 then
    raise exception 'invalid lease';
  end if;
  update public.wallet_study_budget
     set lease_until = now() + make_interval(secs => p_lease_seconds), lease_token = v_token, updated_at = now()
   where id = 1 and (lease_until is null or lease_until < now())
  returning true into v_ok;
  return case when v_ok then v_token else null end;
end;
$$;

--
-- Name: wallet_study_queue(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wallet_study_queue(p_limit integer) RETURNS TABLE(mint text, pair_address text, pair_created_at timestamp with time zone, detected_at timestamp with time zone, is_new boolean)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  (select s.mint, s.pair_address, s.pair_created_at, s.detected_at, false
     from public.wallet_study_state s
    where s.status = 'pending'
    order by s.detected_at
    limit greatest(1, least(p_limit, 50)))
  union all
  (select o.mint, o.pair_address, t.pair_created_at, o.detected_at, true
     from public.signal_outcomes o
     left join public.tokens t on t.mint = o.mint
    where (o.status = 'final' or o.x2_before_sl30 is not null)
      and not exists (select 1 from public.wallet_study_state s where s.mint = o.mint)
    order by o.detected_at
    limit greatest(1, least(p_limit, 50)))
$$;

--
-- Name: wallet_study_refund(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wallet_study_refund(p_mint text, p_credits integer) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if p_credits is null or p_credits < 0 or p_credits > 10000 then
    raise exception 'invalid credit amount';
  end if;
  update public.wallet_study_budget
     set credits_used = greatest(credits_used - p_credits, 0), updated_at = now()
   where id = 1;
  update public.wallet_study_state
     set credits_used = greatest(credits_used - p_credits, 0), updated_at = now()
   where mint = p_mint;
end;
$$;

--
-- Name: wallet_study_release(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wallet_study_release(p_token uuid) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_ok boolean;
begin
  update public.wallet_study_budget
     set lease_until = null, lease_token = null, updated_at = now()
   where id = 1 and p_token is not null and lease_token = p_token
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

--
-- Name: wallet_study_reserve(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wallet_study_reserve(p_mint text, p_credits integer) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_ok boolean;
begin
  if p_credits is null or p_credits < 0 or p_credits > 10000 then
    raise exception 'invalid credit amount';
  end if;
  update public.wallet_study_budget
     set credits_used = credits_used + p_credits, updated_at = now()
   where id = 1 and credits_used + p_credits <= hard_cap
  returning true into v_ok;
  if v_ok is not true then
    return false;
  end if;
  update public.wallet_study_state
     set credits_used = least(credits_used + p_credits, 600000), updated_at = now()
   where mint = p_mint;
  return true;
end;
$$;

--
-- Name: x3_backfill_candidates(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.x3_backfill_candidates(p_limit integer) RETURNS TABLE(mint text, pair_address text, symbol text, name text, pair_created_at timestamp with time zone, insiders_detected boolean, creator_rug_history boolean, captured_at timestamp with time zone, price_usd numeric, market_cap numeric, liquidity_usd numeric, volume_24h numeric, score smallint, zone_status text, holder_count integer, volume_1h numeric, txns_1h integer, dex_id text, organic_score numeric)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
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

--
-- Name: x3_snapshot_history(text[], timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.x3_snapshot_history(p_mints text[], p_since timestamp with time zone) RETURNS TABLE(mint text, samples jsonb)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
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

--
-- Name: alert_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_log (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    mint text NOT NULL,
    notification_id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text DEFAULT 'single'::text NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    entry_price numeric,
    target_price numeric,
    stop_price numeric,
    rr numeric,
    entry_roundtrip_pct numeric,
    stake_sol numeric,
    max_price numeric,
    min_price numeric,
    last_price numeric,
    last_price_at timestamp with time zone,
    first_hit text,
    first_hit_at timestamp with time zone,
    followup_sent_at timestamp with time zone,
    tracking_until timestamp with time zone,
    preset text,
    CONSTRAINT alert_log_early_untracked CHECK (((kind <> 'early'::text) OR (tracking_until IS NULL))),
    CONSTRAINT alert_log_entry_price_check CHECK (((entry_price IS NULL) OR ((entry_price > (0)::numeric) AND (entry_price < '1000000000000'::numeric)))),
    CONSTRAINT alert_log_entry_roundtrip_pct_check CHECK (((entry_roundtrip_pct IS NULL) OR ((entry_roundtrip_pct >= ('-100'::integer)::numeric) AND (entry_roundtrip_pct <= (100)::numeric)))),
    CONSTRAINT alert_log_first_hit_check CHECK (((first_hit IS NULL) OR (first_hit = ANY (ARRAY['target'::text, 'stop'::text])))),
    CONSTRAINT alert_log_first_hit_pair CHECK (((first_hit IS NULL) = (first_hit_at IS NULL))),
    CONSTRAINT alert_log_kind_check CHECK ((kind = ANY (ARRAY['single'::text, 'grouped'::text, 'early'::text]))),
    CONSTRAINT alert_log_last_price_check CHECK (((last_price IS NULL) OR ((last_price >= (0)::numeric) AND (last_price < '1000000000000'::numeric)))),
    CONSTRAINT alert_log_max_price_check CHECK (((max_price IS NULL) OR ((max_price >= (0)::numeric) AND (max_price < '1000000000000'::numeric)))),
    CONSTRAINT alert_log_min_price_check CHECK (((min_price IS NULL) OR ((min_price >= (0)::numeric) AND (min_price < '1000000000000'::numeric)))),
    CONSTRAINT alert_log_mint_check CHECK ((mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text)),
    CONSTRAINT alert_log_plan_order CHECK (((entry_price IS NULL) OR (target_price IS NULL) OR (stop_price IS NULL) OR ((stop_price < entry_price) AND (entry_price < target_price)))),
    CONSTRAINT alert_log_preset_check CHECK (((preset IS NULL) OR (preset = ANY (ARRAY['young_calm'::text, 'momentum'::text, 'strict'::text, 'young_strong'::text])))),
    CONSTRAINT alert_log_rr_check CHECK (((rr IS NULL) OR ((rr >= (0)::numeric) AND (rr < '1000000'::numeric)))),
    CONSTRAINT alert_log_stake_sol_check CHECK (((stake_sol IS NULL) OR ((stake_sol >= 0.01) AND (stake_sol <= (100)::numeric)))),
    CONSTRAINT alert_log_stop_price_check CHECK (((stop_price IS NULL) OR ((stop_price > (0)::numeric) AND (stop_price < '1000000000000'::numeric)))),
    CONSTRAINT alert_log_target_price_check CHECK (((target_price IS NULL) OR ((target_price > (0)::numeric) AND (target_price < '1000000000000'::numeric)))),
    CONSTRAINT alert_log_tracking_window CHECK (((tracking_until IS NULL) OR (tracking_until <= (sent_at + '8 days'::interval))))
);

--
-- Name: alert_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.alert_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.alert_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: alert_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_settings (
    user_id uuid DEFAULT public.bench_owner_id() NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    hide_bonding_curve boolean DEFAULT true NOT NULL,
    quiet_start smallint DEFAULT 23 NOT NULL,
    quiet_end smallint DEFAULT 7 NOT NULL,
    max_per_hour smallint DEFAULT 4 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    stake_sol numeric DEFAULT 0.05 NOT NULL,
    auto_paper boolean DEFAULT false NOT NULL,
    paper_sl_pct numeric DEFAULT 30 NOT NULL,
    alert_preset text DEFAULT 'young_calm'::text NOT NULL,
    max_per_day smallint DEFAULT 30 NOT NULL,
    CONSTRAINT alert_settings_alert_preset_check CHECK ((alert_preset = ANY (ARRAY['young_calm'::text, 'momentum'::text, 'strict'::text]))),
    CONSTRAINT alert_settings_max_per_day_check CHECK (((max_per_day >= 1) AND (max_per_day <= 100))),
    CONSTRAINT alert_settings_max_per_hour_check CHECK (((max_per_hour >= 1) AND (max_per_hour <= 20))),
    CONSTRAINT alert_settings_paper_sl_pct_check CHECK (((paper_sl_pct >= (1)::numeric) AND (paper_sl_pct <= (90)::numeric))),
    CONSTRAINT alert_settings_quiet_end_check CHECK (((quiet_end >= 0) AND (quiet_end <= 23))),
    CONSTRAINT alert_settings_quiet_start_check CHECK (((quiet_start >= 0) AND (quiet_start <= 23))),
    CONSTRAINT alert_settings_stake_sol_check CHECK (((stake_sol >= 0.01) AND (stake_sol <= (100)::numeric)))
);

--
-- Name: backtest_event_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backtest_event_state (
    key text NOT NULL,
    state jsonb NOT NULL,
    locked_until timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT backtest_event_state_check CHECK (((jsonb_typeof(state) = 'object'::text) AND (pg_column_size(state) <=
CASE
    WHEN (key = 'cursor'::text) THEN 16384
    ELSE 32768
END))),
    CONSTRAINT backtest_event_state_check1 CHECK (((locked_until IS NULL) OR (key = 'cursor'::text))),
    CONSTRAINT backtest_event_state_key_check CHECK (((key = 'cursor'::text) OR (key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text)))
);

--
-- Name: backtest_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backtest_events (
    id bigint NOT NULL,
    preset text NOT NULL,
    mint text NOT NULL,
    pool text NOT NULL,
    event_at timestamp with time zone NOT NULL,
    entry_snapshot_id bigint NOT NULL,
    price_at_event numeric NOT NULL,
    mc numeric,
    liquidity numeric,
    narrative text,
    pair_age_h real,
    roundtrip_known boolean NOT NULL,
    roundtrip_pct numeric,
    conditions jsonb DEFAULT '{}'::jsonb NOT NULL,
    candles_1m_at timestamp with time zone,
    candles_5m_at timestamp with time zone,
    candles_attempts smallint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT backtest_events_candles_attempts_check CHECK (((candles_attempts >= 0) AND (candles_attempts <= 10000))),
    CONSTRAINT backtest_events_conditions_check CHECK (((jsonb_typeof(conditions) = 'object'::text) AND (pg_column_size(conditions) <= 4096))),
    CONSTRAINT backtest_events_entry_snapshot_id_check CHECK ((entry_snapshot_id > 0)),
    CONSTRAINT backtest_events_liquidity_check CHECK (((liquidity IS NULL) OR ((liquidity >= (0)::numeric) AND (liquidity < '10000000000000'::numeric)))),
    CONSTRAINT backtest_events_mc_check CHECK (((mc IS NULL) OR ((mc >= (0)::numeric) AND (mc < '1000000000000000'::numeric)))),
    CONSTRAINT backtest_events_mint_check CHECK ((mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text)),
    CONSTRAINT backtest_events_narrative_check CHECK (((narrative IS NULL) OR ((char_length(narrative) >= 1) AND (char_length(narrative) <= 24)))),
    CONSTRAINT backtest_events_pair_age_h_check CHECK (((pair_age_h IS NULL) OR ((pair_age_h >= ('-1'::integer)::double precision) AND (pair_age_h < ('1000000'::numeric)::double precision)))),
    CONSTRAINT backtest_events_pool_check CHECK ((pool ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text)),
    CONSTRAINT backtest_events_preset_check CHECK ((preset = ANY (ARRAY['momentum'::text, 'young_24h'::text, 'young_3h'::text, 'post_migration'::text, 'narrative_leader'::text, 'momentum_explo'::text, 'young_24h_explo'::text, 'young_3h_explo'::text, 'young_calm_ev'::text, 'young_frenzy_ev'::text]))),
    CONSTRAINT backtest_events_price_at_event_check CHECK (((price_at_event > (0)::numeric) AND (price_at_event < '1000000000000'::numeric))),
    CONSTRAINT backtest_events_roundtrip_known CHECK ((roundtrip_known = (roundtrip_pct IS NOT NULL))),
    CONSTRAINT backtest_events_roundtrip_pct_check CHECK (((roundtrip_pct IS NULL) OR ((roundtrip_pct >= ('-100'::integer)::numeric) AND (roundtrip_pct <= (100)::numeric)))),
    CONSTRAINT backtest_events_times CHECK ((created_at >= (event_at - '1 day'::interval)))
);

--
-- Name: backtest_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.backtest_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.backtest_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: backtest_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backtest_results (
    run_id bigint NOT NULL,
    preset text NOT NULL,
    exit text NOT NULL,
    sl_pct smallint NOT NULL,
    breakeven boolean NOT NULL,
    time_exit_h smallint NOT NULL,
    delay_min smallint NOT NULL,
    narrative text NOT NULL,
    split text NOT NULL,
    trades integer NOT NULL,
    win_rate real,
    avg_win_pct real,
    avg_loss_pct real,
    avg_net_pct real,
    avg_net_sol real,
    profit_factor real,
    max_drawdown_sol real,
    worst_losing_streak integer,
    ci_low real,
    ci_high real,
    ci_contains_zero boolean,
    open_at_end integer DEFAULT 0 NOT NULL,
    retained boolean DEFAULT false NOT NULL,
    robust boolean DEFAULT false NOT NULL,
    exploratory boolean GENERATED ALWAYS AS ((preset = ANY (ARRAY['momentum_explo'::text, 'young_24h_explo'::text, 'young_3h_explo'::text]))) STORED,
    CONSTRAINT backtest_results_avg_loss_pct_check CHECK (((avg_loss_pct IS NULL) OR ((avg_loss_pct > ('-1000000'::numeric)::double precision) AND (avg_loss_pct < ('1000000'::numeric)::double precision)))),
    CONSTRAINT backtest_results_avg_net_pct_check CHECK (((avg_net_pct IS NULL) OR ((avg_net_pct > ('-1000000'::numeric)::double precision) AND (avg_net_pct < ('1000000'::numeric)::double precision)))),
    CONSTRAINT backtest_results_avg_net_sol_check CHECK (((avg_net_sol IS NULL) OR ((avg_net_sol > ('-1000000'::numeric)::double precision) AND (avg_net_sol < ('1000000'::numeric)::double precision)))),
    CONSTRAINT backtest_results_avg_win_pct_check CHECK (((avg_win_pct IS NULL) OR ((avg_win_pct > ('-1000000'::numeric)::double precision) AND (avg_win_pct < ('1000000'::numeric)::double precision)))),
    CONSTRAINT backtest_results_ci CHECK (((ci_low IS NULL) OR (ci_high IS NULL) OR (ci_low <= ci_high))),
    CONSTRAINT backtest_results_ci_high_check CHECK (((ci_high IS NULL) OR ((ci_high > ('-1000000'::numeric)::double precision) AND (ci_high < ('1000000'::numeric)::double precision)))),
    CONSTRAINT backtest_results_ci_low_check CHECK (((ci_low IS NULL) OR ((ci_low > ('-1000000'::numeric)::double precision) AND (ci_low < ('1000000'::numeric)::double precision)))),
    CONSTRAINT backtest_results_delay_min_check CHECK (((delay_min >= 0) AND (delay_min <= 60))),
    CONSTRAINT backtest_results_exit_check CHECK ((exit = ANY (ARRAY['all_x2'::text, 'half_x2_rest_x3'::text, 'thirds_x2_x3_x4'::text, 'all_x1_5'::text]))),
    CONSTRAINT backtest_results_max_drawdown_sol_check CHECK (((max_drawdown_sol IS NULL) OR ((max_drawdown_sol >= (0)::double precision) AND (max_drawdown_sol < ('1000000000'::numeric)::double precision)))),
    CONSTRAINT backtest_results_narrative_check CHECK ((narrative = ANY (ARRAY['all'::text, 'gta'::text, 'other'::text]))),
    CONSTRAINT backtest_results_open_at_end_check CHECK (((open_at_end >= 0) AND (open_at_end <= 10000000))),
    CONSTRAINT backtest_results_preset_check CHECK ((preset = ANY (ARRAY['all'::text, 'mc_300k_1m'::text, 'momentum'::text, 'young_24h'::text, 'young_3h'::text, 'post_migration'::text, 'narrative_leader'::text, 'momentum_explo'::text, 'young_24h_explo'::text, 'young_3h_explo'::text, 'young_calm'::text, 'young_frenzy'::text, 'young_calm_ev'::text, 'young_frenzy_ev'::text]))),
    CONSTRAINT backtest_results_profit_factor_check CHECK (((profit_factor IS NULL) OR ((profit_factor >= (0)::double precision) AND (profit_factor < ('1000000000'::numeric)::double precision)))),
    CONSTRAINT backtest_results_robust CHECK (((NOT robust) OR retained)),
    CONSTRAINT backtest_results_sl_pct_check CHECK (((sl_pct >= 1) AND (sl_pct <= 90))),
    CONSTRAINT backtest_results_split_check CHECK ((split = ANY (ARRAY['train'::text, 'test'::text]))),
    CONSTRAINT backtest_results_time_exit_h_check CHECK (((time_exit_h >= 0) AND (time_exit_h <= 168))),
    CONSTRAINT backtest_results_trades_check CHECK (((trades >= 0) AND (trades <= 10000000))),
    CONSTRAINT backtest_results_win_rate_check CHECK (((win_rate IS NULL) OR ((win_rate >= (0)::double precision) AND (win_rate <= (1)::double precision)))),
    CONSTRAINT backtest_results_worst_losing_streak_check CHECK (((worst_losing_streak IS NULL) OR ((worst_losing_streak >= 0) AND (worst_losing_streak <= 10000000))))
);

--
-- Name: backtest_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.backtest_runs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.backtest_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: backtest_trades; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backtest_trades (
    run_id bigint NOT NULL,
    source text NOT NULL,
    mint text NOT NULL,
    detected_at timestamp with time zone NOT NULL,
    split text NOT NULL,
    preset_flags smallint NOT NULL,
    narrative text NOT NULL,
    returns real[] NOT NULL,
    open_at_end text,
    CONSTRAINT backtest_trades_mint_check CHECK ((mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text)),
    CONSTRAINT backtest_trades_narrative_check CHECK ((narrative = ANY (ARRAY['gta'::text, 'other'::text]))),
    CONSTRAINT backtest_trades_open_at_end_check CHECK (((open_at_end IS NULL) OR (open_at_end ~ '^[0-9a-f]{96}$'::text))),
    CONSTRAINT backtest_trades_preset_flags_check CHECK ((((source <> 'backtest_events'::text) AND (((preset_flags)::integer % 2) = 1) AND (((preset_flags)::integer & (~ ((((((1 | 2) | 4) | 8) | 16) | 1024) | 2048))) = 0)) OR ((source = 'backtest_events'::text) AND (preset_flags = ANY (ARRAY[2, 4, 8, 32, 64, 128, 256, 512, 4096, 8192]))))),
    CONSTRAINT backtest_trades_returns_check CHECK (((array_ndims(returns) = 1) AND (cardinality(returns) = 384))),
    CONSTRAINT backtest_trades_source_check CHECK ((source = ANY (ARRAY['signal_outcomes'::text, 'preset_signals'::text, 'backtest_events'::text]))),
    CONSTRAINT backtest_trades_split_check CHECK ((split = ANY (ARRAY['train'::text, 'test'::text])))
);

--
-- Name: bench_owner; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bench_owner (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    singleton boolean DEFAULT true NOT NULL,
    email text NOT NULL,
    password_hash text,
    password_changed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bench_owner_email_check CHECK ((((char_length(email) >= 3) AND (char_length(email) <= 254)) AND (email = lower(email)))),
    CONSTRAINT bench_owner_singleton_check CHECK (singleton)
);

--
-- Name: early_buyers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.early_buyers (
    mint text NOT NULL,
    wallet text NOT NULL,
    ts timestamp with time zone,
    sol_amount numeric,
    rank smallint NOT NULL,
    slot bigint NOT NULL,
    signature text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT early_buyers_mint_check CHECK ((mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text)),
    CONSTRAINT early_buyers_rank_check CHECK (((rank >= 1) AND (rank <= 50))),
    CONSTRAINT early_buyers_signature_check CHECK ((signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,90}$'::text)),
    CONSTRAINT early_buyers_slot_check CHECK ((slot >= 0)),
    CONSTRAINT early_buyers_sol_amount_check CHECK (((sol_amount IS NULL) OR ((sol_amount >= (0)::numeric) AND (sol_amount < '1000000000'::numeric)))),
    CONSTRAINT early_buyers_wallet_check CHECK ((wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text))
);

--
-- Name: label_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.label_runs (
    id bigint NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    requests smallint NOT NULL,
    rate_limited smallint NOT NULL,
    rows_written smallint NOT NULL,
    labels smallint NOT NULL,
    candles smallint NOT NULL,
    failed smallint NOT NULL,
    queued smallint NOT NULL,
    ms integer NOT NULL,
    CONSTRAINT label_runs_candles_check CHECK (((candles >= 0) AND (candles <= 100))),
    CONSTRAINT label_runs_failed_check CHECK (((failed >= 0) AND (failed <= 100))),
    CONSTRAINT label_runs_labels_check CHECK (((labels >= 0) AND (labels <= 100))),
    CONSTRAINT label_runs_ms_check CHECK (((ms >= 0) AND (ms <= 600000))),
    CONSTRAINT label_runs_queued_check CHECK (((queued >= 0) AND (queued <= 100))),
    CONSTRAINT label_runs_rate_limited CHECK ((rate_limited <= requests)),
    CONSTRAINT label_runs_rate_limited_check CHECK (((rate_limited >= 0) AND (rate_limited <= 100))),
    CONSTRAINT label_runs_requests_check CHECK (((requests >= 0) AND (requests <= 100))),
    CONSTRAINT label_runs_rows CHECK ((rows_written = (labels + candles))),
    CONSTRAINT label_runs_rows_written_check CHECK (((rows_written >= 0) AND (rows_written <= 100)))
);

--
-- Name: label_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.label_runs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.label_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: ohlcv_candles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ohlcv_candles (
    id bigint NOT NULL,
    mint text NOT NULL,
    pool text NOT NULL,
    tf text NOT NULL,
    ts_start timestamp with time zone NOT NULL,
    step_s integer NOT NULL,
    ts integer[] NOT NULL,
    o real[] NOT NULL,
    h real[] NOT NULL,
    l real[] NOT NULL,
    c real[] NOT NULL,
    v real[] NOT NULL,
    source text NOT NULL,
    detected_at timestamp with time zone NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ohlcv_candles_lengths CHECK (((array_ndims(ts) = 1) AND ((cardinality(ts) >= 1) AND (cardinality(ts) <= 1000)) AND (cardinality(o) = cardinality(ts)) AND (cardinality(h) = cardinality(ts)) AND (cardinality(l) = cardinality(ts)) AND (cardinality(c) = cardinality(ts)) AND (cardinality(v) = cardinality(ts)) AND (array_ndims(o) = 1) AND (array_ndims(h) = 1) AND (array_ndims(l) = 1) AND (array_ndims(c) = 1) AND (array_ndims(v) = 1))),
    CONSTRAINT ohlcv_candles_mint_check CHECK ((mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text)),
    CONSTRAINT ohlcv_candles_offsets CHECK (((ts[1] = 0) AND (0 <= ALL (ts)) AND (2592000 >= ALL (ts)))),
    CONSTRAINT ohlcv_candles_pool_check CHECK ((pool ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text)),
    CONSTRAINT ohlcv_candles_source_check CHECK ((source = ANY (ARRAY['signal_outcomes'::text, 'preset_signals'::text, 'backtest_events'::text]))),
    CONSTRAINT ohlcv_candles_step_s_check CHECK ((step_s = ANY (ARRAY[60, 300, 900]))),
    CONSTRAINT ohlcv_candles_tf_check CHECK ((tf = ANY (ARRAY['1m'::text, '5m'::text, '15m'::text]))),
    CONSTRAINT ohlcv_candles_tf_step CHECK ((((tf = '1m'::text) AND (step_s = 60)) OR ((tf = '5m'::text) AND (step_s = 300)) OR ((tf = '15m'::text) AND (step_s = 900)))),
    CONSTRAINT ohlcv_candles_times CHECK (((fetched_at >= (detected_at - '1 day'::interval)) AND (ts_start >= (detected_at - '8 days'::interval)) AND (ts_start <= (detected_at + '8 days'::interval)))),
    CONSTRAINT ohlcv_candles_values CHECK ((((0)::double precision < ALL (o)) AND (('1000000000000'::numeric)::double precision > ALL (o)) AND ((0)::double precision < ALL (h)) AND (('1000000000000'::numeric)::double precision > ALL (h)) AND ((0)::double precision < ALL (l)) AND (('1000000000000'::numeric)::double precision > ALL (l)) AND ((0)::double precision < ALL (c)) AND (('1000000000000'::numeric)::double precision > ALL (c)) AND ((0)::double precision <= ALL (v)) AND (('1000000000000000'::numeric)::double precision > ALL (v))))
);

--
-- Name: ohlcv_candles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ohlcv_candles ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ohlcv_candles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: paper_legs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.paper_legs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    position_id uuid NOT NULL,
    user_id uuid NOT NULL,
    size_pct smallint NOT NULL,
    tp_price numeric NOT NULL,
    stop_price numeric NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    exit_price numeric,
    closed_at timestamp with time zone,
    CONSTRAINT paper_legs_exit_price_check CHECK (((exit_price IS NULL) OR ((exit_price > (0)::numeric) AND (exit_price < '1000000000000'::numeric)))),
    CONSTRAINT paper_legs_size_pct_check CHECK ((size_pct = ANY (ARRAY[33, 34, 50, 100]))),
    CONSTRAINT paper_legs_status_check CHECK ((status = ANY (ARRAY['open'::text, 'tp_hit'::text, 'sl_hit'::text, 'breakeven_hit'::text]))),
    CONSTRAINT paper_legs_status_columns CHECK (
CASE status
    WHEN 'open'::text THEN ((exit_price IS NULL) AND (closed_at IS NULL))
    ELSE ((exit_price IS NOT NULL) AND (closed_at IS NOT NULL))
END),
    CONSTRAINT paper_legs_stop_price_check CHECK (((stop_price > (0)::numeric) AND (stop_price < '1000000000000'::numeric))),
    CONSTRAINT paper_legs_tp_price_check CHECK (((tp_price > (0)::numeric) AND (tp_price < '1000000000000'::numeric)))
);

--
-- Name: preset_signals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.preset_signals (
    id bigint NOT NULL,
    preset text NOT NULL,
    mint text NOT NULL,
    pair_address text NOT NULL,
    detected_at timestamp with time zone NOT NULL,
    entry_price numeric NOT NULL,
    entry_mc numeric,
    entry_liq_eff numeric,
    entry_zone text,
    entry_dex_id text,
    entry_change_1h numeric,
    entry_roundtrip_pct numeric,
    status text DEFAULT 'pending'::text NOT NULL,
    hit_x2 boolean,
    hit_x3 boolean,
    hit_x5 boolean,
    dd50_first boolean,
    max_multiple_7d numeric,
    hours_to_x3 numeric,
    hit_sl30 boolean,
    x2_before_sl30 boolean,
    sl30_before_x2 boolean,
    min_multiple_7d numeric,
    hours_to_x2 numeric,
    observed_hours numeric,
    labelled_at timestamp with time zone,
    label_attempts smallint DEFAULT 0 NOT NULL,
    label_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    next_label_at timestamp with time zone,
    narrative text,
    pair_age_h numeric,
    candles_1m_at timestamp with time zone,
    candles_5m_at timestamp with time zone,
    candles_attempts smallint DEFAULT 0 NOT NULL,
    CONSTRAINT preset_signals_candles_attempts_check CHECK (((candles_attempts >= 0) AND (candles_attempts <= 10000))),
    CONSTRAINT preset_signals_entry_change_1h_check CHECK (((entry_change_1h IS NULL) OR ((entry_change_1h >= ('-100'::integer)::numeric) AND (entry_change_1h < '1000000000'::numeric)))),
    CONSTRAINT preset_signals_entry_dex_id_check CHECK (((entry_dex_id IS NULL) OR (entry_dex_id ~ '^[a-z0-9_-]{1,32}$'::text))),
    CONSTRAINT preset_signals_entry_liq_eff_check CHECK (((entry_liq_eff IS NULL) OR ((entry_liq_eff >= (0)::numeric) AND (entry_liq_eff < '10000000000000'::numeric)))),
    CONSTRAINT preset_signals_entry_mc_check CHECK (((entry_mc IS NULL) OR ((entry_mc >= (0)::numeric) AND (entry_mc < '1000000000000000'::numeric)))),
    CONSTRAINT preset_signals_entry_price_check CHECK (((entry_price > (0)::numeric) AND (entry_price < '1000000000000'::numeric))),
    CONSTRAINT preset_signals_entry_roundtrip_pct_check CHECK (((entry_roundtrip_pct IS NULL) OR ((entry_roundtrip_pct >= ('-100'::integer)::numeric) AND (entry_roundtrip_pct <= (100)::numeric)))),
    CONSTRAINT preset_signals_entry_zone_check CHECK (((entry_zone IS NULL) OR (entry_zone = ANY (ARRAY['in'::text, 'wait'::text, 'deep'::text, 'broken'::text, 'none'::text])))),
    CONSTRAINT preset_signals_final_has_labels CHECK (((status = 'pending'::text) OR ((hit_x2 IS NOT NULL) AND (hit_x3 IS NOT NULL) AND (hit_x5 IS NOT NULL) AND (dd50_first IS NOT NULL) AND (max_multiple_7d IS NOT NULL) AND (observed_hours IS NOT NULL) AND (labelled_at IS NOT NULL)))),
    CONSTRAINT preset_signals_hours_to_x2_check CHECK (((hours_to_x2 IS NULL) OR ((hours_to_x2 >= (0)::numeric) AND (hours_to_x2 <= (744)::numeric)))),
    CONSTRAINT preset_signals_hours_to_x3_check CHECK (((hours_to_x3 IS NULL) OR ((hours_to_x3 >= (0)::numeric) AND (hours_to_x3 <= (744)::numeric)))),
    CONSTRAINT preset_signals_label_attempts_check CHECK (((label_attempts >= 0) AND (label_attempts <= 10000))),
    CONSTRAINT preset_signals_label_error_check CHECK (((label_error IS NULL) OR (char_length(label_error) <= 200))),
    CONSTRAINT preset_signals_max_multiple_7d_check CHECK (((max_multiple_7d IS NULL) OR ((max_multiple_7d >= (0)::numeric) AND (max_multiple_7d < '1000000000'::numeric)))),
    CONSTRAINT preset_signals_min_multiple_7d_check CHECK (((min_multiple_7d IS NULL) OR ((min_multiple_7d >= (0)::numeric) AND (min_multiple_7d < '1000000000'::numeric)))),
    CONSTRAINT preset_signals_mint_check CHECK ((mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text)),
    CONSTRAINT preset_signals_narrative_check CHECK (((narrative IS NULL) OR ((char_length(narrative) >= 1) AND (char_length(narrative) <= 24)))),
    CONSTRAINT preset_signals_observed_hours_check CHECK (((observed_hours IS NULL) OR ((observed_hours >= (0)::numeric) AND (observed_hours <= (744)::numeric)))),
    CONSTRAINT preset_signals_pair_address_check CHECK ((pair_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text)),
    CONSTRAINT preset_signals_pair_age_h_check CHECK (((pair_age_h IS NULL) OR ((pair_age_h >= (0)::numeric) AND (pair_age_h <= (100000)::numeric)))),
    CONSTRAINT preset_signals_preset_check CHECK ((preset = ANY (ARRAY['momentum'::text, 'strict'::text, 'young_strong'::text, 'young_calm'::text, 'young_frenzy'::text]))),
    CONSTRAINT preset_signals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'final'::text]))),
    CONSTRAINT preset_signals_x2_sl30_exclusive CHECK ((NOT (COALESCE(x2_before_sl30, false) AND COALESCE(sl30_before_x2, false))))
);

--
-- Name: preset_signals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.preset_signals ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.preset_signals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscriptions (
    id bigint NOT NULL,
    user_id uuid DEFAULT public.bench_owner_id() NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT push_subscriptions_auth_check CHECK ((auth ~ '^[A-Za-z0-9_-]{16,32}={0,2}$'::text)),
    CONSTRAINT push_subscriptions_endpoint_check CHECK (((char_length(endpoint) <= 1000) AND (endpoint !~ '\s'::text) AND (endpoint ~ '^https://(web\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)/'::text))),
    CONSTRAINT push_subscriptions_p256dh_check CHECK ((p256dh ~ '^[A-Za-z0-9_-]{80,100}={0,2}$'::text)),
    CONSTRAINT push_subscriptions_user_agent_check CHECK ((char_length(user_agent) <= 300))
);

--
-- Name: push_subscriptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.push_subscriptions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.push_subscriptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: scan_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scan_runs (
    id bigint NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    tokens_seen integer DEFAULT 0 NOT NULL,
    tokens_kept integer DEFAULT 0 NOT NULL,
    error text,
    source_counts jsonb,
    sol_usd numeric,
    eur_usd numeric,
    CONSTRAINT scan_runs_error_check CHECK ((char_length(error) <= 1000)),
    CONSTRAINT scan_runs_eur_usd_check CHECK (((eur_usd IS NULL) OR ((eur_usd > 0.5) AND (eur_usd < (2)::numeric)))),
    CONSTRAINT scan_runs_sol_usd_check CHECK (((sol_usd IS NULL) OR ((sol_usd > (0)::numeric) AND (sol_usd < (100000)::numeric)))),
    CONSTRAINT scan_runs_source_counts_check CHECK (((source_counts IS NULL) OR ((jsonb_typeof(source_counts) = 'object'::text) AND (octet_length((source_counts)::text) <= 8192))))
);

--
-- Name: scan_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.scan_runs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.scan_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: signal_outcomes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.signal_outcomes (
    mint text NOT NULL,
    pair_address text NOT NULL,
    source text DEFAULT 'scan'::text NOT NULL,
    detected_at timestamp with time zone NOT NULL,
    entry_price numeric NOT NULL,
    entry_mc numeric,
    entry_liq_eff numeric,
    entry_roundtrip_pct numeric,
    entry_score smallint,
    entry_zone text,
    features jsonb NOT NULL,
    model_version text,
    p_x3 numeric,
    p_dd50 numeric,
    status text DEFAULT 'pending'::text NOT NULL,
    hit_x2 boolean,
    hit_x3 boolean,
    hit_x5 boolean,
    dd50_first boolean,
    max_multiple_7d numeric,
    hours_to_x3 numeric,
    observed_hours numeric,
    labelled_at timestamp with time zone,
    label_attempts smallint DEFAULT 0 NOT NULL,
    label_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    hit_sl30 boolean,
    x2_before_sl30 boolean,
    sl30_before_x2 boolean,
    min_multiple_7d numeric,
    hours_to_x2 numeric,
    entry_dex_id text,
    next_label_at timestamp with time zone,
    candles_1m_at timestamp with time zone,
    candles_5m_at timestamp with time zone,
    candles_attempts smallint DEFAULT 0 NOT NULL,
    pair_age_h numeric GENERATED ALWAYS AS (
CASE
    WHEN (jsonb_typeof((features -> 'log_age_h'::text)) = 'number'::text) THEN round(((exp(LEAST(GREATEST(((features ->> 'log_age_h'::text))::double precision, (0)::double precision), (12)::double precision)) - (1)::double precision))::numeric, 3)
    ELSE NULL::numeric
END) STORED,
    CONSTRAINT signal_outcomes_candles_attempts_check CHECK (((candles_attempts >= 0) AND (candles_attempts <= 10000))),
    CONSTRAINT signal_outcomes_entry_dex_check CHECK (((entry_dex_id IS NULL) OR (entry_dex_id ~ '^[a-z0-9_-]{1,32}$'::text))),
    CONSTRAINT signal_outcomes_entry_liq_eff_check CHECK (((entry_liq_eff IS NULL) OR ((entry_liq_eff >= (0)::numeric) AND (entry_liq_eff < '10000000000000'::numeric)))),
    CONSTRAINT signal_outcomes_entry_mc_check CHECK (((entry_mc IS NULL) OR ((entry_mc >= (0)::numeric) AND (entry_mc < '1000000000000000'::numeric)))),
    CONSTRAINT signal_outcomes_entry_price_check CHECK (((entry_price > (0)::numeric) AND (entry_price < '1000000000000'::numeric))),
    CONSTRAINT signal_outcomes_entry_roundtrip_pct_check CHECK (((entry_roundtrip_pct IS NULL) OR ((entry_roundtrip_pct >= ('-100'::integer)::numeric) AND (entry_roundtrip_pct <= (100)::numeric)))),
    CONSTRAINT signal_outcomes_entry_score_check CHECK (((entry_score IS NULL) OR ((entry_score >= 0) AND (entry_score <= 100)))),
    CONSTRAINT signal_outcomes_entry_zone_check CHECK (((entry_zone IS NULL) OR (entry_zone = ANY (ARRAY['in'::text, 'wait'::text, 'deep'::text, 'broken'::text, 'none'::text])))),
    CONSTRAINT signal_outcomes_features_check CHECK (((jsonb_typeof(features) = 'object'::text) AND (pg_column_size(features) <= 8192))),
    CONSTRAINT signal_outcomes_final_has_labels CHECK (((status = 'pending'::text) OR ((hit_x2 IS NOT NULL) AND (hit_x3 IS NOT NULL) AND (hit_x5 IS NOT NULL) AND (dd50_first IS NOT NULL) AND (max_multiple_7d IS NOT NULL) AND (observed_hours IS NOT NULL) AND (labelled_at IS NOT NULL)))),
    CONSTRAINT signal_outcomes_hours_to_x2_check CHECK (((hours_to_x2 IS NULL) OR ((hours_to_x2 >= (0)::numeric) AND (hours_to_x2 <= (744)::numeric)))),
    CONSTRAINT signal_outcomes_hours_to_x3_check CHECK (((hours_to_x3 IS NULL) OR ((hours_to_x3 >= (0)::numeric) AND (hours_to_x3 <= (744)::numeric)))),
    CONSTRAINT signal_outcomes_label_attempts_check CHECK (((label_attempts >= 0) AND (label_attempts <= 10000))),
    CONSTRAINT signal_outcomes_label_error_check CHECK (((label_error IS NULL) OR (char_length(label_error) <= 200))),
    CONSTRAINT signal_outcomes_max_multiple_7d_check CHECK (((max_multiple_7d IS NULL) OR ((max_multiple_7d >= (0)::numeric) AND (max_multiple_7d < '1000000000'::numeric)))),
    CONSTRAINT signal_outcomes_min_multiple_check CHECK (((min_multiple_7d IS NULL) OR (min_multiple_7d >= (0)::numeric))),
    CONSTRAINT signal_outcomes_mint_check CHECK ((mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text)),
    CONSTRAINT signal_outcomes_model_version_check CHECK (((model_version IS NULL) OR ((char_length(model_version) >= 1) AND (char_length(model_version) <= 64)))),
    CONSTRAINT signal_outcomes_observed_hours_check CHECK (((observed_hours IS NULL) OR ((observed_hours >= (0)::numeric) AND (observed_hours <= (744)::numeric)))),
    CONSTRAINT signal_outcomes_p_dd50_check CHECK (((p_dd50 IS NULL) OR ((p_dd50 >= (0)::numeric) AND (p_dd50 <= (1)::numeric)))),
    CONSTRAINT signal_outcomes_p_x3_check CHECK (((p_x3 IS NULL) OR ((p_x3 >= (0)::numeric) AND (p_x3 <= (1)::numeric)))),
    CONSTRAINT signal_outcomes_pair_address_check CHECK ((pair_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text)),
    CONSTRAINT signal_outcomes_source_check CHECK ((source = ANY (ARRAY['scan'::text, 'backfill'::text]))),
    CONSTRAINT signal_outcomes_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'final'::text]))),
    CONSTRAINT signal_outcomes_x2_sl30_exclusive CHECK ((NOT (COALESCE(x2_before_sl30, false) AND COALESCE(sl30_before_x2, false))))
);

--
-- Name: token_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.token_snapshots (
    id bigint NOT NULL,
    mint text NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    price_usd numeric NOT NULL,
    market_cap numeric NOT NULL,
    liquidity_usd numeric NOT NULL,
    volume_24h numeric NOT NULL,
    score smallint,
    zone_status text,
    holder_count integer,
    volume_1h numeric,
    txns_1h integer,
    dex_id text,
    organic_score numeric,
    source text DEFAULT 'scan'::text NOT NULL,
    mint_authority_disabled boolean,
    freeze_authority_disabled boolean,
    top10_pct numeric,
    insiders_detected boolean,
    roundtrip_cost_pct numeric,
    change_1h numeric,
    buys_1h integer,
    sells_1h integer,
    liquidity_effective_usd numeric,
    lp_locked_pct numeric,
    CONSTRAINT token_snapshots_buys_1h_check CHECK (((buys_1h IS NULL) OR ((buys_1h >= 0) AND (buys_1h <= 100000000)))),
    CONSTRAINT token_snapshots_change_1h_check CHECK (((change_1h IS NULL) OR ((change_1h >= ('-100'::integer)::numeric) AND (change_1h < '1000000000'::numeric)))),
    CONSTRAINT token_snapshots_dex_id_check CHECK (((dex_id IS NULL) OR (char_length(dex_id) <= 32))),
    CONSTRAINT token_snapshots_holder_count_check CHECK (((holder_count IS NULL) OR (holder_count >= 0))),
    CONSTRAINT token_snapshots_liq_eff_check CHECK (((liquidity_effective_usd IS NULL) OR ((liquidity_effective_usd >= (0)::numeric) AND (liquidity_effective_usd < '10000000000000'::numeric)))),
    CONSTRAINT token_snapshots_liquidity_usd_check CHECK ((liquidity_usd >= (0)::numeric)),
    CONSTRAINT token_snapshots_lp_locked_check CHECK (((lp_locked_pct IS NULL) OR ((lp_locked_pct >= (0)::numeric) AND (lp_locked_pct <= (100)::numeric)))),
    CONSTRAINT token_snapshots_market_cap_check CHECK ((market_cap >= (0)::numeric)),
    CONSTRAINT token_snapshots_organic_score_check CHECK (((organic_score IS NULL) OR ((organic_score >= (0)::numeric) AND (organic_score <= (100)::numeric)))),
    CONSTRAINT token_snapshots_price_usd_check CHECK ((price_usd >= (0)::numeric)),
    CONSTRAINT token_snapshots_roundtrip_check CHECK (((roundtrip_cost_pct IS NULL) OR ((roundtrip_cost_pct >= ('-100'::integer)::numeric) AND (roundtrip_cost_pct <= (100)::numeric)))),
    CONSTRAINT token_snapshots_score_check CHECK (((score >= 0) AND (score <= 100))),
    CONSTRAINT token_snapshots_sells_1h_check CHECK (((sells_1h IS NULL) OR ((sells_1h >= 0) AND (sells_1h <= 100000000)))),
    CONSTRAINT token_snapshots_source_check CHECK ((source = ANY (ARRAY['scan'::text, 'tracking'::text]))),
    CONSTRAINT token_snapshots_top10_pct_check CHECK (((top10_pct IS NULL) OR ((top10_pct >= (0)::numeric) AND (top10_pct <= (100)::numeric)))),
    CONSTRAINT token_snapshots_txns_1h_check CHECK (((txns_1h IS NULL) OR (txns_1h >= 0))),
    CONSTRAINT token_snapshots_volume_1h_check CHECK (((volume_1h IS NULL) OR ((volume_1h >= (0)::numeric) AND (volume_1h < '1000000000000000'::numeric)))),
    CONSTRAINT token_snapshots_volume_24h_check CHECK ((volume_24h >= (0)::numeric)),
    CONSTRAINT token_snapshots_zone_status_check CHECK ((zone_status = ANY (ARRAY['in'::text, 'wait'::text, 'deep'::text, 'broken'::text, 'none'::text])))
);

--
-- Name: token_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.token_snapshots ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.token_snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tokens (
    mint text NOT NULL,
    symbol text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    pair_address text NOT NULL,
    dex_id text DEFAULT ''::text NOT NULL,
    image_url text,
    website_url text,
    x_url text,
    telegram_url text,
    price_usd numeric NOT NULL,
    market_cap numeric NOT NULL,
    liquidity_usd numeric NOT NULL,
    volume_24h numeric NOT NULL,
    change_5m numeric DEFAULT 0 NOT NULL,
    change_1h numeric DEFAULT 0 NOT NULL,
    change_6h numeric DEFAULT 0 NOT NULL,
    change_24h numeric DEFAULT 0 NOT NULL,
    buys_1h integer DEFAULT 0 NOT NULL,
    sells_1h integer DEFAULT 0 NOT NULL,
    buys_24h integer DEFAULT 0 NOT NULL,
    sells_24h integer DEFAULT 0 NOT NULL,
    pair_created_at timestamp with time zone,
    flags text[] DEFAULT '{}'::text[] NOT NULL,
    mint_authority_disabled boolean,
    freeze_authority_disabled boolean,
    top10_pct numeric,
    holder_count integer,
    organic_score numeric,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    liquidity_jup_usd numeric,
    liquidity_dex_usd numeric GENERATED ALWAYS AS (liquidity_usd) STORED,
    liquidity_gecko_usd numeric,
    liquidity_effective_usd numeric,
    liquidity_divergence numeric,
    roundtrip_cost_pct numeric,
    roundtrip_fee_pct numeric,
    buy_impact_pct numeric,
    lp_locked_pct numeric,
    rugcheck_score numeric,
    rugcheck_dangers text[] DEFAULT '{}'::text[] NOT NULL,
    price_jup_usd numeric,
    price_gecko_usd numeric,
    data_confidence text,
    quote_at timestamp with time zone,
    rugcheck_at timestamp with time zone,
    enriched_at timestamp with time zone,
    narrative text,
    narrative_rank smallint,
    features jsonb,
    insiders_detected boolean,
    creator_rug_history boolean,
    sources text[] DEFAULT '{}'::text[] NOT NULL,
    spark_6h real[],
    volume_1h numeric,
    CONSTRAINT tokens_buy_impact_pct_check CHECK (((buy_impact_pct IS NULL) OR ((buy_impact_pct >= ('-100'::integer)::numeric) AND (buy_impact_pct <= (100)::numeric)))),
    CONSTRAINT tokens_buys_1h_check CHECK ((buys_1h >= 0)),
    CONSTRAINT tokens_buys_24h_check CHECK ((buys_24h >= 0)),
    CONSTRAINT tokens_data_confidence_check CHECK (((data_confidence IS NULL) OR (data_confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])))),
    CONSTRAINT tokens_dex_id_check CHECK ((char_length(dex_id) <= 32)),
    CONSTRAINT tokens_features_check CHECK (((features IS NULL) OR ((jsonb_typeof(features) = 'object'::text) AND (pg_column_size(features) <= 8192)))),
    CONSTRAINT tokens_flags_check CHECK ((cardinality(flags) <= 12)),
    CONSTRAINT tokens_holder_count_check CHECK ((holder_count >= 0)),
    CONSTRAINT tokens_image_url_check CHECK (((image_url IS NULL) OR ((image_url ~~ 'https://%'::text) AND (char_length(image_url) <= 500)))),
    CONSTRAINT tokens_liquidity_divergence_check CHECK (((liquidity_divergence IS NULL) OR ((liquidity_divergence >= (0)::numeric) AND (liquidity_divergence < '1000000000'::numeric)))),
    CONSTRAINT tokens_liquidity_effective_usd_check CHECK (((liquidity_effective_usd IS NULL) OR ((liquidity_effective_usd >= (0)::numeric) AND (liquidity_effective_usd < '10000000000000'::numeric)))),
    CONSTRAINT tokens_liquidity_gecko_usd_check CHECK (((liquidity_gecko_usd IS NULL) OR ((liquidity_gecko_usd >= (0)::numeric) AND (liquidity_gecko_usd < '10000000000000'::numeric)))),
    CONSTRAINT tokens_liquidity_jup_usd_check CHECK (((liquidity_jup_usd IS NULL) OR (liquidity_jup_usd >= (0)::numeric))),
    CONSTRAINT tokens_liquidity_usd_check CHECK ((liquidity_usd >= (0)::numeric)),
    CONSTRAINT tokens_lp_locked_pct_check CHECK (((lp_locked_pct IS NULL) OR ((lp_locked_pct >= (0)::numeric) AND (lp_locked_pct <= (100)::numeric)))),
    CONSTRAINT tokens_market_cap_check CHECK ((market_cap >= (0)::numeric)),
    CONSTRAINT tokens_mint_check CHECK ((mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text)),
    CONSTRAINT tokens_name_check CHECK ((char_length(name) <= 64)),
    CONSTRAINT tokens_narrative_check CHECK (((narrative IS NULL) OR ((char_length(narrative) >= 1) AND (char_length(narrative) <= 24)))),
    CONSTRAINT tokens_narrative_rank_check CHECK (((narrative_rank IS NULL) OR ((narrative_rank >= 0) AND (narrative_rank <= 10000)))),
    CONSTRAINT tokens_organic_score_check CHECK (((organic_score >= (0)::numeric) AND (organic_score <= (100)::numeric))),
    CONSTRAINT tokens_pair_address_check CHECK ((pair_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text)),
    CONSTRAINT tokens_price_gecko_usd_check CHECK (((price_gecko_usd IS NULL) OR ((price_gecko_usd >= (0)::numeric) AND (price_gecko_usd < '1000000000000'::numeric)))),
    CONSTRAINT tokens_price_jup_usd_check CHECK (((price_jup_usd IS NULL) OR ((price_jup_usd >= (0)::numeric) AND (price_jup_usd < '1000000000000'::numeric)))),
    CONSTRAINT tokens_price_usd_check CHECK ((price_usd >= (0)::numeric)),
    CONSTRAINT tokens_roundtrip_cost_pct_check CHECK (((roundtrip_cost_pct IS NULL) OR ((roundtrip_cost_pct >= ('-100'::integer)::numeric) AND (roundtrip_cost_pct <= (100)::numeric)))),
    CONSTRAINT tokens_roundtrip_fee_pct_check CHECK (((roundtrip_fee_pct IS NULL) OR ((roundtrip_fee_pct >= (0)::numeric) AND (roundtrip_fee_pct <= (100)::numeric)))),
    CONSTRAINT tokens_rugcheck_dangers_check CHECK (((cardinality(rugcheck_dangers) <= 5) AND (array_position(rugcheck_dangers, NULL::text) IS NULL) AND (char_length(array_to_string(rugcheck_dangers, ''::text)) <= 200))),
    CONSTRAINT tokens_rugcheck_score_check CHECK (((rugcheck_score IS NULL) OR ((rugcheck_score >= (0)::numeric) AND (rugcheck_score < '1000000000'::numeric)))),
    CONSTRAINT tokens_sells_1h_check CHECK ((sells_1h >= 0)),
    CONSTRAINT tokens_sells_24h_check CHECK ((sells_24h >= 0)),
    CONSTRAINT tokens_sources_check CHECK (((cardinality(sources) <= 10) AND (array_position(sources, NULL::text) IS NULL) AND (sources <@ ARRAY['dex_profiles'::text, 'dex_boosts_latest'::text, 'dex_boosts_top'::text, 'dex_cto'::text, 'dex_search'::text, 'gecko_trending'::text, 'gecko_volume'::text, 'gecko_trending_1h'::text, 'gecko_pumpswap'::text, 'gecko_new_pools'::text, 'jup_trending_1h'::text, 'jup_trending_6h'::text, 'jup_organic_1h'::text, 'jup_organic_6h'::text, 'jup_traded_1h'::text, 'jup_traded_6h'::text, 'jup_recent'::text, 'migration'::text, 'young_watch'::text]))),
    CONSTRAINT tokens_spark_6h_check CHECK (((spark_6h IS NULL) OR ((array_ndims(spark_6h) = 1) AND ((cardinality(spark_6h) >= 1) AND (cardinality(spark_6h) <= 48)) AND (array_position(spark_6h, NULL::real) IS NULL) AND ((0)::double precision < ALL (spark_6h)) AND (('1000000000000'::numeric)::real > ALL (spark_6h))))),
    CONSTRAINT tokens_symbol_check CHECK (((char_length(symbol) >= 1) AND (char_length(symbol) <= 32))),
    CONSTRAINT tokens_telegram_url_check CHECK (((telegram_url IS NULL) OR ((telegram_url ~~ 'https://%'::text) AND (char_length(telegram_url) <= 500)))),
    CONSTRAINT tokens_top10_pct_check CHECK (((top10_pct >= (0)::numeric) AND (top10_pct <= (100)::numeric))),
    CONSTRAINT tokens_volume_1h_check CHECK (((volume_1h IS NULL) OR ((volume_1h >= (0)::numeric) AND (volume_1h < '1000000000000000'::numeric)))),
    CONSTRAINT tokens_volume_24h_check CHECK ((volume_24h >= (0)::numeric)),
    CONSTRAINT tokens_website_url_check CHECK (((website_url IS NULL) OR ((website_url ~~ 'https://%'::text) AND (char_length(website_url) <= 500)))),
    CONSTRAINT tokens_x_url_check CHECK (((x_url IS NULL) OR ((x_url ~~ 'https://%'::text) AND (char_length(x_url) <= 500))))
);

--
-- Name: wallet_study_budget; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_study_budget (
    id smallint DEFAULT 1 NOT NULL,
    credits_used integer DEFAULT 0 NOT NULL,
    hard_cap integer DEFAULT 600000 NOT NULL,
    lease_until timestamp with time zone,
    lease_token uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wallet_study_budget_check CHECK (((credits_used >= 0) AND (credits_used <= hard_cap))),
    CONSTRAINT wallet_study_budget_hard_cap_check CHECK (((hard_cap >= 0) AND (hard_cap <= 600000))),
    CONSTRAINT wallet_study_budget_id_check CHECK ((id = 1))
);

--
-- Name: wallet_study_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_study_state (
    mint text NOT NULL,
    pair_address text NOT NULL,
    pair_created_at timestamp with time zone,
    detected_at timestamp with time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    cursor text,
    pages smallint DEFAULT 0 NOT NULL,
    buyers smallint DEFAULT 0 NOT NULL,
    creator text,
    creator_checked boolean DEFAULT false NOT NULL,
    pool_creator text,
    credits_used integer DEFAULT 0 NOT NULL,
    dropped_txs integer DEFAULT 0 NOT NULL,
    attempts smallint DEFAULT 0 NOT NULL,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT wallet_study_state_attempts_check CHECK (((attempts >= 0) AND (attempts <= 100))),
    CONSTRAINT wallet_study_state_buyers_check CHECK (((buyers >= 0) AND (buyers <= 50))),
    CONSTRAINT wallet_study_state_creator_check CHECK (((creator IS NULL) OR (creator ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text))),
    CONSTRAINT wallet_study_state_credits_used_check CHECK (((credits_used >= 0) AND (credits_used <= 600000))),
    CONSTRAINT wallet_study_state_cursor_check CHECK (((cursor IS NULL) OR (cursor ~ '^[0-9]{1,20}:[0-9]{1,10}$'::text))),
    CONSTRAINT wallet_study_state_dropped_txs_check CHECK (((dropped_txs >= 0) AND (dropped_txs <= 1000000))),
    CONSTRAINT wallet_study_state_error_check CHECK (((error IS NULL) OR (char_length(error) <= 200))),
    CONSTRAINT wallet_study_state_finished CHECK (((status = 'pending'::text) = (finished_at IS NULL))),
    CONSTRAINT wallet_study_state_mint_check CHECK ((mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text)),
    CONSTRAINT wallet_study_state_pages_check CHECK (((pages >= 0) AND (pages <= 1000))),
    CONSTRAINT wallet_study_state_pair_address_check CHECK ((pair_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text)),
    CONSTRAINT wallet_study_state_pool_creator_check CHECK (((pool_creator IS NULL) OR (pool_creator ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text))),
    CONSTRAINT wallet_study_state_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'done'::text, 'exhausted'::text, 'capped'::text, 'failed'::text])))
);

--
-- Name: alert_log alert_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_log
    ADD CONSTRAINT alert_log_pkey PRIMARY KEY (id);

--
-- Name: alert_log alert_log_single_has_plan; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.alert_log
    ADD CONSTRAINT alert_log_single_has_plan CHECK (((kind <> 'single'::text) OR ((entry_price IS NOT NULL) AND (target_price IS NOT NULL) AND (stop_price IS NOT NULL) AND (rr IS NOT NULL) AND (stake_sol IS NOT NULL) AND (max_price IS NOT NULL) AND (min_price IS NOT NULL) AND (last_price IS NOT NULL) AND (last_price_at IS NOT NULL) AND (tracking_until IS NOT NULL)))) NOT VALID;

--
-- Name: alert_settings alert_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_settings
    ADD CONSTRAINT alert_settings_pkey PRIMARY KEY (user_id);

--
-- Name: backtest_event_state backtest_event_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backtest_event_state
    ADD CONSTRAINT backtest_event_state_pkey PRIMARY KEY (key);

--
-- Name: backtest_events backtest_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backtest_events
    ADD CONSTRAINT backtest_events_pkey PRIMARY KEY (id);

--
-- Name: backtest_events backtest_events_preset_mint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backtest_events
    ADD CONSTRAINT backtest_events_preset_mint_key UNIQUE (preset, mint);

--
-- Name: backtest_results backtest_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backtest_results
    ADD CONSTRAINT backtest_results_pkey PRIMARY KEY (run_id, preset, exit, sl_pct, breakeven, time_exit_h, delay_min, narrative, split);

--
-- Name: backtest_runs backtest_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backtest_runs
    ADD CONSTRAINT backtest_runs_pkey PRIMARY KEY (id);

--
-- Name: backtest_trades backtest_trades_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backtest_trades
    ADD CONSTRAINT backtest_trades_pkey PRIMARY KEY (run_id, source, mint, detected_at, preset_flags);

--
-- Name: bench_owner bench_owner_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bench_owner
    ADD CONSTRAINT bench_owner_pkey PRIMARY KEY (id);

--
-- Name: bench_owner bench_owner_singleton_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bench_owner
    ADD CONSTRAINT bench_owner_singleton_key UNIQUE (singleton);

--
-- Name: early_buyers early_buyers_mint_rank_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.early_buyers
    ADD CONSTRAINT early_buyers_mint_rank_key UNIQUE (mint, rank);

--
-- Name: early_buyers early_buyers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.early_buyers
    ADD CONSTRAINT early_buyers_pkey PRIMARY KEY (mint, wallet);

--
-- Name: label_runs label_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.label_runs
    ADD CONSTRAINT label_runs_pkey PRIMARY KEY (id);

--
-- Name: ohlcv_candles ohlcv_candles_mint_tf_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ohlcv_candles
    ADD CONSTRAINT ohlcv_candles_mint_tf_start_key UNIQUE (mint, tf, ts_start);

--
-- Name: ohlcv_candles ohlcv_candles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ohlcv_candles
    ADD CONSTRAINT ohlcv_candles_pkey PRIMARY KEY (id);

--
-- Name: paper_legs paper_legs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paper_legs
    ADD CONSTRAINT paper_legs_pkey PRIMARY KEY (id);

--
-- Name: paper_positions paper_positions_id_user_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paper_positions
    ADD CONSTRAINT paper_positions_id_user_key UNIQUE (id, user_id);

--
-- Name: paper_positions paper_positions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paper_positions
    ADD CONSTRAINT paper_positions_pkey PRIMARY KEY (id);

--
-- Name: paper_wallets paper_wallets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paper_wallets
    ADD CONSTRAINT paper_wallets_pkey PRIMARY KEY (user_id, book);

--
-- Name: preset_signals preset_signals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preset_signals
    ADD CONSTRAINT preset_signals_pkey PRIMARY KEY (id);

--
-- Name: preset_signals preset_signals_preset_mint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preset_signals
    ADD CONSTRAINT preset_signals_preset_mint_key UNIQUE (preset, mint);

--
-- Name: push_subscriptions push_subscriptions_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);

--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);

--
-- Name: scan_runs scan_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_runs
    ADD CONSTRAINT scan_runs_pkey PRIMARY KEY (id);

--
-- Name: signal_outcomes signal_outcomes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signal_outcomes
    ADD CONSTRAINT signal_outcomes_pkey PRIMARY KEY (mint);

--
-- Name: token_snapshots token_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_snapshots
    ADD CONSTRAINT token_snapshots_pkey PRIMARY KEY (id);

--
-- Name: tokens tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tokens
    ADD CONSTRAINT tokens_pkey PRIMARY KEY (mint);

--
-- Name: wallet_study_budget wallet_study_budget_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_study_budget
    ADD CONSTRAINT wallet_study_budget_pkey PRIMARY KEY (id);

--
-- Name: wallet_study_state wallet_study_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_study_state
    ADD CONSTRAINT wallet_study_state_pkey PRIMARY KEY (mint);

--
-- Name: alert_log_sent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alert_log_sent_idx ON public.alert_log USING btree (sent_at);

--
-- Name: alert_log_tracking_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alert_log_tracking_idx ON public.alert_log USING btree (tracking_until DESC) WHERE (tracking_until IS NOT NULL);

--
-- Name: alert_log_user_mint_sent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alert_log_user_mint_sent_idx ON public.alert_log USING btree (user_id, mint, sent_at DESC);

--
-- Name: alert_log_user_sent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alert_log_user_sent_idx ON public.alert_log USING btree (user_id, sent_at DESC);

--
-- Name: alert_log_young_user_sent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alert_log_young_user_sent_idx ON public.alert_log USING btree (user_id, sent_at DESC) WHERE (preset = 'young_strong'::text);

--
-- Name: alert_settings_enabled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alert_settings_enabled_idx ON public.alert_settings USING btree (user_id) WHERE enabled;

--
-- Name: backtest_event_state_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backtest_event_state_updated_idx ON public.backtest_event_state USING btree (updated_at);

--
-- Name: backtest_events_candles_1m_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backtest_events_candles_1m_idx ON public.backtest_events USING btree (candles_1m_at) WHERE (candles_1m_at IS NOT NULL);

--
-- Name: backtest_events_candles_5m_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backtest_events_candles_5m_idx ON public.backtest_events USING btree (candles_5m_at) WHERE (candles_5m_at IS NOT NULL);

--
-- Name: backtest_events_event_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backtest_events_event_at_idx ON public.backtest_events USING btree (event_at);

--
-- Name: backtest_results_run_rank_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backtest_results_run_rank_idx ON public.backtest_results USING btree (run_id, narrative, split, avg_net_pct DESC) WHERE retained;

--
-- Name: backtest_runs_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backtest_runs_active_idx ON public.backtest_runs USING btree (created_at) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

--
-- Name: backtest_runs_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backtest_runs_created_idx ON public.backtest_runs USING btree (created_at DESC);

--
-- Name: backtest_trades_run_detected_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backtest_trades_run_detected_idx ON public.backtest_trades USING btree (run_id, detected_at);

--
-- Name: early_buyers_wallet_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX early_buyers_wallet_idx ON public.early_buyers USING btree (wallet);

--
-- Name: label_runs_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX label_runs_at_idx ON public.label_runs USING btree (at);

--
-- Name: ohlcv_candles_detected_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ohlcv_candles_detected_idx ON public.ohlcv_candles USING btree (detected_at);

--
-- Name: ohlcv_candles_fetched_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ohlcv_candles_fetched_idx ON public.ohlcv_candles USING btree (fetched_at);

--
-- Name: paper_legs_position_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX paper_legs_position_idx ON public.paper_legs USING btree (position_id);

--
-- Name: paper_legs_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX paper_legs_user_idx ON public.paper_legs USING btree (user_id);

--
-- Name: paper_legs_user_sl_closed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX paper_legs_user_sl_closed_idx ON public.paper_legs USING btree (user_id, closed_at DESC) WHERE (status = 'sl_hit'::text);

--
-- Name: paper_positions_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX paper_positions_active_idx ON public.paper_positions USING btree (created_at) WHERE (status = ANY (ARRAY['pending'::text, 'open'::text]));

--
-- Name: paper_positions_active_mint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX paper_positions_active_mint_idx ON public.paper_positions USING btree (mint) WHERE (status = ANY (ARRAY['pending'::text, 'open'::text]));

--
-- Name: paper_positions_alert_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX paper_positions_alert_idx ON public.paper_positions USING btree (alert_id) WHERE (alert_id IS NOT NULL);

--
-- Name: paper_positions_book_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX paper_positions_book_status_idx ON public.paper_positions USING btree (book, status) WHERE (status = ANY (ARRAY['pending'::text, 'open'::text]));

--
-- Name: paper_positions_calm_frenzy_once_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX paper_positions_calm_frenzy_once_idx ON public.paper_positions USING btree (user_id, book, mint) WHERE (book = ANY (ARRAY['calm_all_x2'::text, 'frenzy_all_x2'::text]));

--
-- Name: paper_positions_test_books_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX paper_positions_test_books_active_idx ON public.paper_positions USING btree (user_id, book, mint) WHERE ((book = ANY (ARRAY['calm_sl30'::text, 'calm_sl40'::text, 'frenzy_sl30'::text])) AND (status = ANY (ARRAY['pending'::text, 'open'::text])));

--
-- Name: paper_positions_user_book_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX paper_positions_user_book_status_idx ON public.paper_positions USING btree (user_id, book, status);

--
-- Name: paper_positions_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX paper_positions_user_created_idx ON public.paper_positions USING btree (user_id, created_at DESC);

--
-- Name: preset_signals_candles_1m_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX preset_signals_candles_1m_idx ON public.preset_signals USING btree (candles_1m_at) WHERE (candles_1m_at IS NOT NULL);

--
-- Name: preset_signals_candles_5m_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX preset_signals_candles_5m_idx ON public.preset_signals USING btree (candles_5m_at) WHERE (candles_5m_at IS NOT NULL);

--
-- Name: preset_signals_next_label_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX preset_signals_next_label_idx ON public.preset_signals USING btree (next_label_at) WHERE (status = 'pending'::text);

--
-- Name: preset_signals_pending_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX preset_signals_pending_queue_idx ON public.preset_signals USING btree (labelled_at NULLS FIRST, detected_at) WHERE (status = 'pending'::text);

--
-- Name: preset_signals_preset_detected_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX preset_signals_preset_detected_idx ON public.preset_signals USING btree (preset, detected_at DESC);

--
-- Name: preset_signals_status_detected_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX preset_signals_status_detected_idx ON public.preset_signals USING btree (status, detected_at DESC);

--
-- Name: push_subscriptions_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX push_subscriptions_user_id_idx ON public.push_subscriptions USING btree (user_id, created_at DESC);

--
-- Name: scan_runs_started_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scan_runs_started_at_idx ON public.scan_runs USING btree (started_at DESC);

--
-- Name: signal_outcomes_candles_1m_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX signal_outcomes_candles_1m_idx ON public.signal_outcomes USING btree (candles_1m_at) WHERE (candles_1m_at IS NOT NULL);

--
-- Name: signal_outcomes_candles_5m_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX signal_outcomes_candles_5m_idx ON public.signal_outcomes USING btree (candles_5m_at) WHERE (candles_5m_at IS NOT NULL);

--
-- Name: signal_outcomes_next_label_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX signal_outcomes_next_label_idx ON public.signal_outcomes USING btree (next_label_at) WHERE (status = 'pending'::text);

--
-- Name: signal_outcomes_pending_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX signal_outcomes_pending_queue_idx ON public.signal_outcomes USING btree (labelled_at NULLS FIRST, detected_at) WHERE (status = 'pending'::text);

--
-- Name: signal_outcomes_status_detected_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX signal_outcomes_status_detected_idx ON public.signal_outcomes USING btree (status, detected_at DESC);

--
-- Name: token_snapshots_mint_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX token_snapshots_mint_time_idx ON public.token_snapshots USING btree (mint, captured_at DESC);

--
-- Name: token_snapshots_time_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX token_snapshots_time_id_idx ON public.token_snapshots USING btree (captured_at, id);

--
-- Name: token_snapshots_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX token_snapshots_time_idx ON public.token_snapshots USING btree (captured_at);

--
-- Name: tokens_pair_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tokens_pair_created_at_idx ON public.tokens USING btree (pair_created_at DESC NULLS LAST);

--
-- Name: tokens_sources_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tokens_sources_idx ON public.tokens USING gin (sources);

--
-- Name: tokens_updated_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tokens_updated_at_idx ON public.tokens USING btree (updated_at DESC);

--
-- Name: wallet_study_state_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_study_state_status_idx ON public.wallet_study_state USING btree (status, detected_at);

--
-- Name: alert_settings alert_settings_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER alert_settings_touch BEFORE UPDATE ON public.alert_settings FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

--
-- Name: backtest_events backtest_events_first_candle_checkpoint; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER backtest_events_first_candle_checkpoint BEFORE INSERT ON public.backtest_events FOR EACH ROW EXECUTE FUNCTION public.set_event_candle_checkpoint();

--
-- Name: paper_positions paper_positions_before_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER paper_positions_before_insert BEFORE INSERT ON public.paper_positions FOR EACH ROW EXECUTE FUNCTION public.paper_positions_before_insert();

--
-- Name: preset_signals preset_signals_first_candle_checkpoint; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER preset_signals_first_candle_checkpoint BEFORE INSERT ON public.preset_signals FOR EACH ROW EXECUTE FUNCTION public.set_first_candle_checkpoint();

--
-- Name: preset_signals preset_signals_first_label_checkpoint; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER preset_signals_first_label_checkpoint BEFORE INSERT ON public.preset_signals FOR EACH ROW EXECUTE FUNCTION public.set_first_label_checkpoint();

--
-- Name: push_subscriptions push_subscriptions_cap; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER push_subscriptions_cap BEFORE INSERT ON public.push_subscriptions FOR EACH ROW EXECUTE FUNCTION public.enforce_push_subscription_cap();

--
-- Name: signal_outcomes signal_outcomes_first_candle_checkpoint; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER signal_outcomes_first_candle_checkpoint BEFORE INSERT ON public.signal_outcomes FOR EACH ROW EXECUTE FUNCTION public.set_first_candle_checkpoint();

--
-- Name: signal_outcomes signal_outcomes_first_label_checkpoint; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER signal_outcomes_first_label_checkpoint BEFORE INSERT ON public.signal_outcomes FOR EACH ROW EXECUTE FUNCTION public.set_first_label_checkpoint();

--
-- Name: alert_log alert_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_log
    ADD CONSTRAINT alert_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.bench_owner(id) ON DELETE CASCADE;

--
-- Name: alert_settings alert_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_settings
    ADD CONSTRAINT alert_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.bench_owner(id) ON DELETE CASCADE;

--
-- Name: backtest_results backtest_results_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backtest_results
    ADD CONSTRAINT backtest_results_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.backtest_runs(id) ON DELETE CASCADE;

--
-- Name: backtest_runs backtest_runs_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backtest_runs
    ADD CONSTRAINT backtest_runs_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.bench_owner(id) ON DELETE SET NULL;

--
-- Name: backtest_trades backtest_trades_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backtest_trades
    ADD CONSTRAINT backtest_trades_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.backtest_runs(id) ON DELETE CASCADE;

--
-- Name: early_buyers early_buyers_mint_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.early_buyers
    ADD CONSTRAINT early_buyers_mint_fkey FOREIGN KEY (mint) REFERENCES public.wallet_study_state(mint) ON DELETE CASCADE;

--
-- Name: paper_legs paper_legs_position_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paper_legs
    ADD CONSTRAINT paper_legs_position_fkey FOREIGN KEY (position_id, user_id) REFERENCES public.paper_positions(id, user_id) ON DELETE CASCADE;

--
-- Name: paper_legs paper_legs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paper_legs
    ADD CONSTRAINT paper_legs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.bench_owner(id) ON DELETE CASCADE;

--
-- Name: paper_positions paper_positions_alert_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paper_positions
    ADD CONSTRAINT paper_positions_alert_id_fkey FOREIGN KEY (alert_id) REFERENCES public.alert_log(id) ON DELETE SET NULL;

--
-- Name: paper_positions paper_positions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paper_positions
    ADD CONSTRAINT paper_positions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.bench_owner(id) ON DELETE CASCADE;

--
-- Name: paper_wallets paper_wallets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paper_wallets
    ADD CONSTRAINT paper_wallets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.bench_owner(id) ON DELETE CASCADE;

--
-- Name: push_subscriptions push_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.bench_owner(id) ON DELETE CASCADE;

--
-- Name: signal_outcomes signal_outcomes_mint_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signal_outcomes
    ADD CONSTRAINT signal_outcomes_mint_fkey FOREIGN KEY (mint) REFERENCES public.tokens(mint) ON DELETE CASCADE;

--
-- Name: token_snapshots token_snapshots_mint_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_snapshots
    ADD CONSTRAINT token_snapshots_mint_fkey FOREIGN KEY (mint) REFERENCES public.tokens(mint) ON DELETE CASCADE;


RESET check_function_bodies;
