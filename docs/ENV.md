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
API_URL=http://localhost:3100
# Port d'écoute de l'API en dev (3100 par défaut : 3000 est pris par d'autres projets sur la machine)
API_PORT=3100
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
# Vide = 10 en production, 60 en dev/test
RATE_LIMIT_AUTH_PER_MINUTE=

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
# Verrouillage temporaire par adresse e-mail (compteur Redis, aussi pour les adresses sans compte) :
# nombre d'échecs (connexion ou confirmation par mot de passe), durée. Réponse toujours identique.
AUTH_LOCKOUT_THRESHOLD=5
AUTH_LOCKOUT_DURATION=15m
# Nombre de proxys de confiance devant l'API (OBLIGATOIRE en production, l'API refuse de démarrer sinon) :
#   1 derrière Traefik (VPS) : Express prend l'IP réelle dans X-Forwarded-For posé par Traefik, sinon
#   toutes les requêtes auraient l'IP de Traefik (rate limiting et verrouillage communs à tous) ;
#   0 si l'API est exposée sans proxy. Jamais plus que le nombre réel de proxys (IP falsifiable).
#   Vide en dev.
TRUST_PROXY=
# Clé de chiffrement des secrets TOTP (2FA admin), 32 octets. À générer : openssl rand -base64 32
TOTP_ENCRYPTION_KEY=changeme-cle-totp-factice

# ---------------------------------------------------------------------
# Helius (RPC Solana) — (optionnel en dev : simulation locale, RPC public + fixtures)
# ---------------------------------------------------------------------
# Helius — https://dashboard.helius.dev/api-keys (copiée par toi, jamais affichée ni journalisée)
HELIUS_API_KEY=
# Helius — débit réservé à ce processus (plan Free : 10 req/s RPC et 2 req/s DAS partagés avec le banc,
#   https://www.helius.dev/docs/billing/rate-limits). API Raijin 7 / 1,5 ; banc 3 / 0,5.
HELIUS_RPC_RPS=7
HELIUS_DAS_RPS=1.5
# Helius — crédits par jour UTC (plan Free : 1 M/mois ; RPC 1 crédit, DAS 10,
#   https://www.helius.dev/docs/billing/credits). API 22000, banc 10000. Au-delà : RPC public ou « indisponible ».
HELIUS_DAILY_CREDIT_BUDGET=22000
# Solana — RPC public de repli sans clé (https://solana.com/docs/references/clusters, ~1 req/s ; refuse getTokenLargestAccounts)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_RPC_RPS=1
# URL de base des API publiques (https sans query string ; défauts du code, à ne changer que pour un proxy) :
#   DexScreener — https://docs.dexscreener.com/api/reference (300 req/min sur les routes paires/tokens)
DEXSCREENER_API_URL=https://api.dexscreener.com
#   GeckoTerminal — https://www.geckoterminal.com/dex-api (API publique ~10 appels/min)
GECKOTERMINAL_API_URL=https://api.geckoterminal.com/api/v2
#   Jupiter (devis seulement, sans clé : 0,5 req/s) — https://developers.jup.ag/docs/api-rate-limit
JUPITER_API_URL=https://lite-api.jup.ag/swap/v1
#   RugCheck (rapport public sans clé) — https://api.rugcheck.xyz/swagger/index.html
RUGCHECK_API_URL=https://api.rugcheck.xyz/v1
# Helius — URL de base RPC/DAS (la clé est ajoutée par le code, jamais ici)
HELIUS_RPC_URL=https://mainnet.helius-rpc.com

# ---------------------------------------------------------------------
# Analyse de token (API Raijin, docs/ARCHITECTURE.md §9.5 à §9.7)
# ---------------------------------------------------------------------
# Raijin — clé HMAC de l'empreinte d'IP des visiteurs anonymes (quota ; l'IP n'est jamais stockée en clair).
#   OBLIGATOIRE en production (32 caractères min.). À générer : openssl rand -base64 48
IP_HASH_SECRET=changeme-ip-hash-secret-factice
# Raijin — analyses par jour UTC : visiteur anonyme (par empreinte d'IP), plan Gratuit, essai Pro 7 jours (Pro : illimité)
ANON_ANALYSIS_DAILY_LIMIT=3
FREE_ANALYSIS_DAILY_LIMIT=5
TRIAL_ANALYSIS_DAILY_LIMIT=50
# Raijin — analyses en échec (token inexistant…) remboursées par jour UTC et par sujet (utilisateur ou empreinte d'IP) ;
#   au-delà, l'échec reste décompté et le sujet reçoit 429 QUOTA_EXCEEDED jusqu'à minuit (protège les crédits Helius)
ANALYSIS_FAILED_DAILY_LIMIT=20
# Raijin — pannes des sources (503 UPSTREAM_UNAVAILABLE) remboursées par jour UTC et par sujet ; au-delà, l'analyse reste
#   décomptée (pas de refus : une panne n'est pas la faute de l'utilisateur, mais elle ne doit pas offrir d'analyses gratuites)
ANALYSIS_UPSTREAM_FAILED_DAILY_LIMIT=10
# Raijin — limite par IP et par minute sur POST /analyses, en plus du quota (vide = 10 en production, 60 en dev/test)
RATE_LIMIT_ANALYSIS_PER_MINUTE=
# Raijin — durée du cache Redis d'un résultat d'analyse, en secondes (avec clé Helius / sans clé, RPC public lent)
ANALYSIS_CACHE_TTL_S=60
ANALYSIS_CACHE_TTL_NO_KEY_S=300
# Raijin — index.html du build web servi pour /t/<mint> avec les balises Open Graph injectées
#   (prod : volume en lecture seule ; build local : pnpm nx build web → dist/apps/web/browser/index.html).
#   Vide = HTML minimal avec un lien vers l'app.
WEB_INDEX_HTML_PATH=
# Raijin — dossier des polices WOFF de l'image OG (vide = assets/fonts du build de l'API, puis node_modules/@fontsource)
OG_FONTS_DIR=
# Raijin — sources simulées par des fixtures (tests e2e, démonstration locale sans réseau). 0 ou 1.
#   Refusé en production (l'API ne démarre pas). Rejoue les enregistrements de libs/api/solana/src/fixtures
#   (BONK, USDC, PYUSD, pump.fun récent, mint actif, honeypot, mint inexistant), sans clé Helius.
ANALYSIS_FIXTURES=0
# Raijin — dossier des fixtures rejouées (vide = libs/api/solana/src/fixtures depuis la racine du dépôt)
ANALYSIS_FIXTURES_DIR=

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
# En local : la commande « stripe listen --forward-to localhost:3100/api/v1/billing/webhook » l'affiche.
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

- **Production** (`NODE_ENV=production`) : l'API refuse de démarrer si `JWT_ACCESS_SECRET`,
  `COOKIE_SECRET` ou `IP_HASH_SECRET` est absente, factice (`changeme…`, `…factice`) ou plus courte que 32 caractères,
  si `DATABASE_URL`, `REDIS_URL` ou `TRUST_PROXY` manque, si `COOKIE_SECURE` n'est pas `true`, si une origine
  n'est pas en HTTPS, si `MAIL_PROVIDER=resend` sans vraie `RESEND_API_KEY`, ou si
  `ANALYSIS_FIXTURES` est activé. Les messages
  citent le nom de la variable, jamais sa valeur.
- **Développement / test** : valeurs de repli non secrètes (ports locaux 5433 / 6380 / 1026) ; les
  secrets absents ou factices sont générés aléatoirement à chaque démarrage, avec un avertissement
  (les sessions ne survivent donc pas à un redémarrage tant qu'aucun secret n'est fourni).
- `GET /api/v1/health/config` répond `configured` / `not_configured` par service, sans aucune valeur.

