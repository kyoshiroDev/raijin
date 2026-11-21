-- Run in the SQL editor of the REMOTE project, AFTER applying migration 20261119100000_lab_v2.sql and
-- deploying label-outcomes (supabase functions deploy label-outcomes --no-verify-jwt).
-- Contains no secret: the project URL and the cron secret are read from Vault (raijin_project_url,
-- raijin_cron_secret, created by schedule_cron.sql). label-outcomes uses the same CRON_SECRET as scan-tokens.
--
-- lab-v2 (docs/contracts/lab-v2.md §1, migration 20261119100000): every 2 minutes at ODD minutes ('1-59/2 * * * *'),
-- so it never overlaps scan-tokens (even minutes, which also calls GeckoTerminal). Measured before the change
-- (pg_net responses, 19/11 15:47–21:27 UTC): 26 runs, 3.9 requests and 2.8 rows per run, a 429 in EVERY run, i.e.
-- ≈ 13 rows/h hosted: the GeckoTerminal limit is per minute (and shared by the Edge IP), so short frequent calls beat
-- long rare ones. Each call: ≤ 5 requests spaced by 8 s, stop at the FIRST 429 (no retry: the rest of the queue waits
-- for the next call), nothing new after 40 s, everything aborted at 50 s (pg_net timeout 55 s, next call 2 min later).
-- One merged queue, priority: 1 preset labels, 2 event candles (backtest_events, 1 min), 3 scan labels, 4 1-minute
-- candles of detections whose pair was < 48 h old, 5 radar labels, 6 5-minute candles (best effort).
-- Each call writes one row in public.label_runs (requests, 429, rows written): measured throughput of
-- rpc('backfill_progress'), purged after 7 days (supabase/sql/schedule_backtest.sql, job raijin-purge-lab).
-- cron.schedule with an existing job name updates that job (schedule and command): re-running this file replaces the
-- former 10-minute 'raijin-label' ('7-59/10 * * * *') job, no unschedule needed.

select cron.schedule(
  'raijin-label',
  '1-59/2 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'raijin_project_url')
           || '/functions/v1/label-outcomes',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'raijin_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- Check:   select jobname, schedule, active from cron.job where jobname = 'raijin-label';
-- History: select status, return_message, start_time from cron.job_run_details
--          where jobid = (select jobid from cron.job where jobname = 'raijin-label')
--          order by start_time desc limit 10;
-- Responses: select status_code, content from net._http_response order by created desc limit 10;
-- Stop:    select cron.unschedule('raijin-label');
-- Throughput: select * from public.label_runs order by at desc limit 20;
--             select public.backfill_progress();   -- as an authenticated user (the gauge of the Laboratoire)
