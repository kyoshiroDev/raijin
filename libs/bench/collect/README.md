# bench-collect (`@raijin/bench-collect`)

Collecte du banc (docs/BENCH.md §2) : jobs `scan-tokens`, `enrich-tokens`, `label-outcomes`, `wallet-study-collect`
(corps : `@raijin/bench-engine`, base : `BenchSqlService`), diffusion SSE `token.upsert`, et lectures du front :
`tokens`, `tokens/briefs`, `tokens/:mint`, `tokens/:mint/snapshots`, `market/rates`, `alerts`, `settings/alerts[/enabled]`,
`settings/preferences`, `push/vapid-public-key`, `push/subscriptions`, `push/unsubscribe`, `push/test` (ex-`send-test-push`,
1 / min, 409 `BENCH_SHADOW_MODE` en mode ombre). Tags `scope:bench`, `type:feature`.
