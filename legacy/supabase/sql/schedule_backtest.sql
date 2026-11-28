-- Run in the SQL editor of the REMOTE project (or `supabase db query --linked --file supabase/sql/schedule_backtest.sql`),
-- AFTER applying migrations 20261119090000_backtest_lab.sql and 20261119100000_lab_v2.sql and deploying backtest-run
-- (supabase functions deploy backtest-run --no-verify-jwt).
-- Contains no secret: the project URL and the cron secret are read from Vault (raijin_project_url,
-- raijin_cron_secret, created by schedule_cron.sql). backtest-run uses the same CRON_SECRET as scan-tokens.
--
-- Three jobs (feat/strategy-lab, docs/contracts/strategy-lab.md §B6):
--   raijin-backtest-worker  every minute: backtest-run takes the oldest queued / running run and advances it by one
--                           slice (< 1.5 s of CPU: simulation of a chunk of detections, then the aggregation), then
--                           returns. Nothing to do → returns at once (one cheap SELECT).
--   raijin-backtest-nightly 03:40 UTC: queues a 'nightly' run (backtest_enqueue_nightly(): skipped while a run is
--                           queued / running; same advisory lock as the manual RPC backtest_request_run()).
--   raijin-purge-candles    03:25 UTC: deletes ohlcv_candles of detections older than 30 days.
--   raijin-purge-lab        03:30 UTC (lab-v2, migration 20261119100000): backtest_events older than 30 days, event
--                           scanner state of mints not seen for 7 days, label_runs journal older than 7 days.
-- lab-v2: the worker job is unchanged (same function, same minute cadence); backtest-run now also advances the
-- incremental event scanner (token_snapshots → backtest_events) when no run is active, and between run slices.
-- cron.schedule with an existing job name updates that job: re-running this file is safe.

select cron.schedule(
  'raijin-backtest-worker',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'raijin_project_url')
           || '/functions/v1/backtest-run',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'raijin_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

select cron.schedule(
  'raijin-backtest-nightly',
  '40 3 * * *',
  $$ select public.backtest_enqueue_nightly(); $$
);

select cron.schedule(
  'raijin-purge-candles',
  '25 3 * * *',
  $$ delete from public.ohlcv_candles where detected_at < now() - interval '30 days'; $$
);

select cron.schedule(
  'raijin-purge-lab',
  '30 3 * * *',
  $$
  delete from public.backtest_events where event_at < now() - interval '30 days';
  delete from public.backtest_event_state where key <> 'cursor' and updated_at < now() - interval '7 days';
  delete from public.label_runs where at < now() - interval '7 days';
  $$
);

-- Check:   select jobname, schedule, active from cron.job where jobname like 'raijin-backtest%' or jobname in ('raijin-purge-candles', 'raijin-purge-lab');
-- History: select status, return_message, start_time from cron.job_run_details
--          where jobid = (select jobid from cron.job where jobname = 'raijin-backtest-worker')
--          order by start_time desc limit 10;
-- Runs:    select id, status, trigger, progress, error, created_at, started_at, finished_at
--          from public.backtest_runs order by id desc limit 5;
-- Manual:  select public.backtest_enqueue_nightly();   -- queues a run now (as postgres, in the SQL editor)
-- Stop:    select cron.unschedule('raijin-backtest-worker'); select cron.unschedule('raijin-backtest-nightly');
--          select cron.unschedule('raijin-purge-candles'); select cron.unschedule('raijin-purge-lab');
