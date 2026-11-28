-- fix/measurement-and-criteria — outcome labels from 15-minute GeckoTerminal candles get the ×2 vs −30 % order.
-- Why: the alert / paper plans use a −30 % stop; « ×2 reached » alone hides tokens that hit the stop first.
--   hit_sl30        : some low ≤ 0.7 × entry within the 7-day window
--   x2_before_sl30  : ×2 strictly before any −30 % candle (same candle = stop first, conservative)
--   sl30_before_x2  : −30 % first (or same candle). At most one of the two is true; both false while neither happened.
--   min_multiple_7d : min low / entry; hours_to_x2 : first ×2 candle − detection (hours)
-- signal_outcomes.entry_dex_id: DEX of the first snapshot (Performance by DEX), backfilled from token_snapshots.
-- New columns inherit the existing table grants (authenticated SELECT through RLS, writes service_role only).

alter table public.signal_outcomes
  add column hit_sl30 boolean,
  add column x2_before_sl30 boolean,
  add column sl30_before_x2 boolean,
  add column min_multiple_7d numeric constraint signal_outcomes_min_multiple_check check (min_multiple_7d is null or min_multiple_7d >= 0),
  add column hours_to_x2 numeric constraint signal_outcomes_hours_to_x2_check check (hours_to_x2 is null or (hours_to_x2 >= 0 and hours_to_x2 <= 744)),
  add column entry_dex_id text constraint signal_outcomes_entry_dex_check check (entry_dex_id is null or entry_dex_id ~ '^[a-z0-9_-]{1,32}$'),
  add constraint signal_outcomes_x2_sl30_exclusive check (not (coalesce(x2_before_sl30, false) and coalesce(sl30_before_x2, false)));

alter table public.early_outcomes
  add column hit_sl30 boolean,
  add column x2_before_sl30 boolean,
  add column sl30_before_x2 boolean,
  add column min_multiple_7d numeric constraint early_outcomes_min_multiple_check check (min_multiple_7d is null or min_multiple_7d >= 0),
  add column hours_to_x2 numeric constraint early_outcomes_hours_to_x2_check check (hours_to_x2 is null or (hours_to_x2 >= 0 and hours_to_x2 <= 744)),
  add constraint early_outcomes_x2_sl30_exclusive check (not (coalesce(x2_before_sl30, false) and coalesce(sl30_before_x2, false)));

-- DEX at detection: first snapshot at or before the detection (+2 min tolerance), else the current tokens row.
update public.signal_outcomes o
set entry_dex_id = coalesce(
  (select s.dex_id from public.token_snapshots s
    where s.mint = o.mint and s.captured_at <= o.detected_at + interval '2 minutes' and s.dex_id ~ '^[a-z0-9_-]{1,32}$'
    order by s.captured_at desc limit 1),
  (select t.dex_id from public.tokens t where t.mint = o.mint and t.dex_id ~ '^[a-z0-9_-]{1,32}$'))
where o.entry_dex_id is null;
