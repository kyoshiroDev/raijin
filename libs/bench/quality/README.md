# bench-quality (`@raijin/bench-quality`)

Mesure du RISQUE (ARCHITECTURE §16, phase 7 bis branchée) et entretien de `raijin_bench` :

| Job | Motif (UTC) | Rôle |
|---|---|---|
| `verdict-follow-up` | `*/15 * * * *` | verdict du moteur **publié** (`evaluateRisk`) sur les nouvelles détections (`signal_outcomes`, ≤ `BENCH_VERDICTS_PER_RUN`), puis relève 24 h / 72 h / 7 j (DexScreener + offre brute `api-solana`), observation classée hors fenêtre écartée |
| `verdict-aggregate` | `5 3 * * *` | `daily_verdict_metrics` (10 derniers jours) + rejeu des variantes `engine_variants.enabled` → `variant_replays` |
| `retention-purge` | `15 3 * * *` | SQL des 5 purges pg_cron à l'identique, puis verdicts (365 j) et `job_runs` (30 j) |
| `storage-check` | `0 * * * *` | `pg_database_size` vs `BENCH_DB_ALLOCATED_BYTES`, alerte e-mail + push seulement à la hausse (80 % / 95 %), rien en mode ombre |

Endpoints : `GET /api/verdicts/quality` (`QualityReport` réel : n, période, Wilson 95 %, « échantillon insuffisant »
sous 30, découpage chronologique) et `GET /api/shadow/comparison` (`public` vs `shadow_ref`, par table et par jour).
Une variante ne remonte jamais dans Raijin depuis le banc (PR sur `DEFAULT_RISK_ENGINE_CONFIG` seulement).
