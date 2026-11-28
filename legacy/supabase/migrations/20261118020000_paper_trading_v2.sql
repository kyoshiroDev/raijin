-- Raijin — paper trading v2 (feat/paper-trading-v2). SIMULATION ONLY: no wallet connection, no key, no signature,
-- no transaction is ever built or sent. Balances are fictitious SOL numbers in this database.
--
-- What changes
--   paper_wallets   : one wallet per (user, book). book = 'main' (manual + single auto-paper) or one book per
--                     preset strategy ('half_x2_rest_x3', 'all_x2') for the parallel auto-paper comparison.
--                     initial_sol = balance after creation / reset. Existing rows become book 'main'.
--   paper_positions : one simulated entry (stake bought once at fill_price) with a strategy and 1..2 legs.
--   paper_legs      : the exits of a position (size_pct 50 / 100), each with its own TP and stop (SL, or the fill
--                     price after the breakeven move of half_x2_rest_x3). Pure engine: _shared/paper.ts (v2).
--   alert_settings  : paper_default_strategy, paper_sl_pct, auto_paper_parallel (auto_paper exists since v1).
--   paper_orders    : converted into positions + legs (DATA MIGRATION below), then renamed paper_orders_v1 and
--                     frozen (no privilege for anon / authenticated, out of the realtime publication, v1 RPCs and
--                     insert trigger dropped).
--
-- Wallet model (mirrors paper.ts v2 reservedSol / walletDelta, keep both in sync):
--   reserved(pending position) = stake + NETWORK_FEE_PER_TX_SOL (0.0002) + TOKEN_ACCOUNT_RENT_SOL (0.00204)
--                                (exit fees are paid out of each leg's proceeds, never reserved)
--   available(book)            = balance_sol - sum(reserved(pending positions of that book))
--   fill                       : balance -= stake + entry fee + rent
--   leg closes                 : balance += sum(stake x size/100 x exit / fill) - exit fees (+ rent when the position
--                                closes)
--   expire / cancel of a pending position: nothing (the reservation simply disappears).
--
-- Security model
--   RLS enabled on every table. anon: nothing (privileges revoked, no policy).
--   authenticated: SELECT own rows only on paper_wallets, paper_positions, paper_legs (owner policies). NO INSERT,
--   UPDATE, DELETE privilege at all on these tables: every write goes through a function.
--   User RPCs (security definer, search_path = '', identity = auth.uid() only, EXECUTE to authenticated only):
--     paper_open_position(p_mint, p_strategy, p_stake, p_entry, p_sl_pct, p_custom_tp, p_custom_sl, p_book)
--       → creates the position AND its legs atomically (levels computed in SQL, mirror of planLegs), with every check:
--         known token (symbol copied from public.tokens), bounds, wallet locked (FOR UPDATE: no double spend),
--         caps 50 active / 200 created per 24 h per user (all books), available >= reserved.
--     paper_cancel_position(p_id)       → own PENDING position only.
--     paper_reset_wallet(p_book)        → balance = initial_sol, own pending/open positions of that book cancelled.
--     paper_ensure_wallet(p_book)       → creates the wallet (1.0 SOL) if missing and returns it.
--   Service-role functions (EXECUTE service_role only):
--     paper_open_position_as(p_user, …, p_source, p_alert_id) : the core of paper_open_position, used by auto-paper
--       (scan-tokens) with source 'auto_alert' and the alert_log id (checked: same user, same mint, kind 'single').
--     paper_apply_v2(p_position, p_expected, p_step, p_delta) : security INVOKER, one engine step (fill / expire /
--       legs) + its wallet delta in one transaction, optimistic status guard, idempotent.
--   Lock order everywhere: wallet row(s) first, then the position row, then its legs (no deadlock between open,
--   reset, cancel and apply).
--   TRUNCATE / REFERENCES / TRIGGER / MAINTAIN revoked (revoke all), like 20261116230000.
-- Upper bounds also reject 'Infinity' / 'NaN' (numeric accepts both; NaN sorts above every number).

-- ---------------------------------------------------------------------------
-- 0. v1 table leaves the realtime publication (it is frozen below).
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication_tables
              where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'paper_orders') then
    alter publication supabase_realtime drop table public.paper_orders;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. paper_wallets v2: (user_id, book) primary key, initial_sol.
-- ---------------------------------------------------------------------------
alter table public.paper_wallets
  add column book text not null default 'main'
    constraint paper_wallets_book_check check (book in ('main', 'half_x2_rest_x3', 'all_x2')),
  add column initial_sol numeric not null default 1.0
    constraint paper_wallets_initial_check check (initial_sol >= 0.01 and initial_sol <= 1000);

alter table public.paper_wallets drop constraint paper_wallets_pkey;
alter table public.paper_wallets add constraint paper_wallets_pkey primary key (user_id, book);

comment on table public.paper_wallets is
  'Paper trading (simulation only): fictitious SOL balance per user and book. Written by functions and paper-engine only.';
comment on column public.paper_wallets.book is
  'main = manual + single auto-paper; half_x2_rest_x3 / all_x2 = parallel auto-paper comparison books.';
comment on column public.paper_wallets.initial_sol is 'Balance at creation and after paper_reset_wallet().';
comment on column public.paper_wallets.balance_sol is
  'Fictitious SOL. Open positions are already debited; pending positions are only reserved (see paper_positions).';
comment on column public.paper_wallets.reset_at is
  'Last paper_reset_wallet() of this book: pending and open positions were cancelled, stats start here.';

-- ---------------------------------------------------------------------------
-- 2. paper_positions
-- ---------------------------------------------------------------------------
create table public.paper_positions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users (id) on delete cascade,
  book                text not null default 'main' check (book in ('main', 'half_x2_rest_x3', 'all_x2')),
  mint                text not null check (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- Copied from public.tokens.symbol (sanitised by scan-tokens) by the insert trigger; still bounded here.
  symbol              text not null check (
                        char_length(symbol) between 1 and 32
                        and symbol !~ '[\u0001-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\uFFF9-\uFFFB<>]'
                      ),
  strategy            text not null check (strategy in ('half_x2_rest_x3', 'all_x2', 'custom')),
  stake_sol           numeric not null check (stake_sol >= 0.001 and stake_sol <= 100),
  source              text not null default 'manual' check (source in ('manual', 'auto_alert')),
  alert_id            bigint references public.alert_log (id) on delete set null,
  status              text not null default 'pending'
                      check (status in ('pending', 'open', 'closed', 'cancelled', 'expired')),
  entry_target_price  numeric not null check (entry_target_price > 0 and entry_target_price < 1e12),
  fill_price          numeric check (fill_price is null or (fill_price > 0 and fill_price < 1e12)),
  sl_price            numeric not null check (sl_price > 0 and sl_price < 1e12),
  custom_tp_price     numeric check (custom_tp_price is null or (custom_tp_price > 0 and custom_tp_price < 1e12)),
  sl_pct              numeric not null default 30 check (sl_pct >= 1 and sl_pct <= 90),
  expires_at          timestamptz not null,
  created_at          timestamptz not null default now(),
  filled_at           timestamptz,
  closed_at           timestamptz,
  pnl_sol             numeric check (pnl_sol is null or (pnl_sol > -1e6 and pnl_sol < 1e6)),
  fees_sol            numeric check (fees_sol is null or (fees_sol >= 0 and fees_sol < 1)),

  -- (id, user_id) referenced by paper_legs: a leg always belongs to the owner of its position.
  constraint paper_positions_id_user_key unique (id, user_id),
  constraint paper_positions_custom_tp check ((strategy = 'custom') = (custom_tp_price is not null)),
  constraint paper_positions_levels check (custom_tp_price is null or sl_price < custom_tp_price),
  constraint paper_positions_expiry check (expires_at > created_at and expires_at <= created_at + interval '25 hours'),
  -- Execution columns consistent with the status.
  constraint paper_positions_status_columns check (
    case status
      when 'pending' then filled_at is null and fill_price is null and closed_at is null and pnl_sol is null
      when 'open' then filled_at is not null and fill_price is not null and closed_at is null and pnl_sol is null
      when 'closed' then filled_at is not null and fill_price is not null and closed_at is not null
                         and pnl_sol is not null
      when 'expired' then filled_at is null and fill_price is null and closed_at is not null and pnl_sol is null
      -- cancelled: a pending position (no fill) or an open one abandoned by paper_reset_wallet (fill kept).
      else closed_at is not null and pnl_sol is null
    end
  )
);

comment on table public.paper_positions is
  'Paper trading v2 (simulation only): simulated entries with a strategy and legs. Created by RPC, executed by paper-engine.';
comment on column public.paper_positions.book is 'Wallet (book) the position is reserved on / debited from.';
comment on column public.paper_positions.symbol is 'Copied from public.tokens.symbol (client value never used).';
comment on column public.paper_positions.entry_target_price is
  'Fills when an observed price is <= this level (a target at or above the price = market entry).';
comment on column public.paper_positions.sl_price is
  'SL chosen at creation: entry_target x (1 - sl_pct/100) for presets (re-based on the fill price at fill), absolute for custom.';
comment on column public.paper_positions.fill_price is 'Tick price x (1 + Jupiter buy impact, 2 % if unknown).';
comment on column public.paper_positions.fees_sol is 'Network fees charged so far (entry, then + one per leg exit). Rent is not a fee.';
comment on column public.paper_positions.pnl_sol is
  'Closed positions only: sum(stake x size/100 x (exit/fill - 1)) - entry fee - exit fees.';
comment on column public.paper_positions.source is 'manual = user RPC; auto_alert = auto-paper of a delivered alert (alert_id).';

create index paper_positions_user_book_status_idx on public.paper_positions (user_id, book, status);
create index paper_positions_user_created_idx     on public.paper_positions (user_id, created_at desc);
create index paper_positions_active_idx           on public.paper_positions (created_at)
  where status in ('pending', 'open');
create index paper_positions_active_mint_idx      on public.paper_positions (mint) where status in ('pending', 'open');
create index paper_positions_alert_idx            on public.paper_positions (alert_id) where alert_id is not null;

-- ---------------------------------------------------------------------------
-- 3. paper_legs
-- ---------------------------------------------------------------------------
create table public.paper_legs (
  id           uuid primary key default gen_random_uuid(),
  position_id  uuid not null,
  -- Denormalised owner (RLS without a join); the composite FK guarantees it is the position's owner.
  user_id      uuid not null references auth.users (id) on delete cascade,
  size_pct     smallint not null check (size_pct in (50, 100)),
  tp_price     numeric not null check (tp_price > 0 and tp_price < 1e12),
  stop_price   numeric not null check (stop_price > 0 and stop_price < 1e12),
  status       text not null default 'open' check (status in ('open', 'tp_hit', 'sl_hit', 'breakeven_hit')),
  exit_price   numeric check (exit_price is null or (exit_price > 0 and exit_price < 1e12)),
  closed_at    timestamptz,

  constraint paper_legs_position_fkey foreign key (position_id, user_id)
    references public.paper_positions (id, user_id) on delete cascade,
  constraint paper_legs_status_columns check (
    case status
      when 'open' then exit_price is null and closed_at is null
      else exit_price is not null and closed_at is not null
    end
  )
);

comment on table public.paper_legs is
  'Paper trading v2: exits of a position (50 / 100 %), own TP and stop. Status is meaningful while the position is open or closed.';
comment on column public.paper_legs.stop_price is 'Current stop: the SL, or the fill price after the breakeven move (half_x2_rest_x3).';
comment on column public.paper_legs.exit_price is 'Tick price x (1 - Jupiter sell impact, 2 % if unknown).';

create index paper_legs_position_idx on public.paper_legs (position_id);
create index paper_legs_user_idx     on public.paper_legs (user_id);

-- ---------------------------------------------------------------------------
-- 4. alert_settings (owner-editable like the other preferences: table-level grants + owner policies)
-- ---------------------------------------------------------------------------
alter table public.alert_settings
  add column paper_default_strategy text not null default 'half_x2_rest_x3'
    constraint alert_settings_paper_strategy_check check (paper_default_strategy in ('half_x2_rest_x3', 'all_x2')),
  add column paper_sl_pct numeric not null default 30
    constraint alert_settings_paper_sl_pct_check check (paper_sl_pct >= 1 and paper_sl_pct <= 90),
  add column auto_paper_parallel boolean not null default false;

comment on column public.alert_settings.paper_default_strategy is
  'Auto-paper (single mode): strategy of the position opened in book main for each delivered single alert.';
comment on column public.alert_settings.paper_sl_pct is 'Auto-paper: stop-loss distance in percent below the entry (1-90).';
comment on column public.alert_settings.auto_paper_parallel is
  'Auto-paper: open BOTH presets (books half_x2_rest_x3 and all_x2, full stake each) instead of one in book main.';
comment on column public.alert_settings.auto_paper is
  'Paper trading: open a simulated position for each single alert delivered (see auto_paper_parallel).';

-- ---------------------------------------------------------------------------
-- 5. DATA MIGRATION paper_orders (v1) → paper_positions + paper_legs (v2). Every v1 order becomes exactly one leg
--    (leg id = order id); history and the 4 active test trades are preserved.
--    Grouping: orders sharing a group_id are merged into ONE position only when they are the v1 default strategy
--    (exactly 2 orders, same user / mint / stake / type / source / entry / SL / expiry / fill, TP = entry x 2 and x 3,
--    compatible statuses) → strategy 'half_x2_rest_x3', 2 legs of 50 %, position id = group_id.
--    Anything else (single order, odd group) → one 'custom' position per order (1 leg of 100 %, position id = order
--    id, custom TP = the order's TP).
--    Status: pending → pending, open → open, tp_hit / sl_hit → closed, cancelled / expired unchanged; a merged group
--    is 'open' while one half is still open. Legs: tp_hit / sl_hit kept with exit_price / closed_at, others 'open'.
--    Amounts (stake, fees, pnl) summed. source 'auto' → 'auto_alert' (alert_id unknown: null).
--    Missing v1 levels (both optional in v1): TP → 1e11 (never reached), SL → 1e-12 (never reached).
--    Balance: pending positions were never debited (unchanged); open ones were debited at fill (kept as is) EXCEPT
--    the rent: v1 locked one rent per half, v2 returns one rent per position at close, so each merged group whose
--    two halves are still open is credited TOKEN_ACCOUNT_RENT_SOL (0.00204) now. (v1 also charged one entry fee per
--    half: that fee is sunk and stays in fees_sol; the v2 pnl of such a position counts one entry fee.)
-- ---------------------------------------------------------------------------
create temporary table paper_v1_map (
  order_id  uuid primary key,
  pkey      uuid not null,
  merged    boolean not null
);

insert into paper_v1_map (order_id, pkey, merged)
with o as (
  select o.*, coalesce(o.group_id, o.id) as gkey from public.paper_orders o
), g as (
  select gkey,
         count(*) = 2
         and count(distinct user_id) = 1 and count(distinct mint) = 1 and count(distinct stake_sol) = 1
         and count(distinct type) = 1 and count(distinct source) = 1 and count(distinct expires_at) = 1
         and bool_and(entry_price is not null and tp_price is not null and sl_price is not null)
         and count(distinct entry_price) = 1 and count(distinct sl_price) = 1
         and count(distinct coalesce(fill_price, -1)) = 1
         and round(min(tp_price / entry_price), 6) = 2 and round(max(tp_price / entry_price), 6) = 3
         and (bool_and(status = 'pending') or bool_and(status = 'cancelled') or bool_and(status = 'expired')
              or bool_and(status in ('open', 'tp_hit', 'sl_hit'))) as mergeable
    from o
   group by gkey
)
select o.id, case when g.mergeable then o.gkey else o.id end, g.mergeable
  from o join g using (gkey);

-- Every v1 user keeps a 'main' wallet (they all have one: created by the v1 insert trigger).
insert into public.paper_wallets (user_id, book)
select distinct o.user_id, 'main' from public.paper_orders o
on conflict (user_id, book) do nothing;

insert into public.paper_positions (
  id, user_id, book, mint, symbol, strategy, stake_sol, source, alert_id, status, entry_target_price, fill_price,
  sl_price, custom_tp_price, sl_pct, expires_at, created_at, filled_at, closed_at, pnl_sol, fees_sol
)
select
  m.pkey,
  min(o.user_id::text)::uuid,
  'main',
  min(o.mint),
  min(o.symbol),
  case when bool_and(m.merged) then 'half_x2_rest_x3' else 'custom' end,
  sum(o.stake_sol),
  case when min(o.source) = 'auto' then 'auto_alert' else 'manual' end,
  null,
  case
    when bool_and(o.status = 'pending') then 'pending'
    when bool_and(o.status = 'cancelled') then 'cancelled'
    when bool_and(o.status = 'expired') then 'expired'
    when bool_or(o.status = 'open') then 'open'
    else 'closed'
  end,
  -- entry: the v1 limit / market reference; fallbacks only for v1 rows without entry_price.
  coalesce(max(o.entry_price), max(o.fill_price), max(o.sl_price) / 0.7, max(o.tp_price) / 2, max(t.price_usd), 1e-9),
  max(o.fill_price),
  coalesce(max(o.sl_price), 1e-12),
  case when bool_and(m.merged) then null else coalesce(max(o.tp_price), 1e11) end,
  case
    when max(o.sl_price) is not null and max(o.entry_price) is not null and max(o.sl_price) < max(o.entry_price)
      then least(90, greatest(1, round((1 - max(o.sl_price) / max(o.entry_price)) * 100, 6)))
    else 30
  end,
  least(max(o.expires_at), min(o.created_at) + interval '25 hours'),
  min(o.created_at),
  min(o.filled_at),
  case
    when bool_and(o.status = 'pending') or bool_or(o.status = 'open') then null
    else max(o.closed_at)
  end,
  case when bool_and(o.status in ('tp_hit', 'sl_hit')) then sum(o.pnl_sol) else null end,
  sum(o.fees_sol)
from public.paper_orders o
join paper_v1_map m on m.order_id = o.id
left join public.tokens t on t.mint = o.mint
group by m.pkey;

insert into public.paper_legs (id, position_id, user_id, size_pct, tp_price, stop_price, status, exit_price, closed_at)
select
  o.id,
  m.pkey,
  o.user_id,
  case when m.merged then 50 else 100 end,
  coalesce(o.tp_price, 1e11),
  coalesce(o.sl_price, 1e-12),
  case when o.status in ('tp_hit', 'sl_hit') then o.status else 'open' end,
  case when o.status in ('tp_hit', 'sl_hit') then o.exit_price else null end,
  case when o.status in ('tp_hit', 'sl_hit') then o.closed_at else null end
from public.paper_orders o
join paper_v1_map m on m.order_id = o.id;

-- Rent consistency (see above): merged groups whose two halves are still open.
update public.paper_wallets w
   set balance_sol = w.balance_sol + 0.00204 * x.groups
  from (
    select p.user_id, count(*) as groups
      from public.paper_positions p
     where p.strategy = 'half_x2_rest_x3' and p.status = 'open'
       and p.id in (select m.pkey from paper_v1_map m where m.merged)
       and not exists (select 1 from public.paper_legs l where l.position_id = p.id and l.status <> 'open')
     group by p.user_id
  ) x
 where w.user_id = x.user_id and w.book = 'main';

-- Fail the migration (nothing is lost) if the conversion is not complete.
do $$
declare
  v_orders        integer;
  v_legs          integer;
  v_active_groups integer;
  v_active_pos    integer;
  v_stake_v1      numeric;
  v_stake_v2      numeric;
begin
  select count(*), coalesce(sum(stake_sol), 0) into v_orders, v_stake_v1 from public.paper_orders;
  select count(*) into v_legs from public.paper_legs l where l.id in (select order_id from paper_v1_map);
  select coalesce(sum(stake_sol), 0) into v_stake_v2 from public.paper_positions p
   where p.id in (select pkey from paper_v1_map);
  select count(distinct m.pkey) into v_active_groups
    from public.paper_orders o join paper_v1_map m on m.order_id = o.id
   where o.status in ('pending', 'open');
  select count(*) into v_active_pos from public.paper_positions p
   where p.status in ('pending', 'open') and p.id in (select pkey from paper_v1_map);
  if v_orders <> v_legs or v_stake_v1 <> v_stake_v2 or v_active_groups <> v_active_pos then
    raise exception 'paper v2 data migration incomplete: orders %, legs %, stake % vs %, active % vs %',
      v_orders, v_legs, v_stake_v1, v_stake_v2, v_active_groups, v_active_pos;
  end if;
end;
$$;

drop table paper_v1_map;

-- ---------------------------------------------------------------------------
-- 6. Freeze v1: rename, no privilege, no trigger, v1 RPCs dropped.
-- ---------------------------------------------------------------------------
drop trigger paper_orders_before_insert on public.paper_orders;
drop function public.paper_orders_before_insert();
drop function public.paper_apply(uuid, text, jsonb, numeric);
drop function public.paper_cancel_order(uuid);
drop function public.paper_reset_wallet();
drop function public.paper_ensure_wallet();
drop policy "users create their pending paper orders" on public.paper_orders;
drop policy "users read their paper orders" on public.paper_orders;

alter table public.paper_orders rename to paper_orders_v1;
revoke all on public.paper_orders_v1 from anon, authenticated;
comment on table public.paper_orders_v1 is
  'Paper trading v1 orders, FROZEN by 20261118020000 (converted to paper_positions / paper_legs). service_role only.';

-- ---------------------------------------------------------------------------
-- 7. paper_positions BEFORE INSERT trigger (defence in depth: the RPC already checks): known token, server symbol.
--    Created after the data migration (v1 rows keep their v1 symbol).
-- ---------------------------------------------------------------------------
create function public.paper_positions_before_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
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

create trigger paper_positions_before_insert
  before insert on public.paper_positions
  for each row execute function public.paper_positions_before_insert();

-- ---------------------------------------------------------------------------
-- 8. Opening a position (core: service_role only; user wrapper: auth.uid()).
-- Levels (mirror of paper.ts planLegs, re-based on the fill price by paper-engine for the presets):
--   half_x2_rest_x3 → legs {50 %, entry x 2}, {50 %, entry x 3}; SL = entry x (1 - sl_pct/100)
--   all_x2          → leg  {100 %, entry x 2};                   SL = entry x (1 - sl_pct/100)
--   custom          → leg  {100 %, p_custom_tp}; SL = p_custom_sl; requires 0 < SL < entry < TP
-- Expiry: created_at + 24 h (paper.ts ENTRY_EXPIRY_MS).
-- ---------------------------------------------------------------------------
create function public.paper_open_position_as(
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
  'service_role (auto-paper): opens a pending paper position + legs for p_user with every balance / cap / token check.';

-- User entry point: identity from auth.uid(), source 'manual', no alert link.
create function public.paper_open_position(
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
  'Opens a pending paper position (simulation) for the caller. Errors: paper position: insufficient paper balance / too many … / unknown token / invalid ….';

-- ---------------------------------------------------------------------------
-- 9. Other user RPCs (security definer, minimal, auth.uid() only)
-- ---------------------------------------------------------------------------

-- Creates the caller's wallet of that book (1.0 SOL) if missing and returns it.
create function public.paper_ensure_wallet(p_book text default 'main')
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
  if p_book is null or p_book not in ('main', 'half_x2_rest_x3', 'all_x2') then
    raise exception 'paper wallet: invalid book' using errcode = '22023';
  end if;
  insert into public.paper_wallets (user_id, book) values (v_uid, p_book) on conflict (user_id, book) do nothing;
  select * into v_row from public.paper_wallets where user_id = v_uid and book = p_book;
  return v_row;
end;
$$;

-- Cancels one of the caller's PENDING positions. true = cancelled, false = not found / not yours / not pending.
-- No balance change: a pending position is only reserved, never debited.
create function public.paper_cancel_position(p_id uuid)
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
   where id = p_id and user_id = v_uid and status = 'pending';
  return found;
end;
$$;

-- Resets the caller's wallet of one book to initial_sol. Pending AND open positions of that book are cancelled: open
-- positions are abandoned without P&L (fill kept for history), the stats start at reset_at. Lock order: wallet, then
-- positions.
create function public.paper_reset_wallet(p_book text default 'main')
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
  if p_book is null or p_book not in ('main', 'half_x2_rest_x3', 'all_x2') then
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

-- ---------------------------------------------------------------------------
-- 10. Engine RPC (service_role only): one step of one position + its wallet delta, atomically.
-- p_step (built by _shared/paper-engine.ts applyArgsV2 from paper.ts step()):
--   { kind: 'fill',   fill_price, fees_sol, legs: [{ id, tp_price, stop_price }] }             pending → open
--   { kind: 'expire' }                                                                         pending → expired
--   { kind: 'legs',   closes: [{ id, status, exit_price }], moves: [{ id, stop_price }],
--                     fees_sol, position_closed, pnl_sol }                                     open → open | closed
-- fees_sol = fee of THIS step (added to the position total). filled_at / closed_at = now() (server clock).
-- Optimistic: applied only if the position still has status p_expected and (legs) every closing leg is still open;
-- otherwise null and nothing is written (replays are no-ops). Inconsistent input raises (whole step rolled back).
-- Returns the new balance of the position's wallet, or null when not applied.
-- ---------------------------------------------------------------------------
create function public.paper_apply_v2(p_position uuid, p_expected text, p_step jsonb, p_delta numeric)
returns numeric
language plpgsql
volatile
security invoker
set search_path = ''
as $$
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

comment on function public.paper_apply_v2(uuid, text, jsonb, numeric) is
  'paper-engine (service_role): applies one position step (fill / expire / legs) and its wallet delta atomically; null = not applied.';

-- ---------------------------------------------------------------------------
-- 11. Privileges
-- ---------------------------------------------------------------------------
revoke all on public.paper_wallets, public.paper_positions, public.paper_legs from anon;
revoke all on public.paper_wallets, public.paper_positions, public.paper_legs from authenticated;
grant select on public.paper_wallets, public.paper_positions, public.paper_legs to authenticated;

-- Supabase's default privileges grant EXECUTE to anon/authenticated directly (not only via PUBLIC).
revoke execute on function public.paper_positions_before_insert() from public, anon, authenticated;
revoke execute on function public.paper_open_position_as(uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, text, bigint)
  from public, anon, authenticated;
revoke execute on function public.paper_open_position(text, text, numeric, numeric, numeric, numeric, numeric, text)
  from public, anon;
revoke execute on function public.paper_ensure_wallet(text)        from public, anon;
revoke execute on function public.paper_cancel_position(uuid)      from public, anon;
revoke execute on function public.paper_reset_wallet(text)         from public, anon;
revoke execute on function public.paper_apply_v2(uuid, text, jsonb, numeric) from public, anon, authenticated;

grant execute on function public.paper_open_position_as(uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, text, bigint)
  to service_role;
grant execute on function public.paper_open_position(text, text, numeric, numeric, numeric, numeric, numeric, text)
  to authenticated;
grant execute on function public.paper_ensure_wallet(text)         to authenticated;
grant execute on function public.paper_cancel_position(uuid)       to authenticated;
grant execute on function public.paper_reset_wallet(text)          to authenticated;
grant execute on function public.paper_apply_v2(uuid, text, jsonb, numeric) to service_role;

-- ---------------------------------------------------------------------------
-- 12. Row Level Security (paper_wallets: RLS + owner SELECT policy unchanged since v1)
-- ---------------------------------------------------------------------------
alter table public.paper_positions enable row level security;
alter table public.paper_legs      enable row level security;

create policy "users read their paper positions"
  on public.paper_positions for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "users read their paper legs"
  on public.paper_legs for select to authenticated
  using ((select auth.uid()) = user_id);

-- No insert / update / delete policy for authenticated on any paper table; none at all for anon.

-- Realtime (postgres_changes) for the portfolio screen: delivery is filtered by the SELECT policies (own rows).
-- paper_wallets deliberately NOT published: Realtime does not RLS-filter DELETE events, whose old key (user_id, book)
-- would reach every subscriber. The front reloads the wallets on position/leg events.
alter publication supabase_realtime add table public.paper_positions, public.paper_legs;
