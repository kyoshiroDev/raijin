-- fix/measurement-and-criteria — « Performance » aggregates in one call.
-- public.performance_breakdown() returns, per source and per dimension bucket, the counts of LABELLED rows:
--   source    : 'scan' (signal_outcomes), 'radar' (early_outcomes), 'preset:momentum' / 'preset:strict' (preset_signals)
--   dimension : 'all' (bucket 'all'); 'dex' (pumpswap / pumpfun / raydium / meteora / orca / other, from entry_dex_id;
--               scan rows without one fall back to tokens.dex_id); 'mc' ('<50k', '50k-100k', '100k-1M', '>1M' from
--               entry_mc); 'zone' (entry_zone; radar rows have none → skipped); 'liq' ('<10k', '10k-20k', '20k-50k',
--               '>=50k' from entry_liq_eff). A null value skips that dimension for the row (no 'unknown' bucket).
--   labelled  : max_multiple_7d > 0 and (x2_before_sl30 or sl30_before_x2 or observed_hours >= 12).
-- Security: security invoker (reads the outcome tables, all already SELECT-able by authenticated through RLS; only
-- aggregates leave), search_path = '' (every object schema-qualified), stable, no argument. EXECUTE revoked from
-- public / anon and granted to authenticated only.
--
-- Sanity check (SQL editor, as postgres): for every source, the 'all' row equals the sum of the 'mc' buckets plus the
-- rows with a null entry_mc, e.g.
--   with b as (select * from public.performance_breakdown())
--   select a.source, a.n as n_all, (select coalesce(sum(n), 0) from b where b.source = a.source and b.dimension = 'dex') as n_dex
--     from b a where a.dimension = 'all';
--   -- n_dex must equal n_all for 'scan' / 'radar' / 'preset:*' (every row has a dex bucket, 'other' included, unless
--   -- both entry_dex_id and tokens.dex_id are null); x2_before_sl30 + sl30_before_x2 <= n on every row.

create or replace function public.performance_breakdown()
returns table (
  source               text,
  dimension            text,
  bucket               text,
  n                    integer,
  n_final              integer,
  x2                   integer,
  x3                   integer,
  x2_before_sl30       integer,
  sl30_before_x2       integer,
  dd50_first           integer,
  median_max_multiple  numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with base as (
    select 'scan'::text as src, coalesce(o.entry_dex_id, t.dex_id) as dex, o.entry_mc as mc, o.entry_zone as zone,
           o.entry_liq_eff as liq, o.status, o.hit_x2, o.hit_x3, o.x2_before_sl30, o.sl30_before_x2, o.dd50_first,
           o.max_multiple_7d, o.observed_hours
      from public.signal_outcomes o
      left join public.tokens t on t.mint = o.mint
    union all
    select 'radar', e.entry_dex_id, e.entry_mc, null::text, null::numeric, e.status, e.hit_x2, e.hit_x3,
           e.x2_before_sl30, e.sl30_before_x2, e.dd50_first, e.max_multiple_7d, e.observed_hours
      from public.early_outcomes e
    union all
    select 'preset:' || p.preset, p.entry_dex_id, p.entry_mc, p.entry_zone, p.entry_liq_eff, p.status, p.hit_x2,
           p.hit_x3, p.x2_before_sl30, p.sl30_before_x2, p.dd50_first, p.max_multiple_7d, p.observed_hours
      from public.preset_signals p
  ),
  labelled as (
    select b.*
      from base b
     where b.max_multiple_7d > 0
       and (b.x2_before_sl30 is true or b.sl30_before_x2 is true or b.observed_hours >= 12)
  ),
  dims as (
    select l.*, d.dimension, d.bucket
      from labelled l
     cross join lateral (values
       ('all', 'all'),
       ('dex', case
                 when l.dex is null then null
                 when l.dex = 'pumpswap' then 'pumpswap'
                 when l.dex = 'pumpfun' then 'pumpfun'
                 when l.dex like 'raydium%' then 'raydium'
                 when l.dex like 'meteora%' then 'meteora'
                 when l.dex like 'orca%' then 'orca'
                 else 'other'
               end),
       ('mc', case
                when l.mc is null then null
                when l.mc < 50000 then '<50k'
                when l.mc < 100000 then '50k-100k'
                when l.mc <= 1000000 then '100k-1M'
                else '>1M'
              end),
       ('zone', l.zone),
       ('liq', case
                 when l.liq is null then null
                 when l.liq < 10000 then '<10k'
                 when l.liq < 20000 then '10k-20k'
                 when l.liq < 50000 then '20k-50k'
                 else '>=50k'
               end)
     ) as d(dimension, bucket)
     where d.bucket is not null
  )
  select src,
         dims.dimension,
         dims.bucket,
         count(*)::integer,
         count(*) filter (where dims.status = 'final')::integer,
         count(*) filter (where dims.hit_x2 is true)::integer,
         count(*) filter (where dims.hit_x3 is true)::integer,
         count(*) filter (where dims.x2_before_sl30 is true)::integer,
         count(*) filter (where dims.sl30_before_x2 is true)::integer,
         count(*) filter (where dims.dd50_first is true)::integer,
         round((percentile_cont(0.5) within group (order by dims.max_multiple_7d::double precision))::numeric, 4)
    from dims
   group by src, dims.dimension, dims.bucket
   order by src, dims.dimension, dims.bucket;
$$;

comment on function public.performance_breakdown() is
  'Performance aggregates of labelled outcomes per source (scan / radar / preset:*) and dimension (all / dex / mc / zone / liq).';

revoke execute on function public.performance_breakdown() from public, anon;
grant execute on function public.performance_breakdown() to authenticated;
