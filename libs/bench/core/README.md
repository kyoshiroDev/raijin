# bench-core

Socle de l'API du banc (`apps/raijin-banc-de-test-api`, docs/ARCHITECTURE.md §17). Tags : `scope:bench`,
`type:feature`. Alias : `@raijin/bench-core`. Aucune dépendance vers `scope:api`.

| Dossier | Contenu |
|---|---|
| `config/` | `loadBenchConfig(env)` : validation au démarrage, refus en production si un secret manque ou est factice (noms seulement dans les messages) ; garde-fou `raijin_bench*`, `BULLMQ_PREFIX=raijin-bench` ; variables `BENCH_*` seules transmises à `@raijin/bench-solana` |
| `http/` | `setupBenchApp` (Helmet, `noindex`, `no-store`, CORS des origines du banc, JSON 32 Kio, préfixe `/api`), filtre `{ code, message }`, `BenchZodPipe`, limites par IP (Redis `raijin-bench:`, repli mémoire), décorateurs `@BenchPublic()`, `@BenchSkipCsrf()`, `@BenchLoginThrottle()` |
| `auth/` | compte unique : argon2id + TOTP (ou code de secours) en une étape, verrouillage 5 échecs / 15 min, sessions opaques (HMAC en base, 2 h d'inactivité, 12 h max), cookies `__Host-rjb_session` / `__Host-rjb_csrf`, CSRF double-submit signé et lié à la session, garde globale 401 |
| `jobs/` | `BENCH_JOB_SCHEDULES` (motifs pg_cron, UTC), `BenchJobRegistry` (point d'extension), `BenchJobRunner` (verrou Redis à jeton, `job_runs` running/success/failed/skipped, erreur nettoyée ≤ 500), `BenchJobScheduler` (BullMQ, file `bench-jobs`, préfixe `raijin-bench`) |
| `sse/` | `BenchEventBus` (événements validés par `benchEventSchema`), `GET /api/events?topics=tokens,paper,jobs,backtest` |
| `mode/` | `BenchModeService` (`shadow` / `primary`), `BenchNotifier` : seul passage des push (`@raijin/server-push`) et e-mails, coupés en `shadow` |
| `status/` | `GET /api/health` (public), `GET /api/status` (dépendances, crédits Helius, wallet-study, jobs, taille de base) |
| `cli/` | `create-owner`, `set-password`, `reset-2fa` (alias `enroll-totp`, `reset-totp`) : saisie masquée, rien en argument |

## Brancher un module métier (T7)

```ts
@Module({ providers: [ScanJob] })
export class BenchCollectModule {}

@Injectable()
class ScanJob implements OnModuleInit {
  constructor(private readonly jobs: BenchJobRegistry, private readonly events: BenchEventBus, private readonly mode: BenchModeService, private readonly notifier: BenchNotifier, @Inject(BENCH_SOLANA) private readonly solana: BenchSolana) {}
  onModuleInit(): void {
    this.jobs.register('scan-tokens', async (ctx) => {
      // … collecte ; this.events.publish({ type: 'token.upsert', token }) ;
      // if (this.mode.autoPaperAllowed()) … ; this.notifier.sendPush(…) (rien ne part en mode ombre)
      return { scanned: 0 };
    });
  }
}
```

Seuls les jobs enregistrés sont planifiés ; un job lancé sans traitement est journalisé `skipped` (`not_registered`).
L'e-mail passe par le port `BenchMailSender` : `createBenchMailSender(config.mail)` (Resend ou SMTP selon `BENCH_MAIL_TRANSPORT`, `none` par défaut). Variables des fonctions portées : `legacyEnv(config)` (`JUP_API_KEY` → `BENCH_JUP_API_KEY`…).

## Commandes

```bash
pnpm nx run-many -t lint typecheck test build -p bench-core
pnpm bench:create-owner        # dev : compte sur raijin_bench_dev (même CLI que dans le conteneur)
```
