-- chore/slim-down (2026-11-21) — run ONCE in the SQL editor of the REMOTE project, AFTER applying migration
-- 20261121020000_slim_down.sql and deploying the updated functions (scan-tokens, enrich-tokens, label-outcomes,
-- paper-engine, backtest-run), and BEFORE deleting the scan-early / track-fast Edge Functions.
-- Contains no secret. Idempotent: a job that does not exist is skipped (no error).
--
-- Removed jobs:
--   raijin-early             radar précoce (scan-early), odd minutes
--   raijin-purge-early       radar purges (early_* tables are archived: kept, no longer purged)
--   raijin-fast              « Jeune & fort » fast tracking (track-fast), every minute
--   raijin-purge-fast-ticks  fast_ticks purge (fast_ticks archived: kept, no longer purged)

do $$
declare
  j text;
begin
  foreach j in array array['raijin-early', 'raijin-purge-early', 'raijin-fast', 'raijin-purge-fast-ticks'] loop
    if exists (select 1 from cron.job where jobname = j) then
      perform cron.unschedule(j);
      raise notice 'unscheduled %', j;
    else
      raise notice '% not scheduled (skipped)', j;
    end if;
  end loop;
end $$;

-- Check (expected after this file: raijin-scan, raijin-enrich, raijin-label, raijin-paper, raijin-backtest-worker,
-- raijin-backtest-nightly and the purges raijin-purge-snapshots / -scan-runs / -candles / -lab, 10 jobs on 21/11):
--   select jobname, schedule, active from cron.job order by jobname;
