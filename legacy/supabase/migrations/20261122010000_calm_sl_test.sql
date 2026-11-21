-- feat/calm-sl-test — phase 2 « Test du stop sur Jeune calme ». SIMULATION ONLY (no wallet, no key, no transaction).
-- No applied migration is modified; nothing is dropped.
--
-- What changes
--   paper books           : + 'calm_sl30' (« Calme · stop 30 % »), 'calm_sl40' (« Calme · stop 40 % »), 'frenzy_sl30'
--                           (« Frénésie · stop 30 % », control, never alerted). Separate 1.0 SOL wallets (created now for
--                           every auto_paper user, otherwise at the first position like every book). Books
--                           calm_all_x2 / frenzy_all_x2 ARCHIVED: no new position (paper_open_position_as refuses them),
--                           history kept, their positions still pending / open run to completion (paper-engine).
--   paper_positions       : unique partial index = at most ONE pending / open position per (user, book, mint) in the
--                           three test books (safety net of the RPC check).
--   paper_open_position_as: same 12-argument signature, attributes and grants; books main / calm_sl30 / calm_sl40 /
--                           frenzy_sl30; every check kept (advisory lock, all wallets locked FOR UPDATE, caps 50 active /
--                           200 per 24 h, balance, alert link, token check, next_tick rules, 12 h stop cooldown). For the
--                           test books: fixed recipe all_x2 + auto_alert + next_tick + stake 0.1 SOL + stop 30 %
--                           (calm_sl30, frenzy_sl30) or 40 % (calm_sl40); no new position while one is pending / open on
--                           the mint in that book (replaces the « once forever » rule of the archived books); the 12 h
--                           cooldown after a stop is counted IN THAT BOOK (a stop in calm_sl30 must not keep calm_sl40
--                           out, it would bias the stop comparison). Book main keeps the cooldown over every book.
--   paper_ensure_wallet / paper_reset_wallet: books main / calm_sl30 / calm_sl40 / frenzy_sl30.
--   signal_outcomes       : + pair_age_h (generated, stored) = pair age at the detection in hours, from
--                           features.log_age_h (a value known at the detection): label-outcomes reads the 1-minute
--                           candles of the detections < 24 h first (absolute priority).
--   paper_book_comparison(): per test book (calm_sl30, calm_sl40, frenzy_sl30) the caller's closed trades, % TP, % SL,
--                           P&L, max drawdown from peak (chronological by closed_at), worst losing streak, open positions,
--                           target 50 (Performance comparison card).
-- Not here: the backfill of signal_outcomes.features (supabase/sql/backfill_detection_features.sql, run by hand AFTER
-- review).
--
-- Security
--   No new table, no new policy, no grant change on tables. RLS stays enabled everywhere. The new column inherits the
--   table grants (signal_outcomes: SELECT for authenticated, writes service_role only; a generated column cannot be
--   written at all). paper_open_position_as: security definer, search_path = '', EXECUTE service_role only (re-stated).
--   Wallet RPCs: security definer, auth.uid() only, EXECUTE authenticated only (re-stated). paper_book_comparison():
--   security invoker (caller's RLS: own wallets / positions / legs only), search_path = '', stable, no argument,
--   EXECUTE authenticated only. Every CHECK stays valid for the existing rows (lists only extended).

-- ---------------------------------------------------------------------------
-- 1. Books
-- ---------------------------------------------------------------------------
alter table public.paper_wallets drop constraint paper_wallets_book_check;
alter table public.paper_wallets
  add constraint paper_wallets_book_check
    check (book in ('main', 'half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3', 'young_thirds_x2_x3_x4',
                    'calm_all_x2', 'frenzy_all_x2', 'calm_sl30', 'calm_sl40', 'frenzy_sl30'));

alter table public.paper_positions drop constraint paper_positions_book_check;
alter table public.paper_positions
  add constraint paper_positions_book_check
    check (book in ('main', 'half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3', 'young_thirds_x2_x3_x4',
                    'calm_all_x2', 'frenzy_all_x2', 'calm_sl30', 'calm_sl40', 'frenzy_sl30'));

comment on column public.paper_wallets.book is
  'main = manual positions; calm_sl30 / calm_sl40 / frenzy_sl30 = auto-paper test books of feat/calm-sl-test (every scan, independent of alerts, all_x2, 0.1 SOL, next scan price, stop 30 / 40 / 30 %). ARCHIVED (history only, no new position): calm_all_x2 / frenzy_all_x2 (2026-11-22), half_x2_rest_x3 / all_x2 / young_* (2026-11-21).';

-- At most one pending / open position per (user, book, mint) in the test books (the RPC checks it under the lock first).
create unique index paper_positions_test_books_active_idx on public.paper_positions (user_id, book, mint)
  where book in ('calm_sl30', 'calm_sl40', 'frenzy_sl30') and status in ('pending', 'open');

-- 1.0 SOL wallets of the test books for the users who already have auto-paper on (others: created by the first
-- position or by paper_ensure_wallet, same defaults).
insert into public.paper_wallets (user_id, book)
select s.user_id, b.book
  from public.alert_settings s
 cross join (values ('calm_sl30'), ('calm_sl40'), ('frenzy_sl30')) as b(book)
 where s.auto_paper = true
on conflict (user_id, book) do nothing;

-- ---------------------------------------------------------------------------
-- 2. paper_open_position_as: books main + the three test books
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
$$;

comment on function public.paper_open_position_as(uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, text, bigint, text) is
  'service_role (auto-paper): opens a pending all_x2 paper position + its leg for p_user in book main / calm_sl30 / calm_sl40 / frenzy_sl30, with every balance / cap / token check and the 12 h cooldown after a stop on the same mint (same book for the test books, any book for main). Test books: auto_alert + next_tick + 0.1 SOL + stop 30 % (calm_sl30, frenzy_sl30) / 40 % (calm_sl40) only, no new position while one is pending / open on the mint in the book. calm_all_x2 / frenzy_all_x2 archived (refused).';

revoke execute on function public.paper_open_position_as(uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.paper_open_position_as(uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, text, bigint, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. Wallet RPCs (caller's own wallet): main + the three test books
-- ---------------------------------------------------------------------------
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
  if p_book is null or p_book not in ('main', 'calm_sl30', 'calm_sl40', 'frenzy_sl30') then
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

revoke execute on function public.paper_ensure_wallet(text) from public, anon;
revoke execute on function public.paper_reset_wallet(text)  from public, anon;
grant execute on function public.paper_ensure_wallet(text)  to authenticated;
grant execute on function public.paper_reset_wallet(text)   to authenticated;

-- ---------------------------------------------------------------------------
-- 4. signal_outcomes.pair_age_h (candle queue priority)
-- ---------------------------------------------------------------------------
-- features.log_age_h = ln(1 + pair age in hours at the detection), clamped to [0, 12] by features.ts: a value known at
-- the detection (no look-ahead, unlike tokens.pair_created_at whose best pair may have changed since).
alter table public.signal_outcomes
  add column pair_age_h numeric generated always as (
    case when jsonb_typeof(features -> 'log_age_h') = 'number'
         then round((exp(least(greatest((features ->> 'log_age_h')::double precision, 0), 12)) - 1)::numeric, 3)
    end
  ) stored;

comment on column public.signal_outcomes.pair_age_h is
  'Pair age at the detection, hours (generated from features.log_age_h). null = unknown. label-outcomes captures the 1-minute candles of detections < 24 h first.';

-- ---------------------------------------------------------------------------
-- 5. paper_book_comparison(): Performance comparison card of the test books
-- ---------------------------------------------------------------------------
create or replace function public.paper_book_comparison()
returns table (
  book                text,
  trades              integer,
  tp_hits             integer,
  sl_hits             integer,
  tp_pct              numeric,
  sl_pct              numeric,
  pnl_sol             numeric,
  max_drawdown_sol    numeric,
  max_drawdown_pct    numeric,
  worst_losing_streak integer,
  open_positions      integer,
  target_trades       integer,
  balance_sol         numeric,
  initial_sol         numeric,
  since               timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  with books(book, ord) as (
    values ('calm_sl30', 1), ('calm_sl40', 2), ('frenzy_sl30', 3)
  ),
  w as (
    select w.book, w.balance_sol, w.initial_sol, w.reset_at
      from public.paper_wallets w
     where w.user_id = (select auth.uid())
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
     where p.user_id = (select auth.uid())
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

comment on function public.paper_book_comparison() is
  'Per test book (calm_sl30, calm_sl40, frenzy_sl30), the caller''s positions since the book''s last reset: closed trades, TP / SL counts and % (null with 0 trade), P&L SOL, max drawdown from the running peak of the realised P&L curve (chronological by closed_at, id; SOL and % of the peak equity initial + peak), worst losing streak (consecutive closed trades with pnl < 0), pending + open positions, target 50 trades, wallet balance / initial / last reset. security invoker: RLS of the caller.';

revoke execute on function public.paper_book_comparison() from public, anon;
grant execute on function public.paper_book_comparison() to authenticated;

-- ---------------------------------------------------------------------------
-- paper_cancel_position: manual cancel limited to the main book (security review L1). Positions of the test books
-- (calm_sl30 / calm_sl40 / frenzy_sl30) and of archived books are engine-only: a user cancelling them would bias the
-- stop comparison. Same signature, attributes and grants as 20261118020000.
-- ---------------------------------------------------------------------------
create or replace function public.paper_cancel_position(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
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

revoke execute on function public.paper_cancel_position(uuid) from public, anon;
grant execute on function public.paper_cancel_position(uuid) to authenticated;
