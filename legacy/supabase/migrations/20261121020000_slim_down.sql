-- chore/slim-down (docs/contracts/slim-down.md) — phase 1 « Ménage ». SIMULATION ONLY for the paper part.
-- Principle: data is ARCHIVED (no table / column dropped, nothing written any more, listed in docs/ARCHIVE.md with the
-- reason, 2026-11-21), the code, crons and screens are removed. No applied migration is modified.
--
-- What changes
--   tokens                : NOT NULL lifted on score (no score any more); + volume_1h (DexScreener 1 h volume, the new
--                           ranking key of the scan / young watch / enrich-tokens); tokens_sources_check + 'gecko_new_pools',
--                           'jup_recent' (removed source names stay allowed for the stored history); index on
--                           pair_created_at (the Opportunités list is ordered by age).
--   token_snapshots       : NOT NULL lifted on score and zone_status (archived, no longer written).
--   alert_log             : alert_log_single_has_plan no longer requires entry_score / entry_zone (archived); every other
--                           plan column is still required for a single alert (NOT VALID as before).
--   alert_settings        : alert_preset rows → 'young_calm' (the only alert preset; default unchanged);
--                           paper_default_strategy DEFAULT 'all_x2' (archived column, kept insertable). Every archived
--                           setting keeps a default, so an insert of a new row with the live columns only works.
--   paper_positions       : + cancel_reason ('slim_down' only, cancelled rows only). The pending / open positions of the
--                           archived books (half_x2_rest_x3, all_x2, young_*) or with an archived strategy
--                           (half_x2_rest_x3, thirds_x2_x3_x4, custom) are CANCELLED (closed_at = now(), fill kept, no P&L),
--                           balance unchanged (contract: « solde inchangé »): a pending position was only reserved
--                           (cancelling releases it, exactly like paper_cancel_position); an open one is abandoned like a
--                           paper_reset_wallet abandon, in an archived book that is no longer shown nor funded.
--   paper_open_position_as: same 12-argument signature, attributes and grants; books main / calm_all_x2 / frenzy_all_x2
--                           and strategy all_x2 only; every other check kept (advisory lock, all wallets locked, one
--                           position per (user, book, mint) forever in calm / frenzy, 12 h stop cooldown, caps 50 active /
--                           200 per 24 h, balance, alert link, token check, next_tick rules).
--   paper_open_position   : same signature (p_book kept for compatibility, 'main' only), strategy all_x2 only.
--   paper_ensure_wallet / paper_reset_wallet: books main / calm_all_x2 / frenzy_all_x2 only.
--   performance_by_preset(): presets young_calm (paper book calm_all_x2) and young_frenzy (frenzy_all_x2), segments
--                           all / gta / other. Same return columns.
--   performance_breakdown(): sources scan (signal_outcomes), preset:young_calm, preset:young_frenzy; dimensions all / dex /
--                           mc / liq (zone removed, radar removed). Same return columns.
--   backfill_progress()   : categories 1 candles_1m, 2 event_candles (young_calm_ev / young_frenzy_ev), 3 preset_labels
--                           (young_calm / young_frenzy), 4 scan_labels, 5 candles_5m — radar and archived presets removed
--                           (same order and filters as label-outcomes).
--   comments              : archived tables / columns are marked « ARCHIVED 2026-11-21 ».
-- Not here: the pg_cron jobs (supabase/sql/unschedule_slim_down.sql, run by hand in the SQL editor).
--
-- Security
--   No new table, no new policy, no grant change. RLS stays enabled everywhere (tokens / token_snapshots / alert_log /
--   paper_* / preset_signals / signal_outcomes unchanged). The new columns inherit the table grants (tokens.volume_1h:
--   SELECT for authenticated; paper_positions.cancel_reason: owner SELECT through RLS, writes RPC / service_role only).
--   paper_open_position_as: security definer, search_path = '', EXECUTE service_role only (re-stated). paper_open_position
--   and the wallet RPCs: security definer, auth.uid() only, EXECUTE authenticated only (re-stated). performance_*,
--   backfill_progress: security invoker, search_path = '', EXECUTE authenticated only (re-stated).
-- Every CHECK stays valid for the existing rows (only relaxed or extended).

-- ---------------------------------------------------------------------------
-- 1. tokens
-- ---------------------------------------------------------------------------
alter table public.tokens alter column score drop not null;

alter table public.tokens
  add column volume_1h numeric
    constraint tokens_volume_1h_check check (volume_1h is null or (volume_1h >= 0 and volume_1h < 1e15));

comment on column public.tokens.volume_1h is
  'DexScreener 1 h volume (USD) of the best pair at the last scan; ranking key of the scan (chore/slim-down). null = unknown / older row.';

alter table public.tokens drop constraint if exists tokens_sources_check;
alter table public.tokens
  add constraint tokens_sources_check check (
    cardinality(sources) <= 10
    and array_position(sources, null) is null
    and sources <@ array[
      'dex_profiles', 'dex_boosts_latest', 'dex_boosts_top', 'dex_cto', 'dex_search',
      'gecko_trending', 'gecko_volume', 'gecko_trending_1h', 'gecko_pumpswap', 'gecko_new_pools',
      'jup_trending_1h', 'jup_trending_6h', 'jup_organic_1h', 'jup_organic_6h', 'jup_traded_1h', 'jup_traded_6h',
      'jup_recent', 'migration', 'young_watch'
    ]::text[]
  );

create index if not exists tokens_pair_created_at_idx on public.tokens (pair_created_at desc nulls last);

comment on column public.tokens.score is 'ARCHIVED 2026-11-21 (chore/slim-down): score /100 removed, no longer written (stale value on old rows).';
comment on column public.tokens.zone_status is 'ARCHIVED 2026-11-21: Fibonacci zones removed, no longer written (default ''none'' on new rows).';
comment on column public.tokens.zone_source is 'ARCHIVED 2026-11-21: Fibonacci zones removed, no longer written.';
comment on column public.tokens.swing_low is 'ARCHIVED 2026-11-21: Fibonacci zones removed, no longer written.';
comment on column public.tokens.swing_high is 'ARCHIVED 2026-11-21: Fibonacci zones removed, no longer written.';
comment on column public.tokens.zone_low is 'ARCHIVED 2026-11-21: Fibonacci zones removed, no longer written.';
comment on column public.tokens.zone_high is 'ARCHIVED 2026-11-21: Fibonacci zones removed, no longer written.';
comment on column public.tokens.invalidation is 'ARCHIVED 2026-11-21: Fibonacci plan removed, no longer written.';
comment on column public.tokens.tp1 is 'ARCHIVED 2026-11-21: Fibonacci plan removed, no longer written.';
comment on column public.tokens.tp2 is 'ARCHIVED 2026-11-21: Fibonacci plan removed, no longer written.';
comment on column public.tokens.rr is 'ARCHIVED 2026-11-21: Fibonacci R/R removed, no longer written.';
comment on column public.tokens.zone_candles_at is 'ARCHIVED 2026-11-21: zone candles removed, no longer written.';
comment on column public.tokens.liquidity_jup_usd is 'ARCHIVED 2026-11-21: Jupiter liquidity removed from the plumbing, no longer written.';
comment on column public.tokens.p_x3 is 'ARCHIVED 2026-11-21: ×3 model removed, no longer written.';
comment on column public.tokens.p_dd50 is 'ARCHIVED 2026-11-21: ×3 model removed, no longer written.';
comment on column public.tokens.model_version is 'ARCHIVED 2026-11-21: ×3 model removed, no longer written.';
comment on column public.tokens.model_calibrated is 'ARCHIVED 2026-11-21: ×3 model removed, no longer written.';

-- ---------------------------------------------------------------------------
-- 2. token_snapshots
-- ---------------------------------------------------------------------------
alter table public.token_snapshots
  alter column score drop not null,
  alter column zone_status drop not null;

comment on column public.token_snapshots.score is 'ARCHIVED 2026-11-21: score removed, null on every snapshot written since chore/slim-down.';
comment on column public.token_snapshots.zone_status is 'ARCHIVED 2026-11-21: zones removed, null on every snapshot written since chore/slim-down.';

-- ---------------------------------------------------------------------------
-- 3. alert_log: a single alert no longer carries a score / zone
-- ---------------------------------------------------------------------------
alter table public.alert_log drop constraint alert_log_single_has_plan;
alter table public.alert_log
  add constraint alert_log_single_has_plan check (
    kind <> 'single'
    or (entry_price is not null and target_price is not null and stop_price is not null and rr is not null
        and stake_sol is not null and max_price is not null and min_price is not null and last_price is not null
        and last_price_at is not null and tracking_until is not null)
  ) not valid;

comment on column public.alert_log.entry_score is 'ARCHIVED 2026-11-21: score removed, null on alerts sent since chore/slim-down.';
comment on column public.alert_log.entry_zone is 'ARCHIVED 2026-11-21: zones removed, null on alerts sent since chore/slim-down.';

-- ---------------------------------------------------------------------------
-- 4. alert_settings
-- ---------------------------------------------------------------------------
update public.alert_settings set alert_preset = 'young_calm' where alert_preset <> 'young_calm';
alter table public.alert_settings alter column paper_default_strategy set default 'all_x2';

comment on column public.alert_settings.alert_preset is
  'Alert preset of the main stream: young_calm (« Jeune calme », the only one since chore/slim-down; momentum / strict archived).';
comment on column public.alert_settings.min_score is 'ARCHIVED 2026-11-21: score removed, not read.';
comment on column public.alert_settings.only_in_zone is 'ARCHIVED 2026-11-21: zones removed, not read.';
comment on column public.alert_settings.min_rr is 'ARCHIVED 2026-11-21: Fibonacci R/R / model removed, not read.';
comment on column public.alert_settings.min_p_x3 is 'ARCHIVED 2026-11-21: ×3 model removed, not read.';
comment on column public.alert_settings.max_p_dd50 is 'ARCHIVED 2026-11-21: ×3 model removed, not read.';
comment on column public.alert_settings.young_strong_enabled is 'ARCHIVED 2026-11-21: « Jeune & fort » removed, not read.';
comment on column public.alert_settings.paper_default_strategy is 'ARCHIVED 2026-11-21: all_x2 is the only strategy, not read.';
comment on column public.alert_settings.auto_paper_parallel is 'ARCHIVED 2026-11-21: parallel auto-paper books removed, not read.';
comment on column public.alert_settings.auto_paper is
  'Auto-paper (simulation): opens the « Calme » / « Frénésie » positions (books calm_all_x2 / frenzy_all_x2) at every scan.';

-- ---------------------------------------------------------------------------
-- 5. paper_positions: cancel the active positions of the archived books / strategies
-- ---------------------------------------------------------------------------
alter table public.paper_positions
  add column cancel_reason text
    constraint paper_positions_cancel_reason_check check (cancel_reason is null or cancel_reason in ('slim_down')),
  add constraint paper_positions_cancel_reason_status check (cancel_reason is null or status = 'cancelled');

comment on column public.paper_positions.cancel_reason is
  'Why a position was cancelled by a migration: slim_down = archived book or strategy (20261121020000, balance unchanged). null otherwise.';

-- Book main stays live: an OPEN main position with an archived strategy gets its stake back (security review), so the
-- live main balance is not reduced by the archiving. Archived books keep their balance unchanged (no new positions).
update public.paper_wallets w
   set balance_sol = w.balance_sol + r.stake
  from (select user_id, sum(stake_sol) stake from public.paper_positions
         where status = 'open' and book = 'main' and strategy <> 'all_x2'
         group by user_id) r
 where w.user_id = r.user_id and w.book = 'main';

update public.paper_positions
   set status = 'cancelled', closed_at = now(), cancel_reason = 'slim_down'
 where status in ('pending', 'open')
   and (book not in ('main', 'calm_all_x2', 'frenzy_all_x2') or strategy <> 'all_x2');

-- ---------------------------------------------------------------------------
-- 6. paper_open_position_as: books main / calm / frenzy, strategy all_x2
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
  -- Keep in sync with paper.ts: NETWORK_FEE_PER_TX_SOL + TOKEN_ACCOUNT_RENT_SOL (reservedSol).
  c_overhead  constant numeric := 0.0002 + 0.00204;
begin
  if p_user is null then
    raise exception 'paper position: user required' using errcode = '23502';
  end if;
  -- chore/slim-down: the archived books (half_x2_rest_x3, all_x2, young_*) no longer accept positions.
  if p_book is null or p_book not in ('main', 'calm_all_x2', 'frenzy_all_x2') then
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
  -- Calme / Frénésie: one fixed recipe (all_x2, auto-paper, next scan price), so both books stay comparable.
  if p_book in ('calm_all_x2', 'frenzy_all_x2') and (p_source <> 'auto_alert' or v_mode <> 'next_tick') then
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
  'service_role (auto-paper): opens a pending all_x2 paper position + its leg for p_user in book main / calm_all_x2 / frenzy_all_x2, with every balance / cap / token check and the 12 h cooldown after a stop on the same mint. Books calm_all_x2 / frenzy_all_x2: auto_alert + next_tick only, one position per (user, book, mint) forever.';

revoke execute on function public.paper_open_position_as(uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.paper_open_position_as(uuid, text, text, text, numeric, numeric, numeric, numeric, numeric, text, bigint, text)
  to service_role;

-- Manual entry point: same signature (p_book kept for compatibility, 'main' only), strategy all_x2 only.
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

comment on function public.paper_open_position(text, text, numeric, numeric, numeric, numeric, numeric, text) is
  'Opens a pending all_x2 paper position (simulation) for the caller in book main. Errors: paper position: insufficient paper balance / too many … / unknown token / invalid …; « Stop touché il y a moins de 12 h sur ce token … » (cooldown).';

revoke execute on function public.paper_open_position(text, text, numeric, numeric, numeric, numeric, numeric, text)
  from public, anon;
grant execute on function public.paper_open_position(text, text, numeric, numeric, numeric, numeric, numeric, text)
  to authenticated;

-- Wallet RPCs (caller's own wallet): the three active books only.
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
  if p_book is null or p_book not in ('main', 'calm_all_x2', 'frenzy_all_x2') then
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
  if p_book is null or p_book not in ('main', 'calm_all_x2', 'frenzy_all_x2') then
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
-- 7. performance_by_preset(): young_calm / young_frenzy
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

comment on function public.performance_by_preset() is
  'Per preset (young_calm / young_frenzy) and segment (all / gta / other): preset_signals label counts, simulated all_x2 P&L from the labels, and the caller''s paper P&L of the preset books (young_calm: calm_all_x2, young_frenzy: frenzy_all_x2). The archived presets are not reported.';

revoke execute on function public.performance_by_preset() from public, anon;
grant execute on function public.performance_by_preset() to authenticated;

-- ---------------------------------------------------------------------------
-- 8. performance_breakdown(): scan + the two young presets, no zone, no radar
-- ---------------------------------------------------------------------------
create or replace function public.performance_breakdown()
returns table (
  source               text,
  dimension            text,
  bucket               text,
  n                    integer,
  n_final              integer,
  x2                   integer,
  x3                   integer,
  x2_before_sl30       integer,
  sl30_before_x2       integer,
  dd50_first           integer,
  median_max_multiple  numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
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

comment on function public.performance_breakdown() is
  'Performance aggregates of labelled outcomes per source (scan / preset:young_calm / preset:young_frenzy) and dimension (all / dex / mc / liq). Radar, zone and the archived presets are not reported.';

revoke execute on function public.performance_breakdown() from public, anon;
grant execute on function public.performance_breakdown() to authenticated;

-- ---------------------------------------------------------------------------
-- 9. backfill_progress(): the label-outcomes queue after chore/slim-down
-- ---------------------------------------------------------------------------
-- Categories in queue priority order (label-outcomes, _shared/candle-queue.ts WORK_PRIORITY):
--   1 candles_1m (scan + young preset detections, pair < 48 h)  2 event_candles (young_calm_ev / young_frenzy_ev, 1 min)
--   3 preset_labels (young_calm / young_frenzy)  4 scan_labels  5 candles_5m (same tables, best effort)
-- Definitions of done / total / due_now / last_24h, rows_per_hour and eta unchanged (20261119100000_lab_v2.sql).
create or replace function public.backfill_progress()
returns jsonb
language plpgsql
stable
-- invoker: the caller's RLS applies (every table read here is SELECT-able by authenticated).
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

comment on function public.backfill_progress() is
  'Laboratoire catch-up gauge (aggregates only): per category done / total / due_now / last_24h in queue priority order (radar and archived presets removed), measured label-outcomes throughput over 6 h and ETA.';

revoke execute on function public.backfill_progress() from public, anon, authenticated;
grant execute on function public.backfill_progress() to authenticated;

-- ---------------------------------------------------------------------------
-- 10. Archived tables (no code writes them any more, docs/ARCHIVE.md)
-- ---------------------------------------------------------------------------
comment on table public.watchlist is 'ARCHIVED 2026-11-21 (chore/slim-down): no screen, no longer read by the scan.';
comment on table public.model_weights is 'ARCHIVED 2026-11-21: ×3 model removed, never read nor written.';
comment on table public.early_candidates is 'ARCHIVED 2026-11-21: early radar removed (scan-early deleted), never written nor purged.';
comment on table public.early_observations is 'ARCHIVED 2026-11-21: early radar removed, never written nor purged.';
comment on table public.early_outcomes is 'ARCHIVED 2026-11-21: early radar removed, no longer labelled.';
comment on table public.early_runs is 'ARCHIVED 2026-11-21: early radar removed, never written nor purged.';
comment on table public.fast_watch is 'ARCHIVED 2026-11-21: « Jeune & fort » fast tracking removed (track-fast deleted).';
comment on table public.fast_ticks is 'ARCHIVED 2026-11-21: « Jeune & fort » fast tracking removed, never written nor purged.';
