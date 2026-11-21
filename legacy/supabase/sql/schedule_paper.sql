-- Run ONCE in the SQL editor of the REMOTE project, AFTER applying migration 20261117230000_paper_trading.sql and
-- deploying paper-engine (supabase functions deploy paper-engine --no-verify-jwt).
-- Contains no secret: the project URL and the cron secret are read from Vault (raijin_project_url,
-- raijin_cron_secret, created by schedule_cron.sql). paper-engine uses the same CRON_SECRET as scan-tokens.
--
-- Paper trading is a SIMULATION: the engine only reads prices and Jupiter quotes, it never sends a transaction.
--
-- Odd minutes (1, 3, …, 59), like enrich-tokens. Why:
--   - freshest prices: the scan of the previous even minute has written its snapshots (≤ 45 s), so ticks are
--     ~15–25 s old, and the engine never reads while the scan is writing;
--   - the scan's Jupiter / GeckoTerminal calls (even minutes) are never shared with the engine;
--   - enrich-tokens runs the same minute but its Jupiter round trips take its first ~3–15 s: the engine starts its
--     quotes at t = 10 s, ≤ 10 calls, one every 2.1 s, stops on 429 (unknown impact → +2 % in the engine);
--   - the engine makes NO GeckoTerminal call, so label-outcomes (minute 17) and the candles budget are untouched.

select cron.schedule(
  'raijin-paper',
  '1-59/2 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'raijin_project_url')
           || '/functions/v1/paper-engine',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'raijin_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- Check:   select jobname, schedule, active from cron.job where jobname = 'raijin-paper';
-- History: select status, return_message, start_time from cron.job_run_details
--          where jobid = (select jobid from cron.job where jobname = 'raijin-paper')
--          order by start_time desc limit 10;
-- Responses: select status_code, content from net._http_response order by created desc limit 10;
-- Stop:    select cron.unschedule('raijin-paper');
