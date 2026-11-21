-- Replaces the nightly snapshot purge (no secret in this file).
-- Why: with the extra sources the scan writes ~115k token_snapshots per day; a flat 30-day retention would
-- reach ~1 GB. The x3 features only need the last 24 h, labelling uses GeckoTerminal candles, and alert
-- tracking needs the alerted mints for 7 days. So:
--   * keep everything younger than 3 days;
--   * keep up to 30 days for mints alerted in the last 30 days (alert follow-up and statistics);
--   * delete the rest.
-- Run once in the SQL editor (or `supabase db query --remote --file`).

select cron.unschedule('raijin-purge-snapshots')
where exists (select 1 from cron.job where jobname = 'raijin-purge-snapshots');

select cron.schedule(
  'raijin-purge-snapshots',
  '15 3 * * *',
  $$
  delete from public.token_snapshots s
  where s.captured_at < now() - interval '30 days'
     or (s.captured_at < now() - interval '3 days'
         and not exists (
           select 1 from public.alert_log l
           where l.mint = s.mint and l.sent_at > now() - interval '30 days'
         )
         -- keep the history of mints not yet recorded in signal_outcomes: label-outcomes backfills them
         -- from their FIRST snapshot (deleting it would bias the entry price).
         and exists (select 1 from public.signal_outcomes o where o.mint = s.mint));
  $$
);

-- Check: select jobname, schedule from cron.job where jobname = 'raijin-purge-snapshots';
