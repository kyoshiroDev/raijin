-- feat/calm-sl-test — DRY RUN (read-only) of backfill_detection_features.sql: how many signal_outcomes rows would get
-- each feature, from values KNOWN AT THE DETECTION only. Safe to run anytime:
--   npx supabase db query --remote --read-only -f supabase/sql/backfill_detection_features_dryrun.sql
-- Same CTE as the apply script (keep both in sync).
with o as (
  select o.mint, o.detected_at, o.features, o.entry_roundtrip_pct,
         -- dex at the detection: entry_dex_id, else the snapshot of the detection scan (backfill rows: their first snapshot)
         coalesce(o.entry_dex_id, (
           select s.dex_id from public.token_snapshots s
            where s.mint = o.mint and s.captured_at between o.detected_at - interval '60 seconds' and o.detected_at + interval '60 seconds'
              and s.dex_id is not null
            order by s.captured_at limit 1)) as dex,
         -- pair age at the detection from features.log_age_h (clamped 0–12 by features.ts)
         case when jsonb_typeof(o.features -> 'log_age_h') = 'number'
              then exp(least(greatest((o.features ->> 'log_age_h')::double precision, 0), 12)) - 1 end as age_h
    from public.signal_outcomes o
),
c as (
  select o.*,
         -- migratedAtDetection (features.ts), history = snapshots in the 24 h BEFORE the detection
         case
           when o.dex is null or o.dex = '' then null
           when lower(o.dex) <> 'pumpswap' and lower(o.dex) not like '%raydium%' then false
           when exists (select 1 from public.token_snapshots s
                         where s.mint = o.mint and s.dex_id = 'pumpfun'
                           and s.captured_at >= o.detected_at - interval '24 hours' and s.captured_at < o.detected_at) then true
           when o.mint not like '%pump' then false
           when lower(o.dex) = 'pumpswap' then case when o.age_h is null then null else o.age_h < 24 end
           when exists (select 1 from public.token_snapshots s
                         where s.mint = o.mint and s.captured_at >= o.detected_at - interval '24 hours' and s.captured_at < o.detected_at) then false
           else null
         end as mig,
         -- round trip / LP: point-in-time snapshot columns of the detection scan or earlier (never a later scan)
         (select s.roundtrip_cost_pct from public.token_snapshots s
           where s.mint = o.mint and s.roundtrip_cost_pct is not null
             and s.captured_at between o.detected_at - interval '24 hours' and o.detected_at + interval '60 seconds'
           order by s.captured_at desc limit 1) as rt,
         (select s.lp_locked_pct from public.token_snapshots s
           where s.mint = o.mint and s.lp_locked_pct is not null
             and s.captured_at between o.detected_at - interval '24 hours' and o.detected_at + interval '60 seconds'
           order by s.captured_at desc limit 1) as lp
    from o
)
select count(*) as rows_total,
       count(*) filter (where c.features ->> 'migrated_recently' is null and c.mig is not null) as migrated_recently,
       count(*) filter (where c.features ->> 'migrated_recently' is null and c.mig is true) as migrated_recently_true,
       count(*) filter (where c.features ->> 'migrated_recently' is null and c.mig is false) as migrated_recently_false,
       count(*) filter (where c.features ->> 'migrated_recently' is null and c.mig is null) as migrated_recently_left_null,
       count(*) filter (where c.features ->> 'roundtrip_cost_pct' is null and c.rt is not null) as roundtrip_cost_pct,
       count(*) filter (where c.features ->> 'lp_locked_pct' is null and c.lp is not null) as lp_locked_pct,
       0 as holder_growth_1h,  -- no holder snapshot before any detection (first sight), no stored Jupiter holderChange
       0 as holder_growth_6h
  from c;
