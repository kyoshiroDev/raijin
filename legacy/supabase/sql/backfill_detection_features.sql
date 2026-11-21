-- feat/calm-sl-test — BACKFILL of signal_outcomes.features (run by hand in the SQL editor AFTER review, once).
-- Writes ONLY values known at the detection (no look-ahead), and only into keys that are null today:
--   migrated_recently  : migratedAtDetection (_shared/features.ts) from the dex at the detection (entry_dex_id, else the
--                        detection scan's snapshot), the mint (pump.fun mints end with « pump ») and the pair age at the
--                        detection (features.log_age_h); pumpfun seen in the snapshots of the 24 h BEFORE the detection
--                        → 1. A PumpSwap pool of a pump.fun mint is its migration pool: pair age < 24 h ⇔ migrated in the
--                        last 24 h. Raydium + pump.fun mint without history stays null (could be a later pool).
--   roundtrip_cost_pct : point-in-time token_snapshots.roundtrip_cost_pct of the detection scan or earlier (the scan
--                        snapshot is written seconds after detected_at: ≤ +60 s, never a later scan). Also entry_roundtrip_pct.
--   lp_locked_pct      : point-in-time token_snapshots.lp_locked_pct, same window.
--   holder_growth_1h/6h: NOT backfilled — no holder snapshot exists before any detection (first sight by definition)
--                        and Jupiter's holderChange was not stored. Left null.
-- Idempotent (only null keys are filled). Dry run: backfill_detection_features_dryrun.sql (same CTE, keep in sync).
-- Prerequisite: migration 20261122010000_calm_sl_test.sql (not required by the SQL itself; pair_age_h follows features).
begin;

with o as (
  select o.mint, o.detected_at, o.features, o.entry_roundtrip_pct,
         coalesce(o.entry_dex_id, (
           select s.dex_id from public.token_snapshots s
            where s.mint = o.mint and s.captured_at between o.detected_at - interval '60 seconds' and o.detected_at + interval '60 seconds'
              and s.dex_id is not null
            order by s.captured_at limit 1)) as dex,
         case when jsonb_typeof(o.features -> 'log_age_h') = 'number'
              then exp(least(greatest((o.features ->> 'log_age_h')::double precision, 0), 12)) - 1 end as age_h
    from public.signal_outcomes o
),
c as (
  select o.*,
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
         (select s.roundtrip_cost_pct from public.token_snapshots s
           where s.mint = o.mint and s.roundtrip_cost_pct is not null
             and s.captured_at between o.detected_at - interval '24 hours' and o.detected_at + interval '60 seconds'
           order by s.captured_at desc limit 1) as rt,
         (select s.lp_locked_pct from public.token_snapshots s
           where s.mint = o.mint and s.lp_locked_pct is not null
             and s.captured_at between o.detected_at - interval '24 hours' and o.detected_at + interval '60 seconds'
           order by s.captured_at desc limit 1) as lp
    from o
),
patch as (
  select c.mint,
         jsonb_strip_nulls(jsonb_build_object(
           'migrated_recently', case when c.features ->> 'migrated_recently' is null and c.mig is not null
                                     then case when c.mig then 1 else 0 end end,
           -- same clamps as features.ts FEATURE_CLAMPS
           'roundtrip_cost_pct', case when c.features ->> 'roundtrip_cost_pct' is null and c.rt is not null
                                      then least(greatest(c.rt, 0), 100) end,
           'lp_locked_pct', case when c.features ->> 'lp_locked_pct' is null and c.lp is not null
                                 then least(greatest(c.lp, 0), 100) end
         )) as add,
         case when c.entry_roundtrip_pct is null and c.rt is not null and c.rt between -100 and 100 then c.rt end as entry_rt
    from c
)
update public.signal_outcomes so
   set features = so.features || p.add,
       entry_roundtrip_pct = coalesce(so.entry_roundtrip_pct, p.entry_rt)
  from patch p
 where so.mint = p.mint
   and (p.add <> '{}'::jsonb or p.entry_rt is not null);

select count(*) filter (where features ->> 'migrated_recently' is not null) as migrated_recently,
       count(*) filter (where features ->> 'roundtrip_cost_pct' is not null) as roundtrip_cost_pct,
       count(*) filter (where features ->> 'lp_locked_pct' is not null) as lp_locked_pct,
       count(*) filter (where features ->> 'holder_growth_1h' is not null) as holder_growth_1h,
       count(*) as total
  from public.signal_outcomes;

commit;
