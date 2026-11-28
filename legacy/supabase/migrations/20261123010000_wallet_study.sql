-- feat/wallet-study — OFFLINE STUDY of the early buyers of the labelled tokens. No alert, no trading, no wallet
-- connection, no key stored anywhere in the database (the Helius key is the Edge Function secret HELIUS_API_KEY).
-- No applied migration is modified; nothing is dropped.
--
-- What is added
--   wallet_study_state  : one row per studied mint (copied from signal_outcomes when picked): collection status,
--                         GTFA pagination cursor (resume across calls), pages read, buyers kept, token creator / pool
--                         creator (excluded from the buyers), credits spent, attempts, last error (secret-free text).
--   early_buyers        : the first 50 DISTINCT buyers per mint (wallet, time, SOL paid, rank 1–50, slot, signature).
--                         The « wallet present in > 30 % of the tokens » exclusion is computed at ANALYSIS time
--                         (scanner-quant): denominator = wallet_study_state rows with status in
--                         ('done', 'exhausted', 'capped').
--   wallet_study_budget : singleton global credit counter, HARD CAP 600 000 credits (a CHECK makes any overrun
--                         impossible), plus a lease so two overlapping cron calls never spend in parallel.
--   wallet_study_reserve(mint, credits) : atomically reserves credits BEFORE each Helius request (false = cap reached,
--                         the function stops). wallet_study_refund(mint, credits) : gives back the reservation of a
--                         request Helius answered with an error (free), never below 0.
--   wallet_study_claim(lease_s) → uuid token (null = busy) / wallet_study_release(token) : lease with an owner token, a
--                         call can only release the lease it holds (security review L1).
--   wallet_study_queue(limit) : mints to work on, in-progress first, then labelled signal_outcomes rows (status final
--                         or x2_before_sl30 known) never studied, oldest detection first.
--
-- Security
--   RLS enabled on the three tables; SELECT for authenticated only; no write policy (writes = service_role, which
--   bypasses RLS); anon gets nothing. Privileges revoked from anon / authenticated first, then SELECT granted to
--   authenticated. Functions: security invoker, search_path = '', EXECUTE revoked from public / anon / authenticated
--   and granted to service_role only. No FK to tokens: the study must survive a purge of tokens.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.wallet_study_state (
  mint            text primary key check (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  pair_address    text not null check (pair_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  pair_created_at timestamptz,
  detected_at     timestamptz not null,
  status          text not null default 'pending'
                  check (status in ('pending', 'done', 'exhausted', 'capped', 'failed')),
  cursor          text check (cursor is null or cursor ~ '^[0-9]{1,20}:[0-9]{1,10}$'),
  pages           smallint not null default 0 check (pages between 0 and 1000),
  buyers          smallint not null default 0 check (buyers between 0 and 50),
  creator         text check (creator is null or creator ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  creator_checked boolean not null default false,
  pool_creator    text check (pool_creator is null or pool_creator ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  credits_used    integer not null default 0 check (credits_used between 0 and 600000),
  dropped_txs     integer not null default 0 check (dropped_txs between 0 and 1000000),
  attempts        smallint not null default 0 check (attempts between 0 and 100),
  error           text check (error is null or char_length(error) <= 200),
  started_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  finished_at     timestamptz,
  constraint wallet_study_state_finished check ((status = 'pending') = (finished_at is null))
);

comment on table public.wallet_study_state is
  'feat/wallet-study (offline study): early-buyer collection progress per labelled mint. done = 50 buyers, exhausted = pool history ended first, capped = page limit reached, failed = 3 failed attempts.';
comment on column public.wallet_study_state.creator is 'Fee payer of the first transaction of the mint (token creator), excluded from the buyers.';
comment on column public.wallet_study_state.pool_creator is 'Fee payer of the first transaction of the pool (pool creator / migration account), excluded from the buyers.';

create index wallet_study_state_status_idx on public.wallet_study_state (status, detected_at);

create table public.early_buyers (
  mint        text not null references public.wallet_study_state (mint) on delete cascade
              check (mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  wallet      text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  ts          timestamptz,
  sol_amount  numeric check (sol_amount is null or (sol_amount >= 0 and sol_amount < 1e9)),
  rank        smallint not null check (rank between 1 and 50),
  slot        bigint not null check (slot >= 0),
  signature   text not null check (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,90}$'),
  created_at  timestamptz not null default now(),
  primary key (mint, wallet),
  constraint early_buyers_mint_rank_key unique (mint, rank)
);

comment on table public.early_buyers is
  'feat/wallet-study (offline study): first 50 distinct buyers per mint from the pool history (Helius getTransactionsForAddress). sol_amount = WSOL received by the other side of the swap (null for non-SOL quotes).';

-- Cross-token wallet frequency (> 30 % exclusion, analysis time).
create index early_buyers_wallet_idx on public.early_buyers (wallet);

create table public.wallet_study_budget (
  id            smallint primary key default 1 check (id = 1),
  credits_used  integer not null default 0 check (credits_used >= 0 and credits_used <= hard_cap),
  hard_cap      integer not null default 600000 check (hard_cap between 0 and 600000),
  lease_until   timestamptz,
  lease_token   uuid,
  updated_at    timestamptz not null default now()
);

comment on table public.wallet_study_budget is
  'feat/wallet-study: global Helius credit counter (credits reserved before each request; a failed request is free on Helius but stays counted: conservative). HARD STOP at hard_cap (<= 600 000).';

insert into public.wallet_study_budget (id) values (1);

-- ---------------------------------------------------------------------------
-- 2. Functions (service_role only)
-- ---------------------------------------------------------------------------
create or replace function public.wallet_study_reserve(p_mint text, p_credits integer)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ok boolean;
begin
  if p_credits is null or p_credits < 0 or p_credits > 10000 then
    raise exception 'invalid credit amount';
  end if;
  update public.wallet_study_budget
     set credits_used = credits_used + p_credits, updated_at = now()
   where id = 1 and credits_used + p_credits <= hard_cap
  returning true into v_ok;
  if v_ok is not true then
    return false;
  end if;
  update public.wallet_study_state
     set credits_used = least(credits_used + p_credits, 600000), updated_at = now()
   where mint = p_mint;
  return true;
end;
$$;

create or replace function public.wallet_study_refund(p_mint text, p_credits integer)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_credits is null or p_credits < 0 or p_credits > 10000 then
    raise exception 'invalid credit amount';
  end if;
  update public.wallet_study_budget
     set credits_used = greatest(credits_used - p_credits, 0), updated_at = now()
   where id = 1;
  update public.wallet_study_state
     set credits_used = greatest(credits_used - p_credits, 0), updated_at = now()
   where mint = p_mint;
end;
$$;

-- Returns the owner token of the new lease, or null when a live lease is held by another call.
create or replace function public.wallet_study_claim(p_lease_seconds integer)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_token uuid := gen_random_uuid();
  v_ok    boolean;
begin
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 300 then
    raise exception 'invalid lease';
  end if;
  update public.wallet_study_budget
     set lease_until = now() + make_interval(secs => p_lease_seconds), lease_token = v_token, updated_at = now()
   where id = 1 and (lease_until is null or lease_until < now())
  returning true into v_ok;
  return case when v_ok then v_token else null end;
end;
$$;

-- Clears the lease only when p_token still owns it (a late call cannot free the lease of the next one).
create or replace function public.wallet_study_release(p_token uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ok boolean;
begin
  update public.wallet_study_budget
     set lease_until = null, lease_token = null, updated_at = now()
   where id = 1 and p_token is not null and lease_token = p_token
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

create or replace function public.wallet_study_queue(p_limit integer)
returns table (
  mint            text,
  pair_address    text,
  pair_created_at timestamptz,
  detected_at     timestamptz,
  is_new          boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  (select s.mint, s.pair_address, s.pair_created_at, s.detected_at, false
     from public.wallet_study_state s
    where s.status = 'pending'
    order by s.detected_at
    limit greatest(1, least(p_limit, 50)))
  union all
  (select o.mint, o.pair_address, t.pair_created_at, o.detected_at, true
     from public.signal_outcomes o
     left join public.tokens t on t.mint = o.mint
    where (o.status = 'final' or o.x2_before_sl30 is not null)
      and not exists (select 1 from public.wallet_study_state s where s.mint = o.mint)
    order by o.detected_at
    limit greatest(1, least(p_limit, 50)))
$$;

-- ---------------------------------------------------------------------------
-- 3. Privileges and RLS
-- ---------------------------------------------------------------------------
revoke all on public.wallet_study_state, public.early_buyers, public.wallet_study_budget from anon, authenticated;
grant select on public.wallet_study_state, public.early_buyers, public.wallet_study_budget to authenticated;

alter table public.wallet_study_state  enable row level security;
alter table public.early_buyers        enable row level security;
alter table public.wallet_study_budget enable row level security;

create policy "wallet study state is readable by signed-in users"
  on public.wallet_study_state for select to authenticated using (true);
create policy "early buyers are readable by signed-in users"
  on public.early_buyers for select to authenticated using (true);
create policy "wallet study budget is readable by signed-in users"
  on public.wallet_study_budget for select to authenticated using (true);

revoke execute on function public.wallet_study_reserve(text, integer) from public, anon, authenticated;
revoke execute on function public.wallet_study_claim(integer) from public, anon, authenticated;
revoke execute on function public.wallet_study_release(uuid) from public, anon, authenticated;
revoke execute on function public.wallet_study_refund(text, integer) from public, anon, authenticated;
revoke execute on function public.wallet_study_queue(integer) from public, anon, authenticated;
grant execute on function public.wallet_study_reserve(text, integer) to service_role;
grant execute on function public.wallet_study_claim(integer) to service_role;
grant execute on function public.wallet_study_release(uuid) to service_role;
grant execute on function public.wallet_study_refund(text, integer) to service_role;
grant execute on function public.wallet_study_queue(integer) to service_role;
