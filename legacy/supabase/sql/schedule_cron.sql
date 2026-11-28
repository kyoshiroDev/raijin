-- Run ONCE in the Supabase SQL editor of the REMOTE project, after deploying scan-tokens.
-- Not a migration on purpose: it needs secrets that must never be committed.
--
-- 1) Generate a long random secret locally:   openssl rand -hex 32
-- 2) Give it to the Edge Function:            supabase secrets set CRON_SECRET=<secret>
-- 3) Replace the two placeholders below, run this file, then clear the editor.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('https://<PROJECT_REF>.supabase.co', 'raijin_project_url');
select vault.create_secret('<SAME_SECRET_AS_CRON_SECRET>', 'raijin_cron_secret');

-- Scan every 2 minutes
select cron.schedule(
  'raijin-scan',
  '*/2 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'raijin_project_url')
           || '/functions/v1/scan-tokens',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'raijin_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- Enrichment 1 minute after each scan (odd minutes): GeckoTerminal, RugCheck, Jupiter round trip.
-- Same Vault secrets as the scan. Also available alone in schedule_enrich.sql.
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

-- Outcome labelling (signal_outcomes, preset_signals; early_outcomes archived since chore/slim-down) every 10 minutes at minutes 7, 17, … (odd
-- minutes: no overlap with the scan's GeckoTerminal candles), ~4 rows per run. Same Vault secrets. Also available
-- alone in schedule_label.sql.
select cron.schedule(
  'raijin-label',
  '7-59/10 * * * *',
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

-- Paper trading engine (simulation only), odd minutes like enrich-tokens: fresh snapshots of the previous scan,
-- quotes from t = 10 s, no GeckoTerminal call. Same Vault secrets. Also available alone in schedule_paper.sql.
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

-- Purge snapshots older than 30 days, every night at 03:15 UTC
select cron.schedule(
  'raijin-purge-snapshots',
  '15 3 * * *',
  $$ delete from public.token_snapshots where captured_at < now() - interval '30 days'; $$
);

-- Purge scan logs older than 7 days
select cron.schedule(
  'raijin-purge-scan-runs',
  '20 3 * * *',
  $$ delete from public.scan_runs where started_at < now() - interval '7 days'; $$
);

-- Purge push alert history older than 30 days (dedup needs 12 h, hourly budget 1 h, and since fix/alerts every
-- single alert is a tracked position for 7 days: keep its outcome for 30 days for the « Alertes » history).
-- Already scheduled with 7 days? Re-run this block: cron.schedule with the same name replaces the job.
select cron.schedule(
  'raijin-purge-alert-log',
  '25 3 * * *',
  $$ delete from public.alert_log where sent_at < now() - interval '30 days'; $$
);

-- Check:   select * from cron.job;
-- History: select * from cron.job_run_details order by start_time desc limit 20;
-- Stop:    select cron.unschedule('raijin-scan');  select cron.unschedule('raijin-enrich');  select cron.unschedule('raijin-label');  select cron.unschedule('raijin-paper');
-- chore/slim-down (2026-11-21): the radar (raijin-early, raijin-purge-early) and the fast tracking (raijin-fast,
-- raijin-purge-fast-ticks) were removed — see unschedule_slim_down.sql. The backtest jobs live in schedule_backtest.sql,
-- the label cadence in schedule_label.sql, the candle / lab purges in schedule_backtest.sql / schedule_purge_snapshots.sql.
