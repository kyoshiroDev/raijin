-- Hardening: Supabase default privileges left extra table privileges to authenticated.
-- TRUNCATE bypasses RLS (it would empty every user's watchlist), REFERENCES/TRIGGER are not
-- needed, and on Postgres 17 MAINTAIN (LOCK, VACUUM, REFRESH…) is not needed either.
-- Effective rights after this migration:
--   tokens, token_snapshots, scan_runs, alert_log : SELECT
--   watchlist, push_subscriptions, alert_settings : SELECT, INSERT, UPDATE, DELETE (RLS owner-only)
--   test_push_throttle                           : nothing
-- anon keeps nothing (revoked in earlier migrations; repeated here for clarity).

revoke truncate, references, trigger on public.watchlist from authenticated;
revoke truncate, references, trigger
  on public.push_subscriptions, public.alert_settings, public.alert_log, public.test_push_throttle
  from authenticated;

revoke maintain on all tables in schema public from authenticated, anon;

revoke all on public.tokens, public.token_snapshots, public.scan_runs, public.watchlist,
  public.push_subscriptions, public.alert_settings, public.alert_log, public.test_push_throttle
  from anon;
