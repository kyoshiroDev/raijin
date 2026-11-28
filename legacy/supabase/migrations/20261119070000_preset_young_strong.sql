-- feat/preset-young-strong — preset « Jeune & fort » (docs/contracts/preset-young-strong.md).
-- SIMULATION ONLY for the paper part: no wallet, no key, no signature, no transaction.
--
-- What changes
--   alert_settings.young_strong_enabled : extra alert stream « Jeune & fort », independent of alert_preset
--                                         (momentum | strict). Default true (existing rows included).
--   alert_log.preset                    : preset of the alert ('momentum' | 'strict' | 'young_strong'), nullable
--                                         (older rows). The young_strong stream has its own caps (4 / h, 30 / 24 h)
--                                         counted on preset = 'young_strong'.
--   preset_signals                      : preset 'young_strong' allowed; narrative (at detection, backfilled from
--                                         tokens.narrative) and pair_age_h (pair age in hours at detection).
--   paper books                         : 'young_all_x2' and 'young_half_x2_rest_x3' (separate 1.0 SOL wallets),
--                                         allowed on paper_wallets, paper_positions and in the wallet RPCs.
--   paper_positions.entry_mode          : 'target' (default, historical behaviour) or 'next_tick' (filled at the
--                                         first scan snapshot captured strictly after created_at, whatever the price;
--                                         fast ticks never fill a pending position — enforced by the engines).
--   paper_open_position_as              : new trailing parameter p_entry_mode text default 'target'. The 11-argument
--                                         version is DROPPED and replaced by the 12-argument one (a second overload
--                                         with a default would make every 11-argument call ambiguous); 11-argument
--                                         calls (paper_open_position, older scan-tokens builds, named PostgREST
--                                         calls) resolve to it through the default. Body otherwise identical to
--                                         20261119040000 (advisory lock, wallet locks, 12 h cooldown after a stop,
--                                         caps 50 active / 200 per 24 h, balance, alert link, token check).
--   fast_watch / fast_ticks             : fast tracking (track-fast, every minute, 2 passes) of the young_strong
--                                         matches for 2 h; outcome of the window stored in fast_watch.
--   performance_by_preset()             : per preset and segment, label counts, simulated P&L from the labels and
--                                         the caller's paper P&L of the preset books.
--
-- Security
--   fast_watch / fast_ticks: RLS enabled, SELECT policy for authenticated only, no insert / update / delete policy
--   (writes are service_role only, which bypasses RLS). Supabase default privileges grant ALL on new tables, so
--   everything is revoked from anon and authenticated first, then SELECT is granted back to authenticated.
--   paper_open_position_as: security definer, search_path = '', EXECUTE for service_role only (revoked from public,
--   anon, authenticated). Wallet RPCs keep their grants (authenticated). performance_by_preset: security invoker
--   (paper rows filtered by RLS to the caller's own positions; preset_signals / tokens readable by authenticated),
--   search_path = '', EXECUTE for authenticated only.
-- Units: *_pct are PERCENT; multiples are ratios (2 = x2); money in USD unless *_sol.

-- ---------------------------------------------------------------------------
-- 1. alert_settings / alert_log
-- ---------------------------------------------------------------------------
alter table public.alert_settings
  add column young_strong_enabled boolean not null default true;

comment on column public.alert_settings.young_strong_enabled is
  'Extra alert stream « Jeune & fort » (preset young_strong), independent of alert_preset. Own caps 4/h, 30/24 h.';

alter table public.alert_log
  add column preset text
    constraint alert_log_preset_check check (preset is null or preset in ('momentum', 'strict', 'young_strong'));

comment on column public.alert_log.preset is
  'Preset that produced the alert (momentum / strict / young_strong); null for rows before 20261119070000.';

-- young_strong caps and dedup (scan-tokens notify.ts): rows of one user in the last 24 h.
create index alert_log_young_user_sent_idx on public.alert_log (user_id, sent_at desc)
  where preset = 'young_strong';

-- ---------------------------------------------------------------------------
-- 2. preset_signals
-- ---------------------------------------------------------------------------
-- The inline check of 20261119020000 is named preset_signals_preset_check by Postgres.
alter table public.preset_signals drop constraint preset_signals_preset_check;
alter table public.preset_signals
  add constraint preset_signals_preset_check check (preset in ('momentum', 'strict', 'young_strong')),
  add column narrative  text check (narrative is null or char_length(narrative) between 1 and 24),
  add column pair_age_h numeric check (pair_age_h is null or (pair_age_h >= 0 and pair_age_h <= 100000));

comment on column public.preset_signals.narrative is 'Narrative group of the token at detection (tokens.narrative, e.g. GTA).';
comment on column public.preset_signals.pair_age_h is 'Pair age in hours at detection (detected_at - tokens.pair_created_at).';

-- Backfill: the current narrative is the best available approximation for the rows recorded before this migration.
-- pair_age_h is backfilled too when the pair creation time is known and not after the detection.
update public.preset_signals p
   set narrative = t.narrative
  from public.tokens t
 where t.mint = p.mint and p.narrative is null and t.narrative is not null;

update public.preset_signals p
   set pair_age_h = round((extract(epoch from (p.detected_at - t.pair_created_at)) / 3600)::numeric, 3)
  from public.tokens t
 where t.mint = p.mint and p.pair_age_h is null and t.pair_created_at is not null
   and t.pair_created_at <= p.detected_at
   and p.detected_at - t.pair_created_at < interval '10 years';

create index preset_signals_preset_detected_idx on public.preset_signals (preset, detected_at desc);

-- ---------------------------------------------------------------------------
-- 3. Paper books + entry mode
-- ---------------------------------------------------------------------------
alter table public.paper_wallets drop constraint paper_wallets_book_check;
alter table public.paper_wallets
  add constraint paper_wallets_book_check
    check (book in ('main', 'half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3'));

-- The inline check of 20261118020000 is named paper_positions_book_check by Postgres.
alter table public.paper_positions drop constraint paper_positions_book_check;
alter table public.paper_positions
  add constraint paper_positions_book_check
    check (book in ('main', 'half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3')),
  add column entry_mode text not null default 'target'
    constraint paper_positions_entry_mode_check check (entry_mode in ('target', 'next_tick'));

comment on column public.paper_wallets.book is
  'main = manual + single auto-paper; half_x2_rest_x3 / all_x2 = parallel auto-paper comparison books (Momentum / Strict); young_all_x2 / young_half_x2_rest_x3 = auto-paper of the « Jeune & fort » alerts.';
comment on column public.paper_positions.entry_mode is
  'target = filled when a tick reaches entry_target_price; next_tick = filled at the first SCAN snapshot captured after created_at, whatever the price (legs re-based on the fill). Fast ticks never fill.';

-- paper-engine / track-fast: open positions of the young books.
create index paper_positions_book_status_idx on public.paper_positions (book, status)
  where status in ('pending', 'open');

-- ---------------------------------------------------------------------------
-- 4. paper_open_position_as with p_entry_mode
-- ---------------------------------------------------------------------------
drop function public.paper_open_position_as(uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, text, bigint);

create function public.paper_open_position_as(
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
  if p_book is null or p_book not in ('main', 'half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3') then
    raise exception 'paper position: invalid book' using errcode = '22023';
  end if;
  if p_strategy is null or p_strategy not in ('half_x2_rest_x3', 'all_x2', 'custom') then
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
  'service_role (auto-paper): opens a pending paper position + legs for p_user with every balance / cap / token check and the 12 h cooldown after a stop on the same mint. p_entry_mode: target (default) | next_tick (presets, auto_alert only).';

revoke execute on function public.paper_open_position_as(uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.paper_open_position_as(uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, text, bigint, text)
  to service_role;

-- Wallet RPCs (caller's own wallet): same bodies as 20261118020000, the young books added to the allowed list so
-- the Paper screen can show and reset them. create or replace keeps the grants (authenticated, re-stated below).
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
  if p_book is null or p_book not in ('main', 'half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3') then
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
  if p_book is null or p_book not in ('main', 'half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3') then
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
-- 5. Fast tracking: fast_watch (one row per mint, the current or last 2 h window) and fast_ticks (one price per
--    mint per pass of track-fast). No foreign key to tokens on purpose (a token purge must not erase measurements).
-- ---------------------------------------------------------------------------
create table public.fast_watch (
  mint            text primary key check (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  pair_address    text not null check (pair_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  preset          text not null default 'young_strong' check (preset in ('young_strong')),
  started_at      timestamptz not null default now(),
  until           timestamptz not null,
  entry_price     numeric check (entry_price is null or (entry_price > 0 and entry_price < 1e12)),
  max_multiple    numeric check (max_multiple is null or (max_multiple >= 0 and max_multiple < 1e12)),
  min_multiple    numeric check (min_multiple is null or (min_multiple >= 0 and min_multiple < 1e12)),
  first_x2_at     timestamptz,
  first_sl30_at   timestamptz,
  x2_before_sl30  boolean,
  sl30_before_x2  boolean,
  ticks           integer not null default 0 check (ticks between 0 and 100000),
  last_tick_at    timestamptz,
  constraint fast_watch_window check (until > started_at and until <= started_at + interval '1 day'),
  constraint fast_watch_x2_sl30_exclusive check (not (coalesce(x2_before_sl30, false) and coalesce(sl30_before_x2, false))),
  constraint fast_watch_entry_with_ticks check ((ticks = 0) = (entry_price is null)),
  constraint fast_watch_multiples_with_entry check (
    entry_price is not null or (max_multiple is null and min_multiple is null and last_tick_at is null
                                and first_x2_at is null and first_sl30_at is null)
  )
);

comment on table public.fast_watch is
  'Fast tracking (track-fast, 2 ticks per minute) of the tokens matching the young_strong preset, for 2 h from started_at; outcome of the window (x2 vs stop -30 %, same tick = stop first).';
comment on column public.fast_watch.entry_price is 'Price of the first fast tick of the window (USD).';
comment on column public.fast_watch.max_multiple is 'Highest tick price / entry_price over the window.';
comment on column public.fast_watch.min_multiple is 'Lowest tick price / entry_price over the window.';

create index fast_watch_until_idx on public.fast_watch (until desc);

create table public.fast_ticks (
  id             bigint generated always as identity primary key,
  mint           text not null check (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  pair_address   text not null check (pair_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  at             timestamptz not null,
  price_usd      numeric not null check (price_usd > 0 and price_usd < 1e12),
  liquidity_usd  numeric check (liquidity_usd is null or (liquidity_usd >= 0 and liquidity_usd < 1e13)),
  constraint fast_ticks_mint_at_key unique (mint, at)
);

comment on table public.fast_ticks is 'Fast price ticks of the watched pairs (DexScreener pairs endpoint), purged after 7 days.';

-- Purge (supabase/sql/schedule_fast.sql) and time-range reads.
create index fast_ticks_at_idx on public.fast_ticks (at);

-- Privileges (defense in depth, on top of RLS). service_role is left untouched.
revoke all on public.fast_watch, public.fast_ticks from anon, authenticated;
grant select on public.fast_watch, public.fast_ticks to authenticated;

alter table public.fast_watch enable row level security;
alter table public.fast_ticks enable row level security;

create policy "fast watch is readable by signed-in users"
  on public.fast_watch for select to authenticated using (true);
create policy "fast ticks are readable by signed-in users"
  on public.fast_ticks for select to authenticated using (true);

-- No insert / update / delete policy: writes are service_role only (scan-tokens, track-fast, purge cron).

-- ---------------------------------------------------------------------------
-- 6. performance_by_preset()
--   preset        : 'momentum' | 'young_strong' | 'strict' (every row always present, zeros when empty)
--   segment       : 'all' | 'gta' | 'other' for every preset; 'age_lt_3h' | 'age_3_24h' for young_strong only.
--                   gta = narrative 'GTA' (preset_signals.narrative; paper positions: tokens.narrative); other = the
--                   rest (unknown narrative included). Age: preset_signals.pair_age_h; paper positions: age of the pair
--                   (tokens.pair_created_at) at the position's creation; unknown age → in no age segment.
--   signals       : preset_signals rows; labelled: x2_before_sl30 not null.
--   sim_pnl_sol   : per labelled row, all_x2 with 0.1 SOL: +0.1 if x2_before_sl30, -0.03 if sl30_before_x2, else 0,
--                   minus 0.1 x entry_roundtrip_pct / 100 (unknown round trip → 0).
--   trades / paper_pnl_sol / paper_open : the CALLER's paper positions (RLS) of the preset books (momentum:
--                   half_x2_rest_x3 + all_x2; young_strong: young_all_x2 + young_half_x2_rest_x3; strict: none →
--                   0 / null / 0). trades = closed positions, paper_pnl_sol = sum of their pnl_sol, paper_open =
--                   pending + open positions.
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
             when p.book in ('young_all_x2', 'young_half_x2_rest_x3') then 'young_strong'
           end as preset,
           seg.segment, p.status, p.pnl_sol
      from public.paper_positions p
      left join public.tokens t on t.mint = p.mint
     cross join lateral (values
       ('all'),
       (case when t.narrative = 'GTA' then 'gta' else 'other' end),
       (case
          when p.book not in ('young_all_x2', 'young_half_x2_rest_x3') or t.pair_created_at is null
               or t.pair_created_at > p.created_at then null
          when p.created_at - t.pair_created_at < interval '3 hours' then 'age_lt_3h'
          when p.created_at - t.pair_created_at < interval '24 hours' then 'age_3_24h'
        end)
     ) as seg(segment)
     where p.book in ('half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3')
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
