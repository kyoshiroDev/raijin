-- fix/measurement-and-criteria — paper trading (SIMULATION ONLY): 12 h cooldown after a stop.
-- paper_open_position_as (auto-paper, service_role) refuses a new position on (user, mint) when a leg of a position of
-- that user on that mint closed with status 'sl_hit' in the last 12 h, whatever the book. paper_open_position (manual,
-- authenticated) delegates to it, so the user gets the same refusal with a French message:
--   « Stop touché il y a moins de 12 h sur ce token : pas de nouvelle position avant HH:MM. » (Europe/Paris)
-- errcode 23514 like the other caps. The auto path (notify.ts) treats any RPC error as « skipped ».
-- The check runs after the per-user advisory lock and the wallet locks, like the caps.
-- Everything else is unchanged from 20261118020000_paper_trading_v2.sql: signature, security definer,
-- search_path = '', grants (re-stated below), checks.

create index if not exists paper_legs_user_sl_closed_idx on public.paper_legs (user_id, closed_at desc)
  where status = 'sl_hit';

create or replace function public.paper_open_position_as(
  p_user      uuid,
  p_book      text,
  p_mint      text,
  p_strategy  text,
  p_stake     numeric,
  p_entry     numeric,
  p_sl_pct    numeric,
  p_custom_tp numeric,
  p_custom_sl numeric,
  p_source    text,
  p_alert_id  bigint
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
  -- Keep in sync with paper.ts: NETWORK_FEE_PER_TX_SOL + TOKEN_ACCOUNT_RENT_SOL (reservedSol).
  c_overhead  constant numeric := 0.0002 + 0.00204;
begin
  if p_user is null then
    raise exception 'paper position: user required' using errcode = '23502';
  end if;
  if p_book is null or p_book not in ('main', 'half_x2_rest_x3', 'all_x2') then
    raise exception 'paper position: invalid book' using errcode = '22023';
  end if;
  if p_strategy is null or p_strategy not in ('half_x2_rest_x3', 'all_x2', 'custom') then
    raise exception 'paper position: invalid strategy' using errcode = '22023';
  end if;
  if p_source is null or p_source not in ('manual', 'auto_alert') then
    raise exception 'paper position: invalid source' using errcode = '22023';
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
    if p_entry * (case when p_strategy = 'half_x2_rest_x3' then 3 else 2 end) >= 1e12 then
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

  -- Wallet of the book created at 1.0 SOL if missing; then EVERY wallet of the user is locked in book order: concurrent
  -- opens (any book) are serialised, so the per-user caps and the book's available balance cannot be overrun.
  -- Per-user mutex first: rows inserted by another uncommitted transaction are invisible to FOR UPDATE, so two parallel
  -- opens for a user with no wallet yet could otherwise both pass the caps.
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
    custom_tp_price, sl_pct, expires_at, created_at
  ) values (
    p_user, p_book, p_mint, v_symbol, p_strategy, p_stake, p_source, p_alert_id, 'pending', p_entry, v_sl,
    v_tp, v_sl_pct, now() + interval '24 hours', now()
  )
  returning * into v_row;

  if p_strategy = 'half_x2_rest_x3' then
    insert into public.paper_legs (position_id, user_id, size_pct, tp_price, stop_price)
    values (v_row.id, p_user, 50, p_entry * 2, v_sl),
           (v_row.id, p_user, 50, p_entry * 3, v_sl);
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

comment on function public.paper_open_position_as(uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, text, bigint) is
  'service_role (auto-paper): opens a pending paper position + legs for p_user with every balance / cap / token check and the 12 h cooldown after a stop on the same mint.';

-- Manual entry point: unchanged body (delegates to paper_open_position_as, which carries the cooldown).
create or replace function public.paper_open_position(
  p_mint      text,
  p_strategy  text,
  p_stake     numeric,
  p_entry     numeric,
  p_sl_pct    numeric default 30,
  p_custom_tp numeric default null,
  p_custom_sl numeric default null,
  p_book      text default 'main'
)
returns public.paper_positions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  -- Manual positions always go to the 'main' book: the comparison books are reserved to auto-paper so their
  -- stats compare the two strategies on the same alerts (p_book is kept in the signature for compatibility).
  if p_book is not null and p_book <> 'main' then
    raise exception 'paper position: invalid book' using errcode = '22023';
  end if;
  return public.paper_open_position_as(
    v_uid, 'main', p_mint, p_strategy, p_stake, p_entry, p_sl_pct, p_custom_tp, p_custom_sl,
    'manual', null
  );
end;
$$;

comment on function public.paper_open_position(text, text, numeric, numeric, numeric, numeric, numeric, text) is
  'Opens a pending paper position (simulation) for the caller. Errors: paper position: insufficient paper balance / too many … / unknown token / invalid …; « Stop touché il y a moins de 12 h sur ce token … » (cooldown).';

-- Privileges (create or replace keeps them; re-stated for clarity).
revoke execute on function public.paper_open_position_as(uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, text, bigint)
  from public, anon, authenticated;
revoke execute on function public.paper_open_position(text, text, numeric, numeric, numeric, numeric, numeric, text)
  from public, anon;
grant execute on function public.paper_open_position_as(uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, text, bigint)
  to service_role;
grant execute on function public.paper_open_position(text, text, numeric, numeric, numeric, numeric, numeric, text)
  to authenticated;
