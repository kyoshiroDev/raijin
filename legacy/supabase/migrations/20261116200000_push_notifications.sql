-- Raijin — Web Push notifications
-- Tables: push_subscriptions, alert_settings, alert_log, test_push_throttle.
-- Every table has RLS. anon has nothing. alert_log and test_push_throttle are written by service_role only.

-- ---------------------------------------------------------------------------
-- push_subscriptions : one row per browser/device PushSubscription
-- ---------------------------------------------------------------------------
create table public.push_subscriptions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Anchored allowlist of push services (mirrored in _shared/webpush.ts isAllowedPushEndpoint):
  -- the Edge Functions POST to this URL, so it must never point anywhere else (SSRF).
  endpoint    text not null unique
              check (
                char_length(endpoint) <= 1000
                and endpoint !~ '\s'
                and endpoint ~ '^https://(web\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)/'
              ),
  -- base64url (padding tolerated): P-256 public key = 65 bytes (87-88 chars), auth secret = 16 bytes (22-24 chars).
  p256dh      text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}={0,2}$'),
  auth        text not null check (auth ~ '^[A-Za-z0-9_-]{16,32}={0,2}$'),
  user_agent  text check (char_length(user_agent) <= 300),
  created_at  timestamptz not null default now()
);

create index push_subscriptions_user_id_idx on public.push_subscriptions (user_id, created_at desc);

-- At most 10 devices per user (the senders only use the 5 most recent anyway).
-- Runs as the caller: under RLS the count only sees the caller's own rows, which is what we want.
create function public.enforce_push_subscription_cap()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select count(*) from public.push_subscriptions where user_id = new.user_id) >= 10 then
    raise exception 'too many push subscriptions' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger push_subscriptions_cap
  before insert on public.push_subscriptions
  for each row execute function public.enforce_push_subscription_cap();

-- ---------------------------------------------------------------------------
-- alert_settings : per-user alert preferences (hours are Europe/Paris)
-- ---------------------------------------------------------------------------
create table public.alert_settings (
  user_id             uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  enabled             boolean not null default false,
  min_score           smallint not null default 70 check (min_score between 0 and 100),
  only_in_zone        boolean not null default true,
  hide_bonding_curve  boolean not null default true,
  quiet_start         smallint not null default 23 check (quiet_start between 0 and 23),
  quiet_end           smallint not null default 7 check (quiet_end between 0 and 23),
  max_per_hour        smallint not null default 4 check (max_per_hour between 1 and 20),
  updated_at          timestamptz not null default now()
);

create index alert_settings_enabled_idx on public.alert_settings (user_id) where enabled;

create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger alert_settings_touch
  before update on public.alert_settings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- alert_log : what was notified (12 h dedup per mint, hourly budget per user)
-- One row per mint. A grouped notification writes one row per mint it covers,
-- all sharing the same notification_id: the hourly budget counts DISTINCT notification_id.
-- Purged after 7 days (supabase/sql/schedule_cron.sql).
-- ---------------------------------------------------------------------------
create table public.alert_log (
  id               bigint generated always as identity primary key,
  user_id          uuid not null references auth.users (id) on delete cascade,
  mint             text not null check (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  notification_id  uuid not null default gen_random_uuid(),
  kind             text not null default 'single' check (kind in ('single', 'grouped')),
  sent_at          timestamptz not null default now()
);

create index alert_log_user_sent_idx      on public.alert_log (user_id, sent_at desc);
create index alert_log_user_mint_sent_idx on public.alert_log (user_id, mint, sent_at desc);
create index alert_log_sent_idx           on public.alert_log (sent_at);

-- ---------------------------------------------------------------------------
-- test_push_throttle : rate limit of send-test-push (1 per minute per user).
-- Separate table so users can never reset it: no grant, no policy for authenticated.
-- ---------------------------------------------------------------------------
create table public.test_push_throttle (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  last_sent_at  timestamptz not null default now()
);

-- Atomically claims the right to send a test push. Returns true if allowed (and records it),
-- false if the previous one was less than a minute ago. service_role only.
create function public.claim_test_push(p_user uuid)
returns boolean
language sql
set search_path = ''
as $$
  with claimed as (
    insert into public.test_push_throttle as t (user_id, last_sent_at)
    values (p_user, now())
    on conflict (user_id) do update
      set last_sent_at = excluded.last_sent_at
      where t.last_sent_at < now() - interval '1 minute'
    returning 1
  )
  select exists (select 1 from claimed);
$$;

-- ---------------------------------------------------------------------------
-- Privileges (defense in depth, on top of RLS). service_role is left untouched.
-- ---------------------------------------------------------------------------
revoke all on public.push_subscriptions, public.alert_settings, public.alert_log, public.test_push_throttle from anon;
revoke all on public.push_subscriptions, public.alert_settings, public.alert_log, public.test_push_throttle from authenticated;

grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant select, insert, update, delete on public.alert_settings     to authenticated;
grant select                         on public.alert_log          to authenticated;
-- test_push_throttle: nothing for authenticated.

revoke execute on function public.claim_test_push(uuid)               from public, anon, authenticated;
revoke execute on function public.enforce_push_subscription_cap()     from public, anon, authenticated;
revoke execute on function public.touch_updated_at()                  from public, anon, authenticated;
grant  execute on function public.claim_test_push(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.push_subscriptions enable row level security;
alter table public.alert_settings     enable row level security;
alter table public.alert_log          enable row level security;
alter table public.test_push_throttle enable row level security;

-- push_subscriptions : owner only
create policy "users read their push subscriptions"
  on public.push_subscriptions for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "users add their push subscriptions"
  on public.push_subscriptions for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "users update their push subscriptions"
  on public.push_subscriptions for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "users remove their push subscriptions"
  on public.push_subscriptions for delete to authenticated
  using ((select auth.uid()) = user_id);

-- alert_settings : owner only
create policy "users read their alert settings"
  on public.alert_settings for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "users create their alert settings"
  on public.alert_settings for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "users update their alert settings"
  on public.alert_settings for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "users delete their alert settings"
  on public.alert_settings for delete to authenticated
  using ((select auth.uid()) = user_id);

-- alert_log : owner can read, writes are service_role only (no insert/update/delete policy)
create policy "users read their alert log"
  on public.alert_log for select to authenticated
  using ((select auth.uid()) = user_id);

-- test_push_throttle : no policy at all (service_role only).
