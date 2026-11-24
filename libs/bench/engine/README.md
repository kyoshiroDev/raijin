# bench-engine (`@raijin/bench-engine`)

Port Node des Edge Functions de l'ancien banc (docs/BENCH.md §2). Tags `scope:bench`, `type:util`. Aucun Nest.

| Dossier | Contenu |
|---|---|
| `ported/` | `legacy/supabase/functions/_shared` **à l'identique** (imports sans `.ts`, `npm:zod` → `zod/v3`), plus `runtime-fetch.ts` (sortie HTTP du processus : `fetch` à recul sur 429 de `@raijin/bench-solana`) et `push-endpoint.ts` (liste blanche extraite de `webpush.ts`, le chiffrement VAPID passe par `@raijin/server-push`). Retirés : `cors.ts`, `webpush.ts`. Les `!` et `obj['clé']` viennent d'un codemod **purement typé** (`noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`) : aucun calcul changé (BENCH.md §9 P11). |
| `functions/` | corps des 7 fonctions (`runScanTokens`, `runEnrichTokens`, `runLabelOutcomes`, `runPaperEngine`, `runBacktestRun`, `runWalletStudyCollect` ; `send-test-push` → `POST /api/push/test` de `bench-collect`). Seules différences : plus de `x-cron-secret`, `Response.json(x)` → `return x`, réponse 500 → exception (`job_runs` en échec), `Deno.env` → `env` (`BENCH_*`), push par `ScanRuntime.push` (null en mode ombre), auto-paper derrière `autoPaperAllowed()`, Helius de wallet-study par `WalletHistoryPort` (plafond journalier). |
| `db/` | `BenchDb` : client compatible `supabase-js` (même interface fluide, mêmes `{ data, error, count }`), `QuerySpec` exécuté en SQL (`compileQuery` / `compileRpc` façon PostgREST : `json_agg`, `json_populate_recordset`, plafond `max-rows` 1 000) ou en mémoire (`MemoryDbExecutor`, tests). |

Tests : les 36 fichiers `*_test.ts` d'origine tournent sous Jest **sans modification d'assertion** (`node:test` →
`src/testing/node-test-shim.ts`), plus un test par fonction portée sur réponses d'API enregistrées
(`ported/test-support`) et base en mémoire ; le `fetch` global est bloqué. `pnpm nx run-many -t lint typecheck test build -p bench-engine`
