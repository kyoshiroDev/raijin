-- fix/measurement-and-criteria — alert presets, daily cap and auto-paper defaults.
--   alert_settings.alert_preset : 'momentum' (default, « Momentum (expérimental) », _shared/presets.ts) or 'strict'
--                                 (historical rules: min_score / only_in_zone / R/R / model gate). Used by scan-tokens.
--   alert_settings.max_per_day  : daily cap (1-100, default 30) on top of max_per_hour (default 4, unchanged), counted
--                                 like the hourly budget (distinct notifications of kind single + grouped, last 24 h).
-- Existing rows: alert_preset = 'momentum', max_per_hour = 4, max_per_day = 30, and auto-paper on Momentum alerts in
-- both parallel books (auto_paper = true, auto_paper_parallel = true) with stake_sol = 0.1 SOL per position.
-- SIMULATION ONLY: auto-paper never touches a wallet.
--
-- Security: no new table, no policy change. alert_settings keeps RLS enabled with its owner-only policies; the new
-- columns inherit the table-level grants (owner CRUD through RLS); anon has nothing.

alter table public.alert_settings
  add column alert_preset text not null default 'momentum'
    constraint alert_settings_alert_preset_check check (alert_preset in ('momentum', 'strict')),
  add column max_per_day smallint not null default 30
    constraint alert_settings_max_per_day_check check (max_per_day between 1 and 100);

comment on column public.alert_settings.alert_preset is
  'Alert rules: momentum (experimental, presets.ts matchesPreset) or strict (min_score / only_in_zone / R/R / model gate).';
comment on column public.alert_settings.max_per_day is 'Max pushes (single + grouped) per rolling 24 h, on top of max_per_hour.';

update public.alert_settings
   set alert_preset = 'momentum',
       max_per_hour = 4,
       max_per_day = 30,
       auto_paper = true,
       auto_paper_parallel = true,
       stake_sol = 0.1;
