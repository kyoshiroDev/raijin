-- feat/wallet-study (OFFLINE STUDY: no alert, no trading, no wallet). Run in the SQL editor of the REMOTE project,
-- AFTER applying migration 20261123010000_wallet_study.sql, setting the secret HELIUS_API_KEY and deploying
-- wallet-study-collect (supabase functions deploy wallet-study-collect --no-verify-jwt).
-- Contains no secret: the project URL and the cron secret are read from Vault (raijin_project_url,
-- raijin_cron_secret, created by schedule_cron.sql). The Helius key is NOT in Vault nor in the database: it is only
-- the Edge Function secret HELIUS_API_KEY.
--
-- Every minute. Each call: lease 90 s with an owner token (an overlapping call does nothing), ≤ 5 mints, ≤ 6.7 req/s,
-- no new request after 30 s (15 s timeout each), 10 credits reserved before each request (refunded when Helius answers
-- with an error), HARD STOP at 600 000 credits (the function then answers { stopped: 'budget' } without calling
-- Helius). A 429 or an outage (revoked key 401/403, 5xx, network, DB error) stops the call without touching the queue:
-- { stopped: 'outage' | 'rate_limited', error } in net._http_response; fix the cause or unschedule.

select cron.schedule(
  'raijin-wallet-study',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'raijin_project_url')
           || '/functions/v1/wallet-study-collect',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'raijin_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- Check:     select jobname, schedule, active from cron.job where jobname = 'raijin-wallet-study';
-- Responses: select status_code, content from net._http_response order by created desc limit 10;
-- Progress (as an authenticated user or in the SQL editor):
--   select status, count(*), sum(credits_used) from public.wallet_study_state group by status;
--   select credits_used, hard_cap from public.wallet_study_budget;
--   -- remaining labelled mints never studied:
--   select count(*) from public.signal_outcomes o
--    where (o.status = 'final' or o.x2_before_sl30 is not null)
--      and not exists (select 1 from public.wallet_study_state s where s.mint = o.mint);
--
-- STOP when the collection is complete (no pending row and the count above is 0) or at any time:
--   select cron.unschedule('raijin-wallet-study');
