# bench-contracts (`@raijin/bench-contracts`)

Contrats Zod de l'API du banc (`apps/raijin-banc-de-test-api`) et de son front
(`apps/raijin-banc-de-test`) : authentification privée (mot de passe + TOTP), `job_runs`, événements
SSE, endpoints repris des RPC et des lectures Supabase, comparaison du mode ombre, santé et stockage.
Types obtenus par `z.infer` : aucun type dupliqué entre le front et l'API du banc.

Tags `scope:bench`, `type:contracts` : aucun projet Raijin ne l'importe. TypeScript pur (ni Node ni Deno).
Décisions : `docs/ARCHITECTURE.md` §17.

`pnpm nx run-many -t lint typecheck test build -p bench-contracts`
