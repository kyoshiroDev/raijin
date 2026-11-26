# SECRETS-CHECKLIST — Raijin Shield

Claude Code ne copie jamais une clé secrète. **C'est toi qui copies chaque valeur** dans ton `.env` local
(à partir du modèle de `docs/ENV.md`), puis dans le `.env` du VPS au déploiement. Coche la case quand c'est fait.
Les noms de variables suivent `docs/ENV.md`.

## Services en ligne

| Variable | Service | Page exacte où la trouver | Utilisé par | Copié par l'utilisateur |
|---|---|---|---|---|
| `HELIUS_API_KEY` | Helius | https://dashboard.helius.dev → API Keys → ligne **« raijin-api »** → bouton copier de la colonne « API Key » | apps/api (serveur uniquement) | [x] |
| `BENCH_HELIUS_API_KEY` (nom proposé, à ajouter à `docs/ENV.md`) | Helius | https://dashboard.helius.dev → API Keys → ligne **« raijin-banc-de-test »** → bouton copier de la colonne « API Key » | apps/raijin-banc-de-test-api (serveur uniquement) | [x] |
| `RESEND_API_KEY` | Resend | https://resend.com/api-keys — service pas encore créé | apps/api | [ ] |
| `STRIPE_SECRET_KEY` | Stripe (test) | Compte « Raijin Shield » (`acct_1UgBFZ2YwXqnyasm`), mode test : **Développeurs → Clés API** (https://dashboard.stripe.com/test/apikeys) → « Clé secrète » `sk_test_…` → Révéler → copier. Même valeur pour `.env` local, `infra/.env.api` (prod en mode test) et `/srv/raijin/dev/env/.env.api` (dev). Avec `BILLING_PROVIDER=stripe`, `STRIPE_PRICE_PRO_MONTHLY=price_1UgBZn2YwXqnyasmXAyAAFMi`, `STRIPE_PRICE_PRO_YEARLY=price_1UgBZm2YwXqnyasm2VcbmJSo` (identifiants publics) | apps/api | [ ] |
| `STRIPE_WEBHOOK_SECRET` (prod, mode test) | Stripe (test) | https://dashboard.stripe.com/test/workbench/webhooks → destination **« raijin-prod »** (`we_1UgBqL2YwXqnyasmipMpIZPq`) → « Clé secrète de signature » `whsec_…` → icône œil (Révéler) → copier dans `infra/.env.api` | apps/api (prod) | [ ] |
| `STRIPE_WEBHOOK_SECRET` (dev) | Stripe (test) | même page → destination **« raijin-dev »** (`we_1UgBt62YwXqnyasmWx3bdCuc`) → « Clé secrète de signature » → Révéler → copier dans `/srv/raijin/dev/env/.env.api` (distinct de la prod). En local : `stripe listen --forward-to localhost:3100/api/v1/billing/webhook` affiche un secret propre au poste | apps/api (dev) | [ ] |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google Cloud | https://console.cloud.google.com/iam-admin/serviceaccounts?authuser=4&project=raijin-admin → `raijin-admin-reader@raijin-admin.iam.gserviceaccount.com` → onglet Clés → Ajouter une clé → Créer une clé → JSON → Créer (clé créée et collée en base64 par l'utilisateur le 2026-11-26) | apps/api (admin-analytics) | [x] |
| `SENTRY_DSN_API` / `SENTRY_DSN_WEB` | Sentry | https://sentry.io/settings/projects/ → projet → Client Keys (DSN) — service pas encore créé | apps/api / apps/web | [ ] |

## Secrets générés localement (aucun service)

| Variable | Comment la générer | Utilisé par | Fait |
|---|---|---|---|
| `POSTGRES_PASSWORD` (et `DATABASE_URL`) | `openssl rand -base64 32` | apps/api | [ ] |
| `JWT_ACCESS_SECRET` | `openssl rand -base64 48` | apps/api | [ ] |
| `COOKIE_SECRET` | `openssl rand -base64 32` | apps/api | [ ] |
| `TOTP_ENCRYPTION_KEY` | `openssl rand -base64 32` | apps/api | [ ] |
| `VAPID_PRIVATE_KEY` (+ `VAPID_PUBLIC_KEY`) | `npx web-push generate-vapid-keys` | apps/api | [ ] |

> **2026-11-26** : `HELIUS_API_KEY` copiée par l'utilisateur ; `BENCH_HELIUS_API_KEY` copiée (clé « raijin-banc-de-test »).

## Notes Helius (non secrètes)
- Plan **Free** : 1 M crédits/mois, RPC 10 req/s, DAS 2 req/s, `getProgramAccounts` 5 req/s, `sendTransaction` 1 req/s (inutile : lecture seule). Pas de crédits additionnels sur ce plan.
- Les deux clés partagent le même projet, donc **le même quota** (1 M crédits, 10 req/s au total) : prévoir le rate limiting en conséquence.
- URL RPC : `https://mainnet.helius-rpc.com/?api-key=<clé>` (la clé passe en paramètre : ne jamais journaliser l'URL complète).
- Clés sans restriction pour l'instant. **Phase 8 ter** : restreindre `raijin-api` et `raijin-banc-de-test` par IP (ou CIDR) du VPS dans API Keys → Access control. Pas de restriction par domaine (clés serveur).
