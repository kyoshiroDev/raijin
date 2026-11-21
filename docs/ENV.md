# Variables d'environnement — Raijin Shield

Modèle du `.env.example` racine (valeurs **factices** uniquement).

> Le fichier `.env.example` n'a pas pu être créé par les agents : `.claude/settings.json`
> refuse tout accès à un chemin `.env.*` (règle `Read(./.env.*)`, appliquée aussi à l'écriture).
> Pour le créer : copie le bloc ci-dessous dans `.env.example` (commité), puis dans `.env`
> (jamais commité) avec les vraies valeurs.

Les secrets ne vivent que côté API. Le front ne reçoit aucune clé secrète
(seule la clé publique Stripe est tolérée côté client).

```dotenv
# =====================================================================
# Raijin Shield — variables d'environnement (VALEURS FACTICES)
# Copie ce fichier en .env (jamais commité) et remplace les valeurs.
# =====================================================================

# ---------------------------------------------------------------------
# URLs des apps
# ---------------------------------------------------------------------
NODE_ENV=development
# URL publique de l'app Angular (prod : https://app.raijinshield.com)
APP_URL=http://localhost:4200
# URL publique de la landing Astro (prod : https://raijinshield.com)
LANDING_URL=http://localhost:4321
# URL publique de l'API (prod : https://api.raijinshield.com)
API_URL=http://localhost:3000
API_PORT=3000
# Origines autorisées par CORS (web + landing), séparées par des virgules
CORS_ORIGINS=http://localhost:4200,http://localhost:4321

# ---------------------------------------------------------------------
# PostgreSQL 17 (conteneur local docker-compose.dev.yml, puis raijin-postgres sur le VPS)
# ---------------------------------------------------------------------
# Mot de passe à générer : openssl rand -base64 32
POSTGRES_USER=raijin
POSTGRES_PASSWORD=changeme-factice
POSTGRES_DB=raijin
DATABASE_URL=postgresql://raijin:changeme-factice@localhost:5432/raijin?schema=public

# ---------------------------------------------------------------------
# Redis (conteneur local, puis raijin-redis sur le VPS)
# ---------------------------------------------------------------------
REDIS_URL=redis://localhost:6379

# ---------------------------------------------------------------------
# Auth : JWT et cookies httpOnly
# ---------------------------------------------------------------------
# À générer : openssl rand -base64 48
JWT_ACCESS_SECRET=changeme-access-secret-factice
# À générer : openssl rand -base64 48 (différent du précédent)
JWT_REFRESH_SECRET=changeme-refresh-secret-factice
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d
# À générer : openssl rand -base64 32 (signature des cookies)
COOKIE_SECRET=changeme-cookie-secret-factice
# Domaine des cookies (prod : .raijinshield.com ; dev : vide = localhost)
COOKIE_DOMAIN=
# Clé de chiffrement des secrets TOTP (2FA admin), 32 octets. À générer : openssl rand -base64 32
TOTP_ENCRYPTION_KEY=changeme-cle-totp-factice

# ---------------------------------------------------------------------
# Helius (RPC Solana) — (optionnel en dev : simulation locale, RPC public + fixtures)
# ---------------------------------------------------------------------
# Helius — https://dashboard.helius.dev/api-keys
HELIUS_API_KEY=
# RPC de repli sans clé (débit très limité)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# ---------------------------------------------------------------------
# E-mails : Resend (prod) ou SMTP Mailpit (dev)
# ---------------------------------------------------------------------
# smtp (Mailpit en dev) ou resend
MAIL_PROVIDER=smtp
# Mailpit local (docker-compose.dev.yml) : interface sur http://localhost:8025
SMTP_HOST=localhost
SMTP_PORT=1025
# Resend — https://resend.com/api-keys — (optionnel en dev : simulation locale via Mailpit)
RESEND_API_KEY=re_factice
# Expéditeur (domaine vérifié sur https://resend.com/domains)
MAIL_FROM="Raijin <noreply@raijinshield.com>"

# ---------------------------------------------------------------------
# Stripe (mode test) — (optionnel en dev : simulation locale, BILLING_PROVIDER=fake)
# ---------------------------------------------------------------------
# fake (simulation locale) ou stripe
BILLING_PROVIDER=fake
# Stripe — https://dashboard.stripe.com/test/apikeys (clé secrète « sk_test_… »)
STRIPE_SECRET_KEY=sk_test_factice
# Stripe — https://dashboard.stripe.com/test/webhooks (secret de signature de l'endpoint)
# En local : la commande « stripe listen --forward-to localhost:3000/api/v1/billing/webhook » l'affiche.
STRIPE_WEBHOOK_SECRET=whsec_factice
# Stripe — https://dashboard.stripe.com/test/apikeys (clé publiable « pk_test_… », seule clé autorisée côté front)
STRIPE_PUBLISHABLE_KEY=pk_test_factice
# Stripe — https://dashboard.stripe.com/test/products (ID du prix Pro mensuel 9,90 €)
STRIPE_PRICE_PRO_MONTHLY=price_factice_mensuel
# Stripe — https://dashboard.stripe.com/test/products (ID du prix Pro annuel 99 €)
STRIPE_PRICE_PRO_YEARLY=price_factice_annuel

# ---------------------------------------------------------------------
# Push web (VAPID)
# ---------------------------------------------------------------------
# À générer localement : npx web-push generate-vapid-keys
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:contact@raijinshield.com

# ---------------------------------------------------------------------
# Google — (optionnel en dev : simulation locale, intégrations désactivées si vide)
# ---------------------------------------------------------------------
# GA4 — https://analytics.google.com/ → Administration → Flux de données → ton flux web (« G-XXXXXXX »)
GA4_MEASUREMENT_ID=
# GA4 — https://analytics.google.com/ → Administration → Paramètres de la propriété (« ID de propriété », numérique)
GA4_PROPERTY_ID=
# Google Cloud — https://console.cloud.google.com/iam-admin/serviceaccounts → compte de service → Clés → JSON
# Colle le JSON sur une seule ligne (ou en base64 : base64 -w0 cle.json). Jamais commité.
GOOGLE_SERVICE_ACCOUNT_JSON=
# Search Console — https://search.google.com/search-console (propriété, ex. sc-domain:raijinshield.com)
SEARCH_CONSOLE_SITE_URL=
# Search Console — https://search.google.com/search-console → Ajouter une propriété → Balise HTML (valeur de content)
GOOGLE_SITE_VERIFICATION=

# ---------------------------------------------------------------------
# Sentry — (optionnel en dev : désactivé si vide)
# ---------------------------------------------------------------------
# Sentry — https://sentry.io/settings/projects/ → ton projet → Client Keys (DSN)
SENTRY_DSN_API=
SENTRY_DSN_WEB=
SENTRY_ENVIRONMENT=development
```
