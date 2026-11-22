# api-billing

Abonnement Pro de l'API Raijin (PROMPT.md §4.4, docs/ARCHITECTURE.md §13) : plans et prix (configuration, centimes),
état de l'abonnement, Checkout hébergé, portail client, webhook Stripe et simulation locale.

- `BillingProvider` : `StripeBillingProvider` (SDK officiel, `STRIPE_API_VERSION` épinglée) et `FakeBillingProvider`
  (`BILLING_PROVIDER=fake`, refusé en production : faux Checkout `/abonnement/simulation`, faux portail
  `/abonnement/simulation-portail`, événements signés localement et traités par le même chemin que le webhook).
- Webhook `POST /api/v1/billing/webhook` : corps brut (`billingWebhookRawBody`, monté dans `apps/api/src/main.ts`),
  signature vérifiée, mode test / réel contrôlé, idempotence transactionnelle (`StripeEvent`), abonnement relu chez
  Stripe, événement plus ancien que `Subscription.lastEventAt` ignoré. Seul le webhook écrit `Subscription` et `User.plan`.
- Fixtures des 5 événements : `src/testing/fixtures/*.json`, signées à la volée (Jest, `POST internal/billing/webhook-fixtures/:name`
  avec `JOBS_TEST_TRIGGER=1`, jamais en production).

Tests : `pnpm nx test api-billing` (Jest, Prisma en mémoire) et `pnpm nx e2e api-e2e` (`billing.e2e.spec.ts`).
