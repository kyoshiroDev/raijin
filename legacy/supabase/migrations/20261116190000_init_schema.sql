-- Raijin — initial schema
-- Every table has RLS. anon has no access. Scanner tables are written by service_role only.

-- ---------------------------------------------------------------------------
-- tokens : latest state of each tracked token
-- ---------------------------------------------------------------------------
create table public.tokens (
  mint                      text primary key
                            check (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  symbol                    text not null check (char_length(symbol) between 1 and 32),
  name                      text not null default '' check (char_length(name) <= 64),
  pair_address              text not null check (pair_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  dex_id                    text not null default '' check (char_length(dex_id) <= 32),
  image_url                 text check (image_url is null or (image_url like 'https://%' and char_length(image_url) <= 500)),
  website_url               text check (website_url is null or (website_url like 'https://%' and char_length(website_url) <= 500)),
  x_url                     text check (x_url is null or (x_url like 'https://%' and char_length(x_url) <= 500)),
  telegram_url              text check (telegram_url is null or (telegram_url like 'https://%' and char_length(telegram_url) <= 500)),

  price_usd                 numeric not null check (price_usd >= 0),
  market_cap                numeric not null check (market_cap >= 0),
  liquidity_usd             numeric not null check (liquidity_usd >= 0),
  volume_24h                numeric not null check (volume_24h >= 0),
  change_5m                 numeric not null default 0,
  change_1h                 numeric not null default 0,
  change_6h                 numeric not null default 0,
  change_24h                numeric not null default 0,
  buys_1h                   integer not null default 0 check (buys_1h >= 0),
  sells_1h                  integer not null default 0 check (sells_1h >= 0),
  buys_24h                  integer not null default 0 check (buys_24h >= 0),
  sells_24h                 integer not null default 0 check (sells_24h >= 0),
  pair_created_at           timestamptz,

  score                     smallint not null check (score between 0 and 100),
  flags                     text[] not null default '{}' check (cardinality(flags) <= 12),

  zone_status               text not null default 'none'
                            check (zone_status in ('in', 'wait', 'deep', 'broken', 'none')),
  zone_source               text not null default 'approx' check (zone_source in ('candles', 'approx')),
  swing_low                 numeric check (swing_low >= 0),
  swing_high                numeric check (swing_high >= 0),
  zone_low                  numeric check (zone_low >= 0),   -- 0.618
  zone_high                 numeric check (zone_high >= 0),  -- 0.5
  invalidation              numeric check (invalidation >= 0),
  tp1                       numeric check (tp1 >= 0),
  tp2                       numeric check (tp2 >= 0),

  mint_authority_disabled   boolean,
  freeze_authority_disabled boolean,
  top10_pct                 numeric check (top10_pct between 0 and 100),
  holder_count              integer check (holder_count >= 0),
  organic_score             numeric check (organic_score between 0 and 100),

  first_seen_at             timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index tokens_score_idx       on public.tokens (score desc);
create index tokens_updated_at_idx  on public.tokens (updated_at desc);
create index tokens_zone_status_idx on public.tokens (zone_status);

-- ---------------------------------------------------------------------------
-- token_snapshots : history used to measure whether the score predicts moves
-- ---------------------------------------------------------------------------
create table public.token_snapshots (
  id             bigint generated always as identity primary key,
  mint           text not null references public.tokens (mint) on delete cascade,
  captured_at    timestamptz not null default now(),
  price_usd      numeric not null check (price_usd >= 0),
  market_cap     numeric not null check (market_cap >= 0),
  liquidity_usd  numeric not null check (liquidity_usd >= 0),
  volume_24h     numeric not null check (volume_24h >= 0),
  score          smallint not null check (score between 0 and 100),
  zone_status    text not null check (zone_status in ('in', 'wait', 'deep', 'broken', 'none'))
);

create index token_snapshots_mint_time_idx on public.token_snapshots (mint, captured_at desc);
create index token_snapshots_time_idx      on public.token_snapshots (captured_at);

-- ---------------------------------------------------------------------------
-- scan_runs : one row per scan
-- ---------------------------------------------------------------------------
create table public.scan_runs (
  id            bigint generated always as identity primary key,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  tokens_seen   integer not null default 0,
  tokens_kept   integer not null default 0,
  error         text check (char_length(error) <= 1000)
);

create index scan_runs_started_at_idx on public.scan_runs (started_at desc);

-- ---------------------------------------------------------------------------
-- watchlist : per-user
-- ---------------------------------------------------------------------------
create table public.watchlist (
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  mint        text not null references public.tokens (mint) on delete cascade,
  note        text check (char_length(note) <= 280),
  created_at  timestamptz not null default now(),
  primary key (user_id, mint)
);

-- ---------------------------------------------------------------------------
-- Privileges (defense in depth, on top of RLS)
-- ---------------------------------------------------------------------------
revoke all on public.tokens, public.token_snapshots, public.scan_runs, public.watchlist from anon;
revoke insert, update, delete, truncate on public.tokens, public.token_snapshots, public.scan_runs from authenticated;
grant select on public.tokens, public.token_snapshots, public.scan_runs to authenticated;
grant select, insert, update, delete on public.watchlist to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.tokens          enable row level security;
alter table public.token_snapshots enable row level security;
alter table public.scan_runs       enable row level security;
alter table public.watchlist       enable row level security;

create policy "tokens are readable by signed-in users"
  on public.tokens for select to authenticated using (true);

create policy "snapshots are readable by signed-in users"
  on public.token_snapshots for select to authenticated using (true);

create policy "scan runs are readable by signed-in users"
  on public.scan_runs for select to authenticated using (true);

create policy "users read their watchlist"
  on public.watchlist for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "users add to their watchlist"
  on public.watchlist for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "users update their watchlist"
  on public.watchlist for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "users remove from their watchlist"
  on public.watchlist for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Realtime : push token updates to the app (RLS still applies)
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.tokens;
