-- fix/label-checkpoints — label-outcomes checkpoints.
-- GeckoTerminal allows only ~3–5 requests per run from the Edge IP, so re-labelling every pending row round-robin
-- wasted calls. Each label row now carries next_label_at, the moment it is worth labelling again:
--   * detection + 12 h  (first look, set on insert by the trigger below),
--   * detection + 7 days (the horizon: the label can then become final),
--   * now + 6 h after a fetch failure, or when a row past the horizon is still pending (no candle yet),
--   * null once final.
-- The values after a label are computed by nextLabelAt() (_shared/label-queue.ts); the queue reads pending rows with
-- next_label_at <= now(), oldest checkpoint first. Columns inherit the table grants (SELECT for authenticated, writes
-- service_role only); RLS is unchanged.

alter table public.signal_outcomes add column next_label_at timestamptz;
alter table public.early_outcomes  add column next_label_at timestamptz;
alter table public.preset_signals  add column next_label_at timestamptz;

comment on column public.signal_outcomes.next_label_at is 'label-outcomes checkpoint: next useful label time (null = final).';
comment on column public.early_outcomes.next_label_at  is 'label-outcomes checkpoint: next useful label time (null = final).';
comment on column public.preset_signals.next_label_at  is 'label-outcomes checkpoint: next useful label time (null = final).';

-- First checkpoint on insert (the inserters do not need to know about it). Runs as the caller (service_role).
create function public.set_first_label_checkpoint()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.next_label_at := coalesce(new.next_label_at, new.detected_at + interval '12 hours');
  return new;
end;
$$;

revoke execute on function public.set_first_label_checkpoint() from public, anon, authenticated;

create trigger signal_outcomes_first_label_checkpoint
  before insert on public.signal_outcomes
  for each row execute function public.set_first_label_checkpoint();
create trigger early_outcomes_first_label_checkpoint
  before insert on public.early_outcomes
  for each row execute function public.set_first_label_checkpoint();
create trigger preset_signals_first_label_checkpoint
  before insert on public.preset_signals
  for each row execute function public.set_first_label_checkpoint();

-- Backfill of the existing rows (same rules as nextLabelAt()).
update public.signal_outcomes set next_label_at = case
  when status = 'final' then null
  when labelled_at >= detected_at + interval '12 hours' and detected_at + interval '7 days' > now()
    then detected_at + interval '7 days'
  when detected_at + interval '7 days' <= now() and labelled_at >= detected_at + interval '7 days'
    then labelled_at + interval '6 hours'
  else detected_at + interval '12 hours'
end;

update public.early_outcomes set next_label_at = case
  when status = 'final' then null
  when labelled_at >= detected_at + interval '12 hours' and detected_at + interval '7 days' > now()
    then detected_at + interval '7 days'
  when detected_at + interval '7 days' <= now() and labelled_at >= detected_at + interval '7 days'
    then labelled_at + interval '6 hours'
  else detected_at + interval '12 hours'
end;

update public.preset_signals set next_label_at = case
  when status = 'final' then null
  when labelled_at >= detected_at + interval '12 hours' and detected_at + interval '7 days' > now()
    then detected_at + interval '7 days'
  when detected_at + interval '7 days' <= now() and labelled_at >= detected_at + interval '7 days'
    then labelled_at + interval '6 hours'
  else detected_at + interval '12 hours'
end;

-- label-outcomes queue: due pending rows, oldest checkpoint first.
create index signal_outcomes_next_label_idx on public.signal_outcomes (next_label_at) where status = 'pending';
create index early_outcomes_next_label_idx  on public.early_outcomes  (next_label_at) where status = 'pending';
create index preset_signals_next_label_idx  on public.preset_signals  (next_label_at) where status = 'pending';
