-- Raijin — 6-hour price sparkline per token for the cards (feat/visual-cards-chart).
--
-- tokens.spark_6h: last price per 15-min bucket over the last 6 h (oldest first, gaps forward-filled, leading empty
-- buckets dropped, 6 significant digits), written by scan-tokens from the snapshot history it already loads
-- (x3_snapshot_history) plus the current price. null = not enough history (< 4 points) or never computed. The front
-- reads this single column instead of hundreds of token_snapshots rows per token.
--
-- Security
--   No new table, no new function. RLS stays enabled on public.tokens; policies unchanged (SELECT for authenticated,
--   no insert/update/delete policy: writes are service_role only). `grant select on public.tokens to authenticated`
--   is table-level, so the new column is readable without a grant change. anon has nothing.
-- Bounds: 1–48 values, one dimension, no null element, 0 < value < 1e12 (compared as real: 1e12 itself rounds to
-- 999999995904 in real, so the bound is cast too). `1e12::real > all(...)` also rejects 'NaN'
-- (NaN sorts above every number in Postgres) and 'Infinity'. A null element makes `> all` null (passes a CHECK),
-- hence the explicit array_position test.

alter table public.tokens
  add column spark_6h real[]
    constraint tokens_spark_6h_check check (
      spark_6h is null
      or (
        array_ndims(spark_6h) = 1
        and cardinality(spark_6h) between 1 and 48
        and array_position(spark_6h, null) is null
        and 0 < all (spark_6h)
        and 1e12::real > all (spark_6h)
      )
    );

comment on column public.tokens.spark_6h is
  '6 h price sparkline (USD, oldest first): last price per 15-min bucket, forward-filled, <= 48 values. Written by scan-tokens; null = not enough history.';
