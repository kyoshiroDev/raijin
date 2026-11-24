# bench-trading (`@raijin/bench-trading`)

SIMULATION (aucun ordre réel) : jobs `paper-engine`, `backtest-run`, `backtest-nightly` (`backtest_enqueue_nightly()`),
signaux SSE `paper.changed` / `backtest.progress`, et les ex-RPC du front en endpoints (SQL d'origine conservé, T5) :
`POST paper/positions` (`paper_open_position`), `POST paper/positions/:id/cancel`, `POST paper/wallets/:book/reset`,
`GET performance/presets|books|breakdown`, `GET lab/backfill` (`backfill_progress`), `POST lab/runs`
(`backtest_request_run`) ; lectures `paper/wallets`, `paper/positions`, `lab/runs`, `lab/runs/:id/results`.
Refus SQL (22xxx, 23xxx, P0xxx) → 422 `PAPER_REJECTED` ; carnet archivé → 422 `PAPER_BOOK_ARCHIVED`.
