-- Backfill the tracked position of the single alerts sent before fix/alerts (entry_price is null),
-- from token_snapshots, so the Alertes screen shows their real outcome instead of the token's current score.
-- Plan: the default +20 % / -20 % rule (the TP1 / invalidation at alert time were not stored).
-- followup_sent_at is set to now(): these alerts are old, no « Objectif atteint » push must be sent late.
-- Rows without a snapshot at alert time are left untouched (they stay plan-less, allowed: constraint NOT VALID).

with legacy as (
  select l.id, l.user_id, l.mint, l.sent_at
  from public.alert_log l
  where l.kind = 'single' and l.entry_price is null
),
entry as (
  select g.id, g.user_id, g.mint, g.sent_at, s.price_usd as entry_price, s.score as entry_score, s.zone_status as entry_zone
  from legacy g
  join lateral (
    select price_usd, score, zone_status
    from public.token_snapshots s
    where s.mint = g.mint and s.captured_at <= g.sent_at and s.captured_at > g.sent_at - interval '10 minutes'
      and s.price_usd > 0
    order by s.captured_at desc
    limit 1
  ) s on true
),
path as (
  select e.*,
    e.entry_price * 1.2 as target_price,
    e.entry_price * 0.8 as stop_price,
    agg.max_price, agg.min_price,
    last.price_usd as last_price, last.captured_at as last_price_at,
    hit.first_hit, hit.first_hit_at
  from entry e
  cross join lateral (
    select max(s.price_usd) as max_price, min(s.price_usd) as min_price
    from public.token_snapshots s
    where s.mint = e.mint and s.captured_at > e.sent_at and s.captured_at <= e.sent_at + interval '7 days' and s.price_usd > 0
  ) agg
  left join lateral (
    select s.price_usd, s.captured_at
    from public.token_snapshots s
    where s.mint = e.mint and s.captured_at > e.sent_at and s.captured_at <= e.sent_at + interval '7 days' and s.price_usd > 0
    order by s.captured_at desc
    limit 1
  ) last on true
  left join lateral (
    select case when s.price_usd >= e.entry_price * 1.2 then 'target' else 'stop' end as first_hit, s.captured_at as first_hit_at
    from public.token_snapshots s
    where s.mint = e.mint and s.captured_at > e.sent_at and s.captured_at <= e.sent_at + interval '7 days'
      and (s.price_usd >= e.entry_price * 1.2 or s.price_usd <= e.entry_price * 0.8)
    order by s.captured_at asc
    limit 1
  ) hit on true
)
update public.alert_log l
set entry_price = p.entry_price,
    target_price = p.target_price,
    stop_price = p.stop_price,
    rr = 1,
    entry_score = p.entry_score,
    entry_zone = p.entry_zone,
    entry_roundtrip_pct = (select t.roundtrip_cost_pct from public.tokens t where t.mint = p.mint),
    stake_sol = coalesce((select a.stake_sol from public.alert_settings a where a.user_id = p.user_id), 0.05),
    max_price = greatest(coalesce(p.max_price, p.entry_price), p.entry_price),
    min_price = least(coalesce(p.min_price, p.entry_price), p.entry_price),
    last_price = coalesce(p.last_price, p.entry_price),
    last_price_at = coalesce(p.last_price_at, p.sent_at),
    first_hit = p.first_hit,
    first_hit_at = p.first_hit_at,
    tracking_until = p.sent_at + interval '7 days',
    followup_sent_at = now()
from path p
where l.id = p.id;
