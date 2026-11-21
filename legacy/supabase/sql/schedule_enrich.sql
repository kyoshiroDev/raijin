-- Run ONCE in the SQL editor of the REMOTE project, AFTER deploying enrich-tokens
-- (supabase functions deploy enrich-tokens --no-verify-jwt).
-- Contains no secret: the project URL and the cron secret are read from Vault
-- (raijin_project_url, raijin_cron_secret, created by schedule_cron.sql). enrich-tokens uses the same
-- CRON_SECRET as scan-tokens, so no new secret is needed.
--
-- Odd minutes (1, 3, …, 59): 1 minute after each scan ('*/2 * * * *'), so the two functions do not overlap
-- (scan ~25 s, enrich <= 45 s by design).

select cron.schedule(
  'raijin-enrich',
  '1-59/2 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'raijin_project_url')
           || '/functions/v1/enrich-tokens',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'raijin_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- Check:   select jobname, schedule, active from cron.job where jobname = 'raijin-enrich';
-- History: select status, return_message, start_time from cron.job_run_details
--          where jobid = (select jobid from cron.job where jobname = 'raijin-enrich')
--          order by start_time desc limit 10;
-- Responses: select status_code, content from net._http_response order by created desc limit 10;
-- Stop:    select cron.unschedule('raijin-enrich');
