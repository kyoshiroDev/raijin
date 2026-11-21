-- Raijin — paper trading (feat/paper-trading). SIMULATION ONLY: no wallet connection, no key, no signature, no
-- transaction is ever built or sent. Balances are fictitious SOL numbers in this database.
--
-- Tables
--   paper_wallets : one fictitious balance per user (1.0 SOL at creation / reset).
--   paper_orders  : simulated buy orders (limit entry or market) with TP / SL, executed by the paper-engine Edge
--                   Function against the scan's price snapshots (pure engine: supabase/functions/_shared/paper.ts).
-- Column
--   alert_settings.auto_paper : when true, scan-tokens places the default strategy (two halves, TP x2 / x3, SL -30 %)
--                               for each single alert delivered to the user (source = 'auto').
--
-- Wallet model (mirrors paper.ts, keep both in sync):
--   reserved(order) = stake + NETWORK_FEE_PER_TX_SOL (0.0002) + TOKEN_ACCOUNT_RENT_SOL (0.00204)  (reservedSol)
--   available       = balance_sol - sum(reserved(pending orders))                                 (committedSol)
--   fill            : balance -= reserved                                                          (walletDelta)
--   close (TP / SL) : balance += stake x exit / fill - fee + rent                                  (walletDelta)
--   expire / cancel of a pending order: nothing (the reservation simply disappears).
--
-- Security model
--   RLS enabled on both tables. anon: nothing (privileges revoked, no policy).
--   paper_wallets : authenticated = SELECT own row only. No INSERT / UPDATE / DELETE: the wallet is created by the
--                   insert trigger or paper_ensure_wallet(), reset by paper_reset_wallet(), and moved by the engine
--                   (paper_apply, service_role only).
--   paper_orders  : authenticated = SELECT own rows; INSERT own rows only, in status 'pending' with every execution
--                   column null (policy WITH CHECK) AND only through a column-level INSERT grant on the user-settable
--                   columns (mint, symbol, side, type, stake_sol, entry_price, tp_price, sl_price, group_id,
--                   expires_at). No UPDATE / DELETE: cancelling goes through paper_cancel_order(). Execution columns
--                   (status, fills, exits, fees, pnl) are written by paper_apply (service_role) only.
--   BEFORE INSERT trigger (security definer, search_path = '', owner checked against auth.uid() first because BEFORE
--   triggers run before the RLS WITH CHECK): forces engine-owned columns, requires a known token (public.tokens) and
--   takes the symbol from it (client symbol ignored: hostile text), creates the wallet if missing, locks it
--   (SELECT ... FOR UPDATE: concurrent inserts are serialised, no double spend), caps active orders (50) and orders
--   created per 24 h (200), and enforces available >= reserved(new order).
--   RPCs for users (security definer, search_path = '', every check on auth.uid(), EXECUTE to authenticated only):
--   paper_ensure_wallet(), paper_cancel_order(uuid), paper_reset_wallet().
--   Engine RPC paper_apply(uuid, text, jsonb, numeric): security invoker, EXECUTE service_role only.
--   Lock order everywhere: wallet row first, then order rows (no deadlock between reset, insert and apply).
--   TRUNCATE / REFERENCES / TRIGGER / MAINTAIN revoked (TRUNCATE bypasses RLS), like 20261116230000.
-- Upper bounds also reject 'Infinity' / 'NaN' (numeric accepts both).

-- ---------------------------------------------------------------------------
-- paper_wallets
-- ---------------------------------------------------------------------------
create table public.paper_wallets (
  user_id      uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  balance_sol  numeric not null default 1.0 check (balance_sol >= 0 and balance_sol < 1e6),
  created_at   timestamptz not null default now(),
  -- Last reset: stats are computed on orders created after it (positions open at reset time are abandoned).
  reset_at     timestamptz
);

comment on table public.paper_wallets is
  'Paper trading (simulation only): fictitious SOL balance per user. Written by triggers/RPCs and paper-engine only.';
comment on column public.paper_wallets.balance_sol is
  'Fictitious SOL. Open positions are already debited; pending orders are only reserved (see paper_orders).';
comment on column public.paper_wallets.reset_at is
  'Last paper_reset_wallet(): pending and open orders were cancelled, stats start here.';

-- ---------------------------------------------------------------------------
-- paper_orders
-- ---------------------------------------------------------------------------
create table public.paper_orders (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  mint         text not null check (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- Overwritten by the insert trigger with public.tokens.symbol (sanitised by scan-tokens); still bounded here.
  symbol       text not null check (
                 char_length(symbol) between 1 and 32
                 and symbol !~ '[\u0001-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\uFFF9-\uFFFB<>]'
               ),
  side         text not null default 'buy' check (side = 'buy'),
  type         text not null check (type in ('limit_entry', 'market')),
  stake_sol    numeric not null check (stake_sol >= 0.001 and stake_sol <= 100),
  entry_price  numeric check (entry_price is null or (entry_price > 0 and entry_price < 1e12)),
  tp_price     numeric check (tp_price is null or (tp_price > 0 and tp_price < 1e12)),
  sl_price     numeric check (sl_price is null or (sl_price > 0 and sl_price < 1e12)),
  status       text not null default 'pending'
               check (status in ('pending', 'open', 'tp_hit', 'sl_hit', 'cancelled', 'expired')),
  group_id     uuid,
  source       text not null default 'manual' check (source in ('manual', 'auto')),
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  filled_at    timestamptz,
  closed_at    timestamptz,
  fill_price   numeric check (fill_price is null or (fill_price > 0 and fill_price < 1e12)),
  exit_price   numeric check (exit_price is null or (exit_price > 0 and exit_price < 1e12)),
  fees_sol     numeric check (fees_sol is null or (fees_sol >= 0 and fees_sol < 1)),
  pnl_sol      numeric check (pnl_sol is null or (pnl_sol > -1e6 and pnl_sol < 1e6)),

  constraint paper_orders_limit_has_entry check (type <> 'limit_entry' or entry_price is not null),
  constraint paper_orders_levels check (
    (sl_price is null or entry_price is null or sl_price < entry_price)
    and (tp_price is null or entry_price is null or entry_price < tp_price)
    and (sl_price is null or tp_price is null or sl_price < tp_price)
  ),
  constraint paper_orders_expiry check (expires_at > created_at and expires_at <= created_at + interval '25 hours'),
  -- Execution columns consistent with the status.
  constraint paper_orders_status_columns check (
    case status
      when 'pending' then filled_at is null and fill_price is null and closed_at is null
                          and exit_price is null and pnl_sol is null
      when 'open' then filled_at is not null and fill_price is not null and closed_at is null
                       and exit_price is null and pnl_sol is null
      when 'tp_hit' then filled_at is not null and fill_price is not null and closed_at is not null
                         and exit_price is not null and pnl_sol is not null
      when 'sl_hit' then filled_at is not null and fill_price is not null and closed_at is not null
                         and exit_price is not null and pnl_sol is not null
      -- cancelled: a pending order (no fill) or an open position abandoned by paper_reset_wallet (fill kept).
      else closed_at is not null and exit_price is null and pnl_sol is null
    end
  )
);

comment on table public.paper_orders is
  'Paper trading (simulation only): simulated buy orders. Users create (pending) and cancel; paper-engine executes.';
comment on column public.paper_orders.symbol is 'Copied from public.tokens.symbol by the insert trigger (client value ignored).';
comment on column public.paper_orders.fill_price is 'Tick price x (1 + Jupiter buy impact, 2 % if unknown).';
comment on column public.paper_orders.exit_price is 'Tick price x (1 - Jupiter sell impact, 2 % if unknown).';
comment on column public.paper_orders.fees_sol is 'Network fees charged so far (entry, then entry + exit). Rent is not a fee.';
comment on column public.paper_orders.pnl_sol is 'stake x (exit / fill - 1) - 2 network fees (closed trades only).';
comment on column public.paper_orders.source is 'manual = created by the user; auto = auto_paper strategy placed by scan-tokens.';

create index paper_orders_user_status_idx  on public.paper_orders (user_id, status);
create index paper_orders_user_created_idx on public.paper_orders (user_id, created_at desc);
create index paper_orders_active_idx       on public.paper_orders (status) where status in ('pending', 'open');
create index paper_orders_active_mint_idx  on public.paper_orders (mint) where status in ('pending', 'open');

-- ---------------------------------------------------------------------------
-- alert_settings.auto_paper (owner-editable like the other preferences: table-level grants + owner policies)
-- ---------------------------------------------------------------------------
alter table public.alert_settings
  add column auto_paper boolean not null default false;

comment on column public.alert_settings.auto_paper is
  'Paper trading: place the default strategy (2 halves of stake_sol, TP x2 / x3, SL -30 %) on each single alert delivered.';

-- ---------------------------------------------------------------------------
-- BEFORE INSERT trigger on paper_orders
-- security definer: it must create / lock the wallet, which users can neither insert nor update.
-- ---------------------------------------------------------------------------
create function public.paper_orders_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_symbol    text;
  v_balance   numeric;
  v_committed numeric;
  v_active    integer;
  v_recent    integer;
  -- Keep in sync with paper.ts: NETWORK_FEE_PER_TX_SOL + TOKEN_ACCOUNT_RENT_SOL (reservedSol).
  c_overhead  constant numeric := 0.0002 + 0.00204;
begin
  -- Owner check FIRST: BEFORE triggers run before the RLS WITH CHECK, so never touch another user's wallet.
  if v_uid is not null then
    if new.user_id is distinct from v_uid then
      raise exception 'paper order: not owner' using errcode = '42501';
    end if;
    new.source := 'manual';
  elsif coalesce(auth.role(), 'service_role') <> 'service_role' then
    raise exception 'paper order: not allowed' using errcode = '42501';
  end if;
  if new.user_id is null then
    raise exception 'paper order: user required' using errcode = '23502';
  end if;

  -- Engine-owned columns: always a fresh pending order, whatever the caller sent.
  new.status     := 'pending';
  new.side       := 'buy';
  new.created_at := now();
  new.filled_at  := null;
  new.closed_at  := null;
  new.fill_price := null;
  new.exit_price := null;
  new.fees_sol   := null;
  new.pnl_sol    := null;

  -- Only tokens Raijin knows (also guarantees the FK of the forced 'tracking' snapshots); symbol from the server.
  select t.symbol into v_symbol from public.tokens t where t.mint = new.mint;
  if not found then
    raise exception 'paper order: unknown token' using errcode = '23503';
  end if;
  new.symbol := v_symbol;

  -- Wallet: created with 1.0 SOL if missing, then locked (serialises concurrent inserts / applies / resets).
  insert into public.paper_wallets (user_id) values (new.user_id) on conflict (user_id) do nothing;
  select w.balance_sol into v_balance from public.paper_wallets w where w.user_id = new.user_id for update;

  select count(*) filter (where o.status in ('pending', 'open')),
         count(*) filter (where o.created_at > now() - interval '24 hours'),
         coalesce(sum(o.stake_sol + c_overhead) filter (where o.status = 'pending'), 0)
    into v_active, v_recent, v_committed
    from public.paper_orders o
   where o.user_id = new.user_id
     and (o.status in ('pending', 'open') or o.created_at > now() - interval '24 hours');

  if v_active >= 50 then
    raise exception 'paper order: too many active orders (max 50)' using errcode = '23514';
  end if;
  if v_recent >= 200 then
    raise exception 'paper order: too many orders in 24 h (max 200)' using errcode = '23514';
  end if;
  if v_balance - v_committed - (new.stake_sol + c_overhead) < 0 then
    raise exception 'paper order: insufficient paper balance' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger paper_orders_before_insert
  before insert on public.paper_orders
  for each row execute function public.paper_orders_before_insert();

-- ---------------------------------------------------------------------------
-- User RPCs (security definer, minimal, auth.uid() only)
-- ---------------------------------------------------------------------------

-- Creates the caller's 1.0 SOL wallet if missing and returns it.
create function public.paper_ensure_wallet()
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
  insert into public.paper_wallets (user_id) values (v_uid) on conflict (user_id) do nothing;
  select * into v_row from public.paper_wallets where user_id = v_uid;
  return v_row;
end;
$$;

-- Cancels one of the caller's PENDING orders. true = cancelled, false = not found / not yours / not pending.
-- No balance change: a pending order is only reserved, never debited.
create function public.paper_cancel_order(p_id uuid)
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
  update public.paper_orders
     set status = 'cancelled', closed_at = now()
   where id = p_id and user_id = v_uid and status = 'pending';
  return found;
end;
$$;

-- Resets the caller's wallet to 1.0 SOL. Pending orders AND open positions are cancelled: open positions are
-- abandoned without P&L (fill kept for history), the stats start at reset_at. Lock order: wallet, then orders.
create function public.paper_reset_wallet()
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
  insert into public.paper_wallets (user_id) values (v_uid) on conflict (user_id) do nothing;
  update public.paper_wallets
     set balance_sol = 1.0, reset_at = now()
   where user_id = v_uid
  returning * into v_row;
  update public.paper_orders
     set status = 'cancelled', closed_at = now()
   where user_id = v_uid and status in ('pending', 'open');
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Engine RPC (service_role only): one order transition + its wallet delta, atomically.
-- p_patch = { status, fill_price?, exit_price?, fees_sol?, pnl_sol? } built by _shared/paper-engine.ts from decide().
--   fees_sol is the fee of THIS action (added to the order's total); filled_at / closed_at = now() (server clock).
-- Optimistic: the order is updated only if its status is still p_expected (no double fill / close).
-- Returns the new balance, or null when nothing was applied (status changed meanwhile, unknown order, or the
-- balance would go negative — impossible with the insert-time reservation, then the order simply expires later).
-- ---------------------------------------------------------------------------
create function public.paper_apply(p_order uuid, p_expected text, p_patch jsonb, p_delta numeric)
returns numeric
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_status  text;
  v_user    uuid;
  v_balance numeric;
  v_new     numeric;
  v_fill    numeric;
  v_exit    numeric;
  v_fee     numeric;
  v_pnl     numeric;
begin
  if p_order is null or p_expected is null or p_patch is null or jsonb_typeof(p_patch) <> 'object'
     or p_delta is null or p_delta = 'NaN'::numeric or abs(p_delta) >= 1e6 then
    raise exception 'paper_apply: invalid input' using errcode = '22023';
  end if;
  v_status := p_patch ->> 'status';
  if not ((p_expected = 'pending' and v_status in ('open', 'expired'))
          or (p_expected = 'open' and v_status in ('tp_hit', 'sl_hit'))) then
    raise exception 'paper_apply: invalid transition' using errcode = '22023';
  end if;
  -- Delta sign consistent with the transition (walletDelta): fill debits, close credits, expiry is free.
  if (v_status = 'open' and p_delta >= 0)
     or (v_status = 'expired' and p_delta <> 0)
     or (v_status in ('tp_hit', 'sl_hit') and p_delta <= 0) then
    raise exception 'paper_apply: delta inconsistent with transition' using errcode = '22023';
  end if;
  v_fill := (p_patch ->> 'fill_price')::numeric;
  v_exit := (p_patch ->> 'exit_price')::numeric;
  v_fee  := coalesce((p_patch ->> 'fees_sol')::numeric, 0);
  v_pnl  := (p_patch ->> 'pnl_sol')::numeric;
  if v_fee < 0 or v_fee >= 1 then
    raise exception 'paper_apply: invalid fee' using errcode = '22023';
  end if;

  select o.user_id into v_user from public.paper_orders o where o.id = p_order;
  if not found then
    return null;
  end if;

  -- Wallet first (same lock order as the insert trigger and paper_reset_wallet).
  insert into public.paper_wallets (user_id) values (v_user) on conflict (user_id) do nothing;
  select w.balance_sol into v_balance from public.paper_wallets w where w.user_id = v_user for update;
  v_new := v_balance + p_delta;
  if v_new < 0 then
    return null;
  end if;

  update public.paper_orders o
     set status     = v_status,
         filled_at  = case when v_status = 'open' then now() else o.filled_at end,
         fill_price = case when v_status = 'open' then v_fill else o.fill_price end,
         closed_at  = case when v_status = 'open' then null else now() end,
         exit_price = case when v_status in ('tp_hit', 'sl_hit') then v_exit else o.exit_price end,
         pnl_sol    = case when v_status in ('tp_hit', 'sl_hit') then v_pnl else o.pnl_sol end,
         fees_sol   = case when v_status = 'expired' then o.fees_sol else coalesce(o.fees_sol, 0) + v_fee end
   where o.id = p_order
     and o.status = p_expected;
  if not found then
    return null; -- already applied by another run, cancelled, or reset: idempotent no-op
  end if;

  if p_delta <> 0 then
    update public.paper_wallets set balance_sol = v_new where user_id = v_user;
  end if;
  return v_new;
end;
$$;

comment on function public.paper_apply(uuid, text, jsonb, numeric) is
  'paper-engine (service_role): applies one order transition and its wallet delta atomically; null = not applied.';

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on public.paper_wallets, public.paper_orders from anon;
revoke all on public.paper_wallets, public.paper_orders from authenticated;

grant select on public.paper_wallets to authenticated;
grant select on public.paper_orders  to authenticated;
-- Column-level INSERT: user_id (default auth.uid()), status, source, created_at and every execution column are
-- NOT insertable by users. symbol is accepted but replaced by the trigger.
grant insert (mint, symbol, side, type, stake_sol, entry_price, tp_price, sl_price, group_id, expires_at)
  on public.paper_orders to authenticated;

-- Supabase's default privileges grant EXECUTE to anon/authenticated directly (not only via PUBLIC).
revoke execute on function public.paper_orders_before_insert()                    from public, anon, authenticated;
revoke execute on function public.paper_ensure_wallet()                           from public, anon;
revoke execute on function public.paper_cancel_order(uuid)                        from public, anon;
revoke execute on function public.paper_reset_wallet()                            from public, anon;
revoke execute on function public.paper_apply(uuid, text, jsonb, numeric)          from public, anon, authenticated;
grant  execute on function public.paper_ensure_wallet()                           to authenticated;
grant  execute on function public.paper_cancel_order(uuid)                        to authenticated;
grant  execute on function public.paper_reset_wallet()                            to authenticated;
grant  execute on function public.paper_apply(uuid, text, jsonb, numeric)          to service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.paper_wallets enable row level security;
alter table public.paper_orders  enable row level security;

create policy "users read their paper wallet"
  on public.paper_wallets for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "users read their paper orders"
  on public.paper_orders for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "users create their pending paper orders"
  on public.paper_orders for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and status = 'pending'
    and source = 'manual'
    and filled_at is null and closed_at is null
    and fill_price is null and exit_price is null
    and fees_sol is null and pnl_sol is null
  );

-- No update / delete policy for authenticated on either table; none at all for anon.

-- Realtime (postgres_changes) for the portfolio screen: delivery is filtered by the SELECT policy above (own rows).
alter publication supabase_realtime add table public.paper_orders;
