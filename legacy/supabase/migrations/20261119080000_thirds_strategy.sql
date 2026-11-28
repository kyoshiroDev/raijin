-- feat/strategy-lab, part A — strategy thirds_x2_x3_x4 and book young_thirds_x2_x3_x4 (docs/contracts/strategy-lab.md).
-- SIMULATION ONLY: no wallet, no key, no signature, no transaction.
--
-- What changes
--   strategy 'thirds_x2_x3_x4'   : 3 legs 33 / 33 / 34 %, TP x2 / x3 / x4, common SL (sl_pct). Stop ladder (applied
--                                  by paper-engine from paper.ts step(), persisted through paper_apply_v2 'moves'):
--                                  TP x2 hit → stops of the remaining legs = fill price (breakeven);
--                                  TP x3 hit → stop of the remaining leg = fill x 2.
--                                  Allowed by paper_positions_strategy_check, alert_settings_paper_strategy_check and
--                                  paper_open_position_as (paper_open_position delegates to it: body unchanged).
--   paper_legs.size_pct           : 33 and 34 allowed (thirds), on top of 50 and 100.
--   book 'young_thirds_x2_x3_x4'  : separate 1.0 SOL wallet (third « Jeune & fort » auto-paper book), allowed on
--                                  paper_wallets, paper_positions, paper_open_position_as and the wallet RPCs.
--   performance_by_preset()       : the young_strong paper P&L includes the third young book.
--   paper_apply_v2                : NOT changed. Its 'moves' already accept any stop_price in (0, 1e12) on a leg that
--                                  is still open, which covers both ladder moves (fill, then fill x 2). A stop at or
--                                  above the fill closes with the existing 'breakeven_hit' status, so the 12 h cooldown
--                                  (which counts 'sl_hit' only) is not triggered by a protected exit. Every check and
--                                  grant stays as in 20261118020000.
--
-- Security
--   No new table; RLS and policies unchanged. paper_open_position_as: security definer, search_path = '', EXECUTE for
--   service_role only (re-stated). Wallet RPCs: security definer, auth.uid() only, EXECUTE for authenticated
--   (re-stated). performance_by_preset: security invoker, EXECUTE for authenticated only (re-stated).

-- ---------------------------------------------------------------------------
-- 1. Checks
-- ---------------------------------------------------------------------------
alter table public.paper_wallets drop constraint paper_wallets_book_check;
alter table public.paper_wallets
  add constraint paper_wallets_book_check
    check (book in ('main', 'half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3', 'young_thirds_x2_x3_x4'));

alter table public.paper_positions drop constraint paper_positions_book_check;
-- The inline check of 20261118020000 is named paper_positions_strategy_check by Postgres.
alter table public.paper_positions drop constraint paper_positions_strategy_check;
alter table public.paper_positions
  add constraint paper_positions_book_check
    check (book in ('main', 'half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3', 'young_thirds_x2_x3_x4')),
  add constraint paper_positions_strategy_check
    check (strategy in ('half_x2_rest_x3', 'all_x2', 'thirds_x2_x3_x4', 'custom'));

-- The inline check of 20261118020000 is named paper_legs_size_pct_check by Postgres.
alter table public.paper_legs drop constraint paper_legs_size_pct_check;
alter table public.paper_legs
  add constraint paper_legs_size_pct_check check (size_pct in (33, 34, 50, 100));

alter table public.alert_settings drop constraint alert_settings_paper_strategy_check;
alter table public.alert_settings
  add constraint alert_settings_paper_strategy_check
    check (paper_default_strategy in ('half_x2_rest_x3', 'all_x2', 'thirds_x2_x3_x4'));

comment on column public.paper_wallets.book is
  'main = manual + single auto-paper; half_x2_rest_x3 / all_x2 = parallel auto-paper comparison books (Momentum / Strict); young_all_x2 / young_half_x2_rest_x3 / young_thirds_x2_x3_x4 = auto-paper of the « Jeune & fort » alerts.';
comment on table public.paper_legs is
  'Paper trading v2: exits of a position (33 / 34 / 50 / 100 %), own TP and stop. Status is meaningful while the position is open or closed.';
comment on column public.paper_legs.stop_price is
  'Current stop: the SL, then the fill price once TP x2 is hit (half_x2_rest_x3, thirds_x2_x3_x4), then fill x 2 once TP x3 is hit (thirds_x2_x3_x4).';

-- ---------------------------------------------------------------------------
-- 2. paper_open_position_as: same 12-argument signature and body as 20261119070000, plus the thirds legs
--    (create or replace: no new overload). Mirror of paper.ts planLegs, re-based on the fill price by paper-engine:
--      thirds_x2_x3_x4 → {33 %, entry x 2}, {33 %, entry x 3}, {34 %, entry x 4}; SL = entry x (1 - sl_pct/100)
-- ---------------------------------------------------------------------------
create or replace function public.paper_open_position_as(
  p_user       uuid,
  p_book       text,
  p_mint       text,
  p_strategy   text,
  p_stake      numeric,
  p_entry      numeric,
  p_sl_pct     numeric,
  p_custom_tp  numeric,
  p_custom_sl  numeric,
  p_source     text,
  p_alert_id   bigint,
  p_entry_mode text default 'target'
)
returns public.paper_positions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row       public.paper_positions;
  v_symbol    text;
  v_balance   numeric;
  v_committed numeric;
  v_active    integer;
  v_recent    integer;
  v_sl_pct    numeric;
  v_sl        numeric;
  v_tp        numeric;
  v_last_stop timestamptz;
  v_mode      text := coalesce(p_entry_mode, 'target');
  -- Keep in sync with paper.ts: NETWORK_FEE_PER_TX_SOL + TOKEN_ACCOUNT_RENT_SOL (reservedSol).
  c_overhead  constant numeric := 0.0002 + 0.00204;
begin
  if p_user is null then
    raise exception 'paper position: user required' using errcode = '23502';
  end if;
  if p_book is null or p_book not in ('main', 'half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3', 'young_thirds_x2_x3_x4') then
    raise exception 'paper position: invalid book' using errcode = '22023';
  end if;
  if p_strategy is null or p_strategy not in ('half_x2_rest_x3', 'all_x2', 'thirds_x2_x3_x4', 'custom') then
    raise exception 'paper position: invalid strategy' using errcode = '22023';
  end if;
  if p_source is null or p_source not in ('manual', 'auto_alert') then
    raise exception 'paper position: invalid source' using errcode = '22023';
  end if;
  if v_mode not in ('target', 'next_tick') then
    raise exception 'paper position: invalid entry mode' using errcode = '22023';
  end if;
  -- next_tick has no meaningful entry target (filled at the next scan snapshot): presets only, auto-paper only.
  if v_mode = 'next_tick' and (p_strategy = 'custom' or p_source <> 'auto_alert') then
    raise exception 'paper position: invalid entry mode' using errcode = '22023';
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

  if p_strategy = 'custom' then
    if p_custom_tp is null or p_custom_sl is null
       or not (p_custom_sl > 0 and p_custom_sl < p_entry and p_entry < p_custom_tp and p_custom_tp < 1e12) then
      raise exception 'paper position: custom levels must satisfy 0 < SL < entry < TP' using errcode = '22023';
    end if;
    v_sl := p_custom_sl;
    v_tp := p_custom_tp;
    v_sl_pct := least(90, greatest(1, round((1 - p_custom_sl / p_entry) * 100, 6)));
  else
    v_sl_pct := coalesce(p_sl_pct, 30);
    if not (v_sl_pct >= 1 and v_sl_pct <= 90) then
      raise exception 'paper position: invalid stop-loss percent (1-90)' using errcode = '22023';
    end if;
    v_sl := p_entry * (1 - v_sl_pct / 100);
    v_tp := null;
    -- Highest TP of the preset must stay storable.
    if p_entry * (case p_strategy when 'thirds_x2_x3_x4' then 4 when 'half_x2_rest_x3' then 3 else 2 end) >= 1e12 then
      raise exception 'paper position: invalid entry price' using errcode = '22023';
    end if;
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

  -- 12 h cooldown after a stop on this mint (any book).
  select max(l.closed_at) into v_last_stop
    from public.paper_legs l
    join public.paper_positions p on p.id = l.position_id and p.user_id = l.user_id
   where l.user_id = p_user
     and l.status = 'sl_hit'
     and l.closed_at > now() - interval '12 hours'
     and p.mint = p_mint;
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
    p_user, p_book, p_mint, v_symbol, p_strategy, p_stake, p_source, p_alert_id, 'pending', p_entry, v_sl,
    v_tp, v_sl_pct, now() + interval '24 hours', now(), v_mode
  )
  returning * into v_row;

  if p_strategy = 'half_x2_rest_x3' then
    insert into public.paper_legs (position_id, user_id, size_pct, tp_price, stop_price)
    values (v_row.id, p_user, 50, p_entry * 2, v_sl),
           (v_row.id, p_user, 50, p_entry * 3, v_sl);
  elsif p_strategy = 'thirds_x2_x3_x4' then
    -- Mirror of paper.ts planLegs: 33 / 33 / 34 %, TP x2 / x3 / x4, common SL (stop ladder applied by paper-engine).
    insert into public.paper_legs (position_id, user_id, size_pct, tp_price, stop_price)
    values (v_row.id, p_user, 33, p_entry * 2, v_sl),
           (v_row.id, p_user, 33, p_entry * 3, v_sl),
           (v_row.id, p_user, 34, p_entry * 4, v_sl);
  elsif p_strategy = 'all_x2' then
    insert into public.paper_legs (position_id, user_id, size_pct, tp_price, stop_price)
    values (v_row.id, p_user, 100, p_entry * 2, v_sl);
  else
    insert into public.paper_legs (position_id, user_id, size_pct, tp_price, stop_price)
    values (v_row.id, p_user, 100, v_tp, v_sl);
  end if;
  return v_row;
end;
$$;

comment on function public.paper_open_position_as(uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, text, bigint, text) is
  'service_role (auto-paper): opens a pending paper position + legs for p_user with every balance / cap / token check and the 12 h cooldown after a stop on the same mint. Strategies: half_x2_rest_x3 | all_x2 | thirds_x2_x3_x4 | custom. p_entry_mode: target (default) | next_tick (presets, auto_alert only).';

revoke execute on function public.paper_open_position_as(uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.paper_open_position_as(uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, text, bigint, text)
  to service_role;

-- Wallet RPCs (caller's own wallet): same bodies as 20261119070000, young_thirds_x2_x3_x4 added to the allowed list.
-- create or replace keeps the grants (authenticated, re-stated below).
create or replace function public.paper_ensure_wallet(p_book text default 'main')
returns public.paper_wallets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.paper_wallets;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_book is null or p_book not in ('main', 'half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3', 'young_thirds_x2_x3_x4') then
    raise exception 'paper wallet: invalid book' using errcode = '22023';
  end if;
  insert into public.paper_wallets (user_id, book) values (v_uid, p_book) on conflict (user_id, book) do nothing;
  select * into v_row from public.paper_wallets where user_id = v_uid and book = p_book;
  return v_row;
end;
$$;

create or replace function public.paper_reset_wallet(p_book text default 'main')
returns public.paper_wallets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.paper_wallets;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_book is null or p_book not in ('main', 'half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3', 'young_thirds_x2_x3_x4') then
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

revoke execute on function public.paper_ensure_wallet(text) from public, anon;
revoke execute on function public.paper_reset_wallet(text)  from public, anon;
grant execute on function public.paper_ensure_wallet(text)  to authenticated;
grant execute on function public.paper_reset_wallet(text)   to authenticated;

-- ---------------------------------------------------------------------------
-- 3. performance_by_preset(): same as 20261119070000, the third young book counted in young_strong (signature,
--    security invoker, search_path and grants unchanged; grants re-stated at the end of the body below).
-- ---------------------------------------------------------------------------
create or replace function public.performance_by_preset()
returns table (
  preset          text,
  segment         text,
  signals         integer,
  labelled        integer,
  x2_before_sl30  integer,
  sl30_before_x2  integer,
  sim_pnl_sol     numeric,
  trades          integer,
  paper_pnl_sol   numeric,
  paper_open      integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with grid as (
    select g.preset, g.segment, g.p_ord, g.s_ord
      from (values
        ('momentum', 'all', 1, 1), ('momentum', 'gta', 1, 2), ('momentum', 'other', 1, 3),
        ('young_strong', 'all', 2, 1), ('young_strong', 'gta', 2, 2), ('young_strong', 'other', 2, 3),
        ('young_strong', 'age_lt_3h', 2, 4), ('young_strong', 'age_3_24h', 2, 5),
        ('strict', 'all', 3, 1), ('strict', 'gta', 3, 2), ('strict', 'other', 3, 3)
      ) as g(preset, segment, p_ord, s_ord)
  ),
  sig as (
    select s.preset, seg.segment, s.x2_before_sl30 as x2, s.sl30_before_x2 as sl, s.entry_roundtrip_pct as rt
      from public.preset_signals s
     cross join lateral (values
       ('all'),
       (case when s.narrative = 'GTA' then 'gta' else 'other' end),
       (case
          when s.preset <> 'young_strong' or s.pair_age_h is null then null
          when s.pair_age_h < 3 then 'age_lt_3h'
          when s.pair_age_h < 24 then 'age_3_24h'
        end)
     ) as seg(segment)
     where seg.segment is not null
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
    select case
             when p.book in ('half_x2_rest_x3', 'all_x2') then 'momentum'
             when p.book in ('young_all_x2', 'young_half_x2_rest_x3', 'young_thirds_x2_x3_x4') then 'young_strong'
           end as preset,
           seg.segment, p.status, p.pnl_sol
      from public.paper_positions p
      left join public.tokens t on t.mint = p.mint
     cross join lateral (values
       ('all'),
       (case when t.narrative = 'GTA' then 'gta' else 'other' end),
       (case
          when p.book not in ('young_all_x2', 'young_half_x2_rest_x3', 'young_thirds_x2_x3_x4') or t.pair_created_at is null
               or t.pair_created_at > p.created_at then null
          when p.created_at - t.pair_created_at < interval '3 hours' then 'age_lt_3h'
          when p.created_at - t.pair_created_at < interval '24 hours' then 'age_3_24h'
        end)
     ) as seg(segment)
     where p.book in ('half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3', 'young_thirds_x2_x3_x4')
       and seg.segment is not null
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
         case when g.preset = 'strict' then null else coalesce(p.pnl, 0) end,
         coalesce(p.open, 0)
    from grid g
    left join sig_agg s on s.preset = g.preset and s.segment = g.segment
    left join pos_agg p on p.preset = g.preset and p.segment = g.segment
   order by g.p_ord, g.s_ord;
$$;

comment on function public.performance_by_preset() is
  'Per preset (momentum / young_strong / strict) and segment (all / gta / other / age_lt_3h / age_3_24h): preset_signals label counts, simulated all_x2 P&L from the labels, and the caller''s paper P&L of the preset books.';

revoke execute on function public.performance_by_preset() from public, anon;
grant execute on function public.performance_by_preset() to authenticated;
