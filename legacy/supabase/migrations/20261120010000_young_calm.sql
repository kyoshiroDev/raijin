-- feat/young-calm (docs/contracts/young-calm.md) — preset « Jeune calme » (new default), witness « Jeune frénésie »,
-- auto-paper books Calme / Frénésie, point-in-time buy / sell / liquidity / LP columns, 4 backtest presets.
-- SIMULATION ONLY for the paper part: no wallet, no key, no signature, no transaction.
--
-- What changes
--   alert_settings.alert_preset : + 'young_calm' (« Jeune calme »), the new column DEFAULT; rows on 'momentum' (the old
--                                 default) move to 'young_calm'; 'strict' rows untouched. Momentum stays selectable.
--   alert_log.preset            : + 'young_calm' (main-stream alerts of that preset). 'young_frenzy' never alerts.
--   preset_signals.preset       : + 'young_calm', 'young_frenzy' (first match per mint, scan-tokens).
--   paper books                 : + 'calm_all_x2' (« Calme ») and 'frenzy_all_x2' (« Frénésie »), separate 1.0 SOL
--                                 wallets, on paper_wallets, paper_positions, paper_open_position_as and the wallet RPCs.
--   paper_open_position_as      : same 12-argument signature, attributes and grants; every existing check kept (advisory
--                                 lock, all wallets locked, 12 h cooldown after a stop on the mint, caps 50 active /
--                                 200 per 24 h, balance, alert link, token check). For the two new books only:
--                                 strategy all_x2, source auto_alert, entry_mode next_tick, and ONE position per
--                                 (user, book, mint) FOREVER (any status, cancelled / reset ones included → no reopening),
--                                 backed by a partial unique index.
--   token_snapshots             : point-in-time buys_1h, sells_1h (DexScreener 1 h transactions), liquidity_effective_usd
--                                 (score liquidity) and lp_locked_pct (RugCheck, fresh only) known AT SCAN TIME. Nullable,
--                                 bounded, never backfilled (older snapshots stay null = unknown).
--   backtest                    : presets young_calm / young_frenzy (detection mode, bits 1024 / 2048 on detection rows)
--                                 and young_calm_ev / young_frenzy_ev (event mode, bits 4096 / 8192 on event rows, events
--                                 stored in backtest_events with those preset names), in backtest_events / backtest_trades
--                                 / backtest_results checks and backtest_trades_slice() (backtest.ts PRESET_BIT).
--   performance_by_preset()     : + presets young_calm (paper: book calm_all_x2) and young_frenzy (paper: book
--                                 frenzy_all_x2), segments all / gta / other, appended after the existing ones.
--
-- Security
--   No new table, no new policy. alert_settings keeps RLS (owner-only policies); token_snapshots / preset_signals /
--   backtest_* keep RLS with SELECT-only policies for authenticated (writes service_role only); the new columns inherit
--   the table grants (SELECT for authenticated). paper_open_position_as: security definer, search_path = '', EXECUTE for
--   service_role only (re-stated). Wallet RPCs: security definer, auth.uid() only, EXECUTE for authenticated (re-stated).
--   backtest_trades_slice: security invoker, EXECUTE for service_role only (re-stated). performance_by_preset: security
--   invoker (paper rows filtered by RLS to the caller), search_path = '', EXECUTE for authenticated only (re-stated).
-- Units: *_pct are PERCENT; money in USD unless *_sol. Upper bounds also reject 'Infinity' / 'NaN'.

-- ---------------------------------------------------------------------------
-- 1. alert_settings / alert_log
-- ---------------------------------------------------------------------------
alter table public.alert_settings drop constraint alert_settings_alert_preset_check;
alter table public.alert_settings
  add constraint alert_settings_alert_preset_check check (alert_preset in ('young_calm', 'momentum', 'strict')),
  alter column alert_preset set default 'young_calm';

comment on column public.alert_settings.alert_preset is
  'Alert rules of the main stream: young_calm (default, « Jeune calme », presets.ts), momentum (experimental) or strict (min_score / only_in_zone / R/R / model gate).';

-- Users on the previous default move to the new one; strict users keep their choice.
update public.alert_settings set alert_preset = 'young_calm' where alert_preset = 'momentum';

alter table public.alert_log drop constraint alert_log_preset_check;
alter table public.alert_log
  add constraint alert_log_preset_check
    check (preset is null or preset in ('young_calm', 'momentum', 'strict', 'young_strong'));

comment on column public.alert_log.preset is
  'Preset that produced the alert (young_calm / momentum / strict / young_strong); null for rows before 20261119070000.';

-- ---------------------------------------------------------------------------
-- 2. preset_signals
-- ---------------------------------------------------------------------------
alter table public.preset_signals drop constraint preset_signals_preset_check;
alter table public.preset_signals
  add constraint preset_signals_preset_check
    check (preset in ('momentum', 'strict', 'young_strong', 'young_calm', 'young_frenzy'));

-- ---------------------------------------------------------------------------
-- 3. token_snapshots: values known at scan time
-- ---------------------------------------------------------------------------
alter table public.token_snapshots
  add column buys_1h                 integer
    constraint token_snapshots_buys_1h_check check (buys_1h is null or (buys_1h >= 0 and buys_1h <= 100000000)),
  add column sells_1h                integer
    constraint token_snapshots_sells_1h_check check (sells_1h is null or (sells_1h >= 0 and sells_1h <= 100000000)),
  add column liquidity_effective_usd numeric
    constraint token_snapshots_liq_eff_check
      check (liquidity_effective_usd is null or (liquidity_effective_usd >= 0 and liquidity_effective_usd < 1e13)),
  add column lp_locked_pct           numeric
    constraint token_snapshots_lp_locked_check check (lp_locked_pct is null or (lp_locked_pct >= 0 and lp_locked_pct <= 100));

comment on column public.token_snapshots.buys_1h is 'DexScreener buys over 1 h at scan time (null = unknown / snapshot older than young-calm).';
comment on column public.token_snapshots.sells_1h is 'DexScreener sells over 1 h at scan time (null = unknown).';
comment on column public.token_snapshots.liquidity_effective_usd is 'Effective liquidity of the score at scan time, USD (null = unknown).';
comment on column public.token_snapshots.lp_locked_pct is 'RugCheck LP locked at scan time (fresh enrichment only), PERCENT (null = unknown).';

-- ---------------------------------------------------------------------------
-- 4. Paper books Calme / Frénésie
-- ---------------------------------------------------------------------------
alter table public.paper_wallets drop constraint paper_wallets_book_check;
alter table public.paper_wallets
  add constraint paper_wallets_book_check
    check (book in ('main', 'half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3', 'young_thirds_x2_x3_x4',
                    'calm_all_x2', 'frenzy_all_x2'));

alter table public.paper_positions drop constraint paper_positions_book_check;
alter table public.paper_positions
  add constraint paper_positions_book_check
    check (book in ('main', 'half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3', 'young_thirds_x2_x3_x4',
                    'calm_all_x2', 'frenzy_all_x2'));

comment on column public.paper_wallets.book is
  'main = manual + single auto-paper; half_x2_rest_x3 / all_x2 = parallel auto-paper comparison books (Momentum / Strict); young_all_x2 / young_half_x2_rest_x3 / young_thirds_x2_x3_x4 = auto-paper of the « Jeune & fort » alerts; calm_all_x2 / frenzy_all_x2 = auto-paper « Calme » / « Frénésie » (every scan, independent of alerts, one position per mint forever).';

-- One position per (user, book, mint) forever in the Calme / Frénésie books (enforced by paper_open_position_as under
-- the per-user lock; this index is the backstop and serves the existence check).
create unique index paper_positions_calm_frenzy_once_idx on public.paper_positions (user_id, book, mint)
  where book in ('calm_all_x2', 'frenzy_all_x2');

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
  if p_book is null or p_book not in ('main', 'half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3',
                                      'young_thirds_x2_x3_x4', 'calm_all_x2', 'frenzy_all_x2') then
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
  -- Calme / Frénésie: one fixed recipe (all_x2, auto-paper, next scan price), so both books stay comparable.
  if p_book in ('calm_all_x2', 'frenzy_all_x2')
     and (p_strategy <> 'all_x2' or p_source <> 'auto_alert' or v_mode <> 'next_tick') then
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

  -- Calme / Frénésie: one position per (user, book, mint) forever, whatever its status (cancelled / reset included).
  if p_book in ('calm_all_x2', 'frenzy_all_x2') and exists (
    select 1 from public.paper_positions p where p.user_id = p_user and p.book = p_book and p.mint = p_mint
  ) then
    raise exception 'paper position: already traded in this book' using errcode = '23505';
  end if;

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
  'service_role (auto-paper): opens a pending paper position + legs for p_user with every balance / cap / token check and the 12 h cooldown after a stop on the same mint. Strategies: half_x2_rest_x3 | all_x2 | thirds_x2_x3_x4 | custom. p_entry_mode: target (default) | next_tick (presets, auto_alert only). Books calm_all_x2 / frenzy_all_x2: all_x2 + auto_alert + next_tick only, one position per (user, book, mint) forever.';

revoke execute on function public.paper_open_position_as(uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.paper_open_position_as(uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, text, bigint, text)
  to service_role;

-- Wallet RPCs (caller's own wallet): same bodies as 20261119080000, the two new books added to the allowed list so the
-- Paper screen can show and reset them (a reset cancels open positions; it never allows reopening a mint in these books).
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
  if p_book is null or p_book not in ('main', 'half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3',
                                      'young_thirds_x2_x3_x4', 'calm_all_x2', 'frenzy_all_x2') then
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
  if p_book is null or p_book not in ('main', 'half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3',
                                      'young_thirds_x2_x3_x4', 'calm_all_x2', 'frenzy_all_x2') then
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
-- 5. Backtest presets (backtest.ts PRESET_BIT): detection young_calm 1024 / young_frenzy 2048 (on top of all 1 and
--    mc_300k_1m 16; v1 rows of kept runs may still carry 2 / 4 / 8), event young_calm_ev 4096 / young_frenzy_ev 8192
--    (exactly one bit per event row). preset_flags stays a smallint (max 32767).
-- ---------------------------------------------------------------------------
alter table public.backtest_events drop constraint backtest_events_preset_check;
alter table public.backtest_events add constraint backtest_events_preset_check check (
  preset in ('momentum', 'young_24h', 'young_3h', 'post_migration', 'narrative_leader',
             'momentum_explo', 'young_24h_explo', 'young_3h_explo', 'young_calm_ev', 'young_frenzy_ev')
);

alter table public.backtest_trades drop constraint backtest_trades_preset_flags_check;
alter table public.backtest_trades add constraint backtest_trades_preset_flags_check check (
  (source <> 'backtest_events' and preset_flags % 2 = 1 and (preset_flags::integer & ~(1 | 2 | 4 | 8 | 16 | 1024 | 2048)) = 0)
  or (source = 'backtest_events' and preset_flags in (2, 4, 8, 32, 64, 128, 256, 512, 4096, 8192))
);

alter table public.backtest_results drop constraint backtest_results_preset_check;
alter table public.backtest_results add constraint backtest_results_preset_check check (
  preset in ('all', 'mc_300k_1m', 'momentum', 'young_24h', 'young_3h', 'post_migration', 'narrative_leader',
             'momentum_explo', 'young_24h_explo', 'young_3h_explo',
             'young_calm', 'young_frenzy', 'young_calm_ev', 'young_frenzy_ev')
);

-- Same signature, attributes and grants; the four new bits accepted.
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

revoke execute on function public.backtest_trades_slice(bigint, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.backtest_trades_slice(bigint, integer, integer, integer, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 6. performance_by_preset(): same as 20261119080000 plus young_calm (book calm_all_x2) and young_frenzy (book
--    frenzy_all_x2), segments all / gta / other, appended after strict (p_ord 4 / 5). Signature, security invoker,
--    search_path and grants unchanged (re-stated below).
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
        ('strict', 'all', 3, 1), ('strict', 'gta', 3, 2), ('strict', 'other', 3, 3),
        ('young_calm', 'all', 4, 1), ('young_calm', 'gta', 4, 2), ('young_calm', 'other', 4, 3),
        ('young_frenzy', 'all', 5, 1), ('young_frenzy', 'gta', 5, 2), ('young_frenzy', 'other', 5, 3)
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
             when p.book = 'calm_all_x2' then 'young_calm'
             when p.book = 'frenzy_all_x2' then 'young_frenzy'
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
     where p.book in ('half_x2_rest_x3', 'all_x2', 'young_all_x2', 'young_half_x2_rest_x3', 'young_thirds_x2_x3_x4',
                      'calm_all_x2', 'frenzy_all_x2')
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
  'Per preset (momentum / young_strong / strict / young_calm / young_frenzy) and segment (all / gta / other / age_lt_3h / age_3_24h): preset_signals label counts, simulated all_x2 P&L from the labels, and the caller''s paper P&L of the preset books (young_calm: calm_all_x2, young_frenzy: frenzy_all_x2).';

revoke execute on function public.performance_by_preset() from public, anon;
grant execute on function public.performance_by_preset() to authenticated;
