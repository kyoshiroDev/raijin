-- fix/measurement-and-criteria — preset_signals: FIRST time a token matched an alert preset at scan time, then its
-- 7-day outcome labelled from candles by label-outcomes (same label columns as signal_outcomes, sl30 ones included).
-- Written by scan-tokens (best effort, ignoreDuplicates on (preset, mint)) independently of users and pushes, so the
-- « Performance » screen can measure each preset on every match, not only on delivered alerts.
--   'momentum' : matchesPreset('momentum') of _shared/presets.ts
--   'strict'   : matchesPreset('strict') with the alert_settings column defaults (score >= 70, zone 'in', ...)
-- No foreign key to tokens on purpose (like early_outcomes): a token purge must not erase measurements.
--
-- Security
--   RLS enabled, SELECT policy for authenticated only; no insert/update/delete policy (writes are service_role only,
--   which bypasses RLS). Supabase default privileges grant ALL on new tables, so everything is revoked from anon and
--   authenticated first (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN included), then SELECT is granted back to
--   authenticated. anon gets nothing.
-- Units: *_pct are PERCENT; multiples are ratios (2 = x2); money in USD.
-- Upper bounds also reject 'Infinity' / 'NaN' (numeric accepts both and NaN sorts above everything).

create table public.preset_signals (
  id                   bigint generated always as identity primary key,
  preset               text not null check (preset in ('momentum', 'strict')),
  mint                 text not null check (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  pair_address         text not null check (pair_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  detected_at          timestamptz not null,
  entry_price          numeric not null check (entry_price > 0 and entry_price < 1e12),
  entry_mc             numeric check (entry_mc is null or (entry_mc >= 0 and entry_mc < 1e15)),
  entry_liq_eff        numeric check (entry_liq_eff is null or (entry_liq_eff >= 0 and entry_liq_eff < 1e13)),
  entry_zone           text check (entry_zone is null or entry_zone in ('in', 'wait', 'deep', 'broken', 'none')),
  entry_dex_id         text check (entry_dex_id is null or entry_dex_id ~ '^[a-z0-9_-]{1,32}$'),
  entry_change_1h      numeric check (entry_change_1h is null or (entry_change_1h >= -100 and entry_change_1h < 1e9)),
  entry_roundtrip_pct  numeric check (entry_roundtrip_pct is null or entry_roundtrip_pct between -100 and 100),
  status               text not null default 'pending' check (status in ('pending', 'final')),
  hit_x2               boolean,
  hit_x3               boolean,
  hit_x5               boolean,
  dd50_first           boolean,
  max_multiple_7d      numeric check (max_multiple_7d is null or (max_multiple_7d >= 0 and max_multiple_7d < 1e9)),
  hours_to_x3          numeric check (hours_to_x3 is null or hours_to_x3 between 0 and 744),
  hit_sl30             boolean,
  x2_before_sl30       boolean,
  sl30_before_x2       boolean,
  min_multiple_7d      numeric check (min_multiple_7d is null or (min_multiple_7d >= 0 and min_multiple_7d < 1e9)),
  hours_to_x2          numeric check (hours_to_x2 is null or hours_to_x2 between 0 and 744),
  observed_hours       numeric check (observed_hours is null or observed_hours between 0 and 744),
  labelled_at          timestamptz,
  label_attempts       smallint not null default 0 check (label_attempts between 0 and 10000),
  label_error          text check (label_error is null or char_length(label_error) <= 200),
  created_at           timestamptz not null default now(),
  -- First match per preset per mint.
  constraint preset_signals_preset_mint_key unique (preset, mint),
  constraint preset_signals_x2_sl30_exclusive check (not (coalesce(x2_before_sl30, false) and coalesce(sl30_before_x2, false))),
  -- A final row carries every label.
  constraint preset_signals_final_has_labels check (
    status = 'pending'
    or (hit_x2 is not null and hit_x3 is not null and hit_x5 is not null and dd50_first is not null
        and max_multiple_7d is not null and observed_hours is not null and labelled_at is not null)
  )
);

comment on table public.preset_signals is
  'First match of each token per alert preset (momentum / strict) at scan time, and its 7-day outcome labelled from candles by label-outcomes.';
comment on column public.preset_signals.entry_liq_eff is 'tokens.liquidity_effective_usd at detection (else DexScreener liquidity).';
comment on column public.preset_signals.entry_change_1h is 'DexScreener 1 h price change at detection (PERCENT).';

create index preset_signals_status_detected_idx on public.preset_signals (status, detected_at desc);
-- label-outcomes queue: never-labelled rows first, then the least recently labelled.
create index preset_signals_pending_queue_idx on public.preset_signals (labelled_at nulls first, detected_at)
  where status = 'pending';

-- Privileges (defense in depth, on top of RLS). service_role is left untouched.
revoke all on public.preset_signals from anon, authenticated;
grant select on public.preset_signals to authenticated;

alter table public.preset_signals enable row level security;

create policy "preset signals are readable by signed-in users"
  on public.preset_signals for select to authenticated using (true);

-- No insert / update / delete policy: writes are service_role only (scan-tokens, label-outcomes).
