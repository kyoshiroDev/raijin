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
# Port d'écoute de l'API (si 3000 est déjà pris sur ta machine : API_PORT=3100 et API_URL en conséquence)
API_PORT=3000
# Origines autorisées par CORS (web + landing), séparées par des virgules
CORS_ORIGINS=http://localhost:4200,http://localhost:4321

# ---------------------------------------------------------------------
# PostgreSQL 17 (conteneur local docker-compose.dev.yml, port hôte 5433, puis raijin-postgres sur le VPS)
# ---------------------------------------------------------------------
# Mot de passe à générer : openssl rand -base64 32
POSTGRES_USER=raijin
POSTGRES_PASSWORD=changeme-factice
POSTGRES_DB=raijin
DATABASE_URL=postgresql://raijin:changeme-factice@localhost:5433/raijin?schema=public

# ---------------------------------------------------------------------
# Redis (conteneur local, port hôte 6380, puis raijin-redis sur le VPS) : stockage du rate limiting
# ---------------------------------------------------------------------
REDIS_URL=redis://localhost:6380
# Rate limiting par IP : toutes routes, et renforcé par route sensible de /auth (connexion, inscription, liens e-mail)
RATE_LIMIT_PER_MINUTE=120
RATE_LIMIT_AUTH_PER_MINUTE=10

# ---------------------------------------------------------------------
# Auth : JWT et cookies httpOnly
# ---------------------------------------------------------------------
# À générer : openssl rand -base64 48
JWT_ACCESS_SECRET=changeme-access-secret-factice
# Durée de l'access token (JWT court, cookie httpOnly)
JWT_ACCESS_TTL=15m
# Durée du refresh token (opaque, haché en base, rotation à chaque usage : pas de secret JWT dédié)
JWT_REFRESH_TTL=30d
# À générer : openssl rand -base64 32 (signature HMAC des jetons CSRF double-submit)
COOKIE_SECRET=changeme-cookie-secret-factice
# Laisser vide : cookies liés à l'hôte de l'API (préfixes __Host- / __Secure- en prod), voir docs/ARCHITECTURE.md §8.4
COOKIE_DOMAIN=
# Cookies Secure + préfixes __Host-/__Secure- : true en prod (HTTPS) ; false en dev sur http://localhost (WebKit/Safari refuse sinon)
COOKIE_SECURE=false
# Durées de validité des liens envoyés par e-mail (jetons à usage unique, hachés en base)
EMAIL_VERIFY_TTL=24h
PASSWORD_RESET_TTL=30m
MAGIC_LINK_TTL=15m
# Verrouillage temporaire après échecs de connexion consécutifs (nombre d'échecs, durée)
AUTH_LOCKOUT_THRESHOLD=5
AUTH_LOCKOUT_DURATION=15m
# Nombre de proxys de confiance devant l'API (IP réelle pour le rate limiting) : 1 derrière Traefik en prod, vide en dev
TRUST_PROXY=
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
# smtp (Mailpit en dev) ou resend (activé seulement si RESEND_API_KEY contient une vraie clé)
MAIL_PROVIDER=smtp
# Mailpit local (docker-compose.dev.yml) : SMTP sur le port hôte 1026, interface sur http://localhost:8026
SMTP_HOST=localhost
SMTP_PORT=1026
# Identifiants SMTP (vides pour Mailpit ; à renseigner seulement pour un relais SMTP authentifié)
SMTP_USER=
SMTP_PASSWORD=
# Resend — https://resend.com/api-keys — (optionnel en dev : simulation locale via Mailpit)
RESEND_API_KEY=re_factice
# Expéditeur (domaine vérifié sur https://resend.com/domains)
MAIL_FROM="Raijin <noreply@raijinshield.com>"
# Logo PNG de l'en-tête des e-mails (vide = APP_URL/icons/icon-192.png)
MAIL_LOGO_URL=

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
# Seed de développement (pnpm nx run api-prisma:seed) — optionnel
# ---------------------------------------------------------------------
# Mot de passe du compte local dev@raijin.local (12 caractères min.) ; vide = généré et affiché une fois
SEED_USER_PASSWORD=

# ---------------------------------------------------------------------
# Sentry — (optionnel en dev : désactivé si vide)
# ---------------------------------------------------------------------
# Sentry — https://sentry.io/settings/projects/ → ton projet → Client Keys (DSN)
SENTRY_DSN_API=
SENTRY_DSN_WEB=
SENTRY_ENVIRONMENT=development
```

## Validation au démarrage (`libs/api/core`, `loadConfig`)

- **Production** (`NODE_ENV=production`) : l'API refuse de démarrer si `JWT_ACCESS_SECRET` ou
  `COOKIE_SECRET` est absente, factice (`changeme…`, `…factice`) ou plus courte que 32 caractères,
  si `DATABASE_URL` ou `REDIS_URL` manque, si `COOKIE_SECURE` n'est pas `true`, si une origine
  n'est pas en HTTPS, ou si `MAIL_PROVIDER=resend` sans vraie `RESEND_API_KEY`. Les messages
  citent le nom de la variable, jamais sa valeur.
- **Développement / test** : valeurs de repli non secrètes (ports locaux 5433 / 6380 / 1026) ; les
  secrets absents ou factices sont générés aléatoirement à chaque démarrage, avec un avertissement
  (les sessions ne survivent donc pas à un redémarrage tant qu'aucun secret n'est fourni).
- `GET /api/v1/health/config` répond `configured` / `not_configured` par service, sans aucune valeur.

