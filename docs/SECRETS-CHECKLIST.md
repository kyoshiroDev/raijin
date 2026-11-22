# SECRETS-CHECKLIST — Raijin Shield

Claude Code ne copie jamais une clé secrète. **C'est toi qui copies chaque valeur** dans ton `.env` local
(à partir du modèle de `docs/ENV.md`), puis dans le `.env` du VPS au déploiement. Coche la case quand c'est fait.
Les noms de variables suivent `docs/ENV.md`.

## Services en ligne

| Variable | Service | Page exacte où la trouver | Utilisé par | Copié par l'utilisateur |
|---|---|---|---|---|
| `HELIUS_API_KEY` | Helius | https://dashboard.helius.dev → API Keys → ligne **« raijin-api »** → bouton copier de la colonne « API Key » | apps/api (serveur uniquement) | [ ] |
| `BENCH_HELIUS_API_KEY` (nom proposé, à ajouter à `docs/ENV.md`) | Helius | https://dashboard.helius.dev → API Keys → ligne **« raijin-banc-de-test »** → bouton copier de la colonne « API Key » | apps/raijin-banc-de-test-api (serveur uniquement) | [ ] |
| `RESEND_API_KEY` | Resend | https://resend.com/api-keys — service pas encore créé | apps/api | [ ] |
| `STRIPE_SECRET_KEY` | Stripe (test) | https://dashboard.stripe.com/test/apikeys (« sk_test_… ») — service pas encore créé | apps/api | [ ] |
| `STRIPE_WEBHOOK_SECRET` | Stripe (test) | https://dashboard.stripe.com/test/webhooks → endpoint → secret de signature — service pas encore créé | apps/api | [ ] |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google Cloud | https://console.cloud.google.com/iam-admin/serviceaccounts → compte de service → Clés → JSON — service pas encore créé | apps/api (admin-analytics) | [ ] |
| `SENTRY_DSN_API` / `SENTRY_DSN_WEB` | Sentry | https://sentry.io/settings/projects/ → projet → Client Keys (DSN) — service pas encore créé | apps/api / apps/web | [ ] |

## Secrets générés localement (aucun service)

| Variable | Comment la générer | Utilisé par | Fait |
|---|---|---|---|
| `POSTGRES_PASSWORD` (et `DATABASE_URL`) | `openssl rand -base64 32` | apps/api | [ ] |
| `JWT_ACCESS_SECRET` | `openssl rand -base64 48` | apps/api | [ ] |
| `COOKIE_SECRET` | `openssl rand -base64 32` | apps/api | [ ] |
| `TOTP_ENCRYPTION_KEY` | `openssl rand -base64 32` | apps/api | [ ] |
| `VAPID_PRIVATE_KEY` (+ `VAPID_PUBLIC_KEY`) | `npx web-push generate-vapid-keys` | apps/api | [ ] |

## Notes Helius (non secrètes)
- Plan **Free** : 1 M crédits/mois, RPC 10 req/s, DAS 2 req/s, `getProgramAccounts` 5 req/s, `sendTransaction` 1 req/s (inutile : lecture seule). Pas de crédits additionnels sur ce plan.
- Les deux clés partagent le même projet, donc **le même quota** (1 M crédits, 10 req/s au total) : prévoir le rate limiting en conséquence.
- URL RPC : `https://mainnet.helius-rpc.com/?api-key=<clé>` (la clé passe en paramètre : ne jamais journaliser l'URL complète).
- Clés sans restriction pour l'instant. **Phase 8 ter** : restreindre `raijin-api` et `raijin-banc-de-test` par IP (ou CIDR) du VPS dans API Keys → Access control. Pas de restriction par domaine (clés serveur).
