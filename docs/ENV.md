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
#   Aussi lue par la LANDING au build (liens vers l'inscription ; défaut https://app.raijinshield.com).
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
# Raijin — clé AES-256-GCM des secrets TOTP de la 2FA admin (32 octets en base64). À générer : openssl rand -base64 32
#   OBLIGATOIRE en production (l'API refuse de démarrer si absente, factice ou ≠ 32 octets) ; vide en dev = clé éphémère
#   (2FA à réactiver après chaque redémarrage). La perdre en production = réactiver la 2FA :
#   pnpm nx run api:admin-reset-2fa --email=ton@email (docs/ARCHITECTURE.md §14.2).
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
#   La même durée sert de fenêtre de déduplication du quota (même sujet + même mint : compté une fois tant
#   que le résultat est servi depuis le cache ; au-delà, une nouvelle collecte coûte des crédits et recompte).
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
# fake (simulation locale : faux Checkout, webhooks signés localement ; REFUSÉ en production) ou stripe
#   (stripe sans clé valide : l'API démarre, paiement indisponible, 503 BILLING_NOT_CONFIGURED). docs/ARCHITECTURE.md §13.8
#   Vide = fake hors production, stripe en production. Une clé sk_live_ est refusée hors production (mode test seulement).
BILLING_PROVIDER=fake
# Stripe — https://dashboard.stripe.com/test/apikeys (clé secrète « sk_test_… », côté API uniquement, jamais journalisée)
STRIPE_SECRET_KEY=sk_test_factice
# Stripe — https://dashboard.stripe.com/test/webhooks (endpoint https://api.raijinshield.com/api/v1/billing/webhook,
#   événements : checkout.session.completed, customer.subscription.updated, customer.subscription.deleted,
#   invoice.payment_failed, invoice.paid ; version d'API de l'endpoint = STRIPE_API_VERSION de
#   libs/api/billing/src/lib/provider/stripe-billing.provider.ts ; puis « Signing secret » whsec_…).
# En local : la commande « stripe listen --forward-to localhost:3100/api/v1/billing/webhook » l'affiche.
# En simulation (BILLING_PROVIDER=fake), sert à signer les événements simulés ; vide = secret éphémère.
STRIPE_WEBHOOK_SECRET=whsec_factice
# Stripe — https://dashboard.stripe.com/test/apikeys (clé publiable « pk_test_… ») : NON utilisée (Checkout hébergé
#   par redirection) ; à laisser vide. Seule clé qui serait tolérée côté front.
STRIPE_PUBLISHABLE_KEY=
# Stripe — https://dashboard.stripe.com/test/products (produit « Raijin Pro », ID du prix récurrent mensuel 9,90 € TTC)
STRIPE_PRICE_PRO_MONTHLY=price_factice_mensuel
# Stripe — https://dashboard.stripe.com/test/products (même produit, ID du prix récurrent annuel 99 € TTC)
STRIPE_PRICE_PRO_YEARLY=price_factice_annuel
# Stripe — https://dashboard.stripe.com/test/settings/billing/portal (optionnel : ID « bpc_… » d'une configuration
#   du portail client ; vide = configuration par défaut du compte)
STRIPE_PORTAL_CONFIGURATION_ID=
# Raijin — prix affichés (centimes TTC, entiers) et devise ISO 4217 : doivent correspondre aux prix Stripe ci-dessus
#   (vérifiés au démarrage ; écart = paiement indisponible). Jamais en dur dans le front : servis par GET /billing/plans.
PRO_PRICE_MONTHLY_CENTS=990
PRO_PRICE_YEARLY_CENTS=9900
BILLING_CURRENCY=EUR

# ---------------------------------------------------------------------
# Essai Pro sans carte (base de données uniquement, Stripe non utilisé ; docs/ARCHITECTURE.md §13)
# ---------------------------------------------------------------------
# Raijin — durée de l'essai Pro démarré à la vérification de l'e-mail, en jours
TRIAL_DAYS=7
# Raijin — job de fin d'essai et d'envoi des e-mails J+1 / J-2 (cron UTC, file BullMQ maintenance)
TRIAL_JOB_CRON="5 * * * *"
# Raijin — heure d'envoi des e-mails J+1 et J-2, heure de Paris (Europe/Paris) ; J0 part à la fin de l'essai
TRIAL_EMAIL_HOUR=10
# Raijin — conservation des empreintes d'essai (HMAC IP + user-agent), en jours (PROMPT.md : 90)
TRIAL_FINGERPRINT_RETENTION_DAYS=90
# Raijin — conservation des HMAC d'e-mails normalisés ayant eu un essai (un essai par e-mail, même après
#   suppression du compte), en jours : 730 = 24 mois
TRIAL_CLAIM_RETENTION_DAYS=730
# Raijin — un abonnement dans les N jours après la fin de l'essai compte comme une conversion
TRIAL_CONVERSION_WINDOW_DAYS=30
# Raijin — limite par utilisateur et par minute sur la création de sessions Checkout / portail (vide = 10)
RATE_LIMIT_BILLING_PER_MINUTE=

# ---------------------------------------------------------------------
# Push web (VAPID) — (optionnel en dev : sans clés, le push est indisponible, alertes par e-mail seulement)
# ---------------------------------------------------------------------
# VAPID — paire de clés générée localement, une fois par environnement (dev, prod), jamais commitée :
#   pnpm exec web-push generate-vapid-keys --json
#   (paquet web-push, docs : https://github.com/web-push-libs/web-push#command-line).
#   Copie publicKey → VAPID_PUBLIC_KEY et privateKey → VAPID_PRIVATE_KEY dans ton .env.
#   La clé privée reste côté API (jamais dans le front ni dans les logs) ; la clé publique est servie
#   par GET /api/v1/push/vapid-public-key. Changer de paire invalide tous les abonnements existants.
#   Sans clés en développement : paire éphémère générée à chaque démarrage (avertissement, abonnements perdus
#   au redémarrage) ; en production : push indisponible (jamais de génération).
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
# Contact VAPID exigé par les services push (mailto: ou https:)
VAPID_SUBJECT=mailto:support@raijinshield.com
# webpush (envoi réel) ou fake (tests e2e : notifications enregistrées en mémoire, aucun appel réseau ;
#   refusé en production)
PUSH_PROVIDER=webpush

# ---------------------------------------------------------------------
# Suivis, alertes et jobs (BullMQ sur Redis, docs/ARCHITECTURE.md §11)
# ---------------------------------------------------------------------
# Raijin — jobs programmés (réanalyse des suivis, envoi des alertes, purges). false dans les tests unitaires.
JOBS_ENABLED=true
# Raijin — préfixe des clés BullMQ dans Redis (le banc utilisera raijin-bench)
BULLMQ_PREFIX=raijin
# Raijin — route de déclenchement manuel des jobs pour les tests e2e (POST /api/v1/internal/jobs/:name/run,
#   POST /api/v1/internal/fixtures/:scenario avec ANALYSIS_FIXTURES=1, GET /api/v1/internal/push/outbox avec
#   PUSH_PROVIDER=fake). 0 ou 1. À 1, les planifications automatiques (planificateur, purge, résumé) sont retirées :
#   les tests déclenchent les jobs eux-mêmes. Refusé en production (l'API ne démarre pas).
JOBS_TEST_TRIGGER=0
# Raijin — suivis actifs par plan (Pro et essai : 50 ; Gratuit : 3), relus avec le plan en base à chaque requête
FREE_WATCH_LIMIT=3
PRO_WATCH_LIMIT=50
# Raijin — historique des alertes affiché, en jours (données conservées 90 jours pour tous)
FREE_ALERT_HISTORY_DAYS=30
PRO_ALERT_HISTORY_DAYS=90
# Raijin — période du planificateur des réanalyses, en secondes
WATCH_TICK_SECONDS=60
# Raijin — intervalles des passes par mint suivi, en minutes : rapide (autorités + pool, par lots),
#   holders (top 20), complète (verdict). Étirés automatiquement si le budget de crédits ne suffit pas.
WATCH_FAST_INTERVAL_MIN=5
WATCH_HOLDERS_INTERVAL_MIN=30
WATCH_FULL_INTERVAL_MIN=360
# Helius — part des crédits journaliers de l'API réservée aux suivis (≤ HELIUS_DAILY_CREDIT_BUDGET ;
#   https://www.helius.dev/docs/billing/credits). 12000 sur 22000 : les analyses à la demande gardent ≥ 10000.
WATCH_DAILY_CREDIT_BUDGET=12000
# Raijin — une alerte du même type pour le même mint au plus toutes les N minutes (sauf aggravation)
ALERT_COOLDOWN_MINUTES=360
# Raijin — délai de regroupement des alertes d'un utilisateur dans un seul e-mail, en secondes ; plafond par jour
ALERT_EMAIL_BATCH_DELAY_S=120
ALERT_EMAIL_DAILY_MAX=20
# Raijin — rétention (purge quotidienne) : analyses, événements produit, compteurs, alertes (empreintes d’essai : TRIAL_FINGERPRINT_RETENTION_DAYS)
RETENTION_DAYS=90
# Raijin — heure de la purge quotidienne (cron UTC)
PURGE_CRON="30 3 * * *"
# Raijin — URL de base des images des e-mails (Rai en PNG 2x) ; vide = APP_URL/email
MAIL_ASSETS_BASE_URL=
# Raijin — maintenance programmée : 1 = toutes les routes sauf /health répondent 503 MAINTENANCE
MAINTENANCE_MODE=0

# ---------------------------------------------------------------------
# Scan de wallet (lecture seule, Pro et essai Pro, docs/ARCHITECTURE.md §12)
# ---------------------------------------------------------------------
# Raijin — scans de wallet par jour (jour UTC) : Pro et essai Pro. Gratuit : aucun scan (403).
WALLET_SCAN_DAILY_LIMIT_PRO=20
WALLET_SCAN_DAILY_LIMIT_TRIAL=10
# Raijin — limite par utilisateur et par minute sur POST /wallet-scans, en plus du quota (vide = 5 en production, 60 en dev/test)
RATE_LIMIT_WALLET_SCAN_PER_MINUTE=
# Helius — part des crédits journaliers de l'API réservée aux scans de wallet
#   (https://www.helius.dev/docs/billing/credits ; WATCH_DAILY_CREDIT_BUDGET + WALLET_DAILY_CREDIT_BUDGET
#   ≤ HELIUS_DAILY_CREDIT_BUDGET). 3000 : ≈ 55 scans à froid par jour, les analyses gardent ≥ 7000.
WALLET_DAILY_CREDIT_BUDGET=3000
# Raijin — tokens analysés au plus par scan (les plus gros en valeur d'abord), avec et sans clé Helius
WALLET_SCAN_MAX_TOKENS=20
WALLET_SCAN_MAX_TOKENS_NO_KEY=8
# Raijin — au-delà de ce nombre de comptes de tokens, le scan est refusé (WALLET_TOO_LARGE)
WALLET_SCAN_MAX_ACCOUNTS=1000
# Raijin — prix demandés à DexScreener au plus par scan (lots de 30, gratuit) ; les autres tokens : valeur inconnue
WALLET_SCAN_PRICE_LOOKUP_MAX=150
# Raijin — en dessous de cette valeur (USD, prix connu), un token est « poussière » : listé, non analysé
WALLET_SCAN_DUST_USD=1
# Raijin — échéance globale d'un scan (ms) : au-delà, les tokens restants sont « indisponibles » (résultat partiel)
WALLET_SCAN_DEADLINE_MS=15000
# Raijin — cache du résultat d'un wallet (s), avec et sans clé Helius ; aucune adresse n'est stockée en base
WALLET_SCAN_CACHE_TTL_S=120
WALLET_SCAN_CACHE_TTL_NO_KEY_S=600
# Raijin — cache du verdict rapide par mint (s) ; une analyse complète plus récente que
#   WALLET_REUSE_ANALYSIS_MAX_AGE_S est réutilisée telle quelle
WALLET_TOKEN_VERDICT_TTL_S=3600
WALLET_REUSE_ANALYSIS_MAX_AGE_S=3600

# ---------------------------------------------------------------------
# Google — (optionnel en dev : simulation locale, intégrations désactivées si vide ; docs/ARCHITECTURE.md §14.6)
# ---------------------------------------------------------------------
# GA4 — https://analytics.google.com/ → Administration → Flux de données → ton flux web (« G-XXXXXXX »)
#   Lu par la LANDING au build (valeur publique) ; vide = ni GA4 ni bannière de consentement sur la landing.
GA4_MEASUREMENT_ID=
# GA4 — https://analytics.google.com/ → Administration → Paramètres de la propriété (« ID de propriété », numérique)
#   Lu par l'API (écrans Trafic, Vue d'ensemble, Acquisition de l'admin).
GA4_PROPERTY_ID=
# Google Cloud — https://console.cloud.google.com/iam-admin/serviceaccounts → compte de service → Clés → JSON
#   APIs à activer : https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com
#                    https://console.cloud.google.com/apis/library/searchconsole.googleapis.com
#   Accès en LECTURE seule : GA4 → Administration → Gestion des accès à la propriété → e-mail du compte de service,
#   rôle « Lecteur » ; Search Console → Paramètres → Utilisateurs et autorisations → « Restreint ».
#   Portées demandées par l'API : analytics.readonly et webmasters.readonly (rien d'autre).
#   Colle le JSON sur une seule ligne (ou en base64 : base64 -w0 cle.json). Jamais commité, jamais journalisé.
GOOGLE_SERVICE_ACCOUNT_JSON=
# Search Console — https://search.google.com/search-console (propriété, ex. sc-domain:raijinshield.com)
SEARCH_CONSOLE_SITE_URL=
# Search Console — https://search.google.com/search-console → Ajouter une propriété → Balise HTML (valeur de content)
#   Lu par la LANDING au build (balise meta google-site-verification) ; inutile avec une propriété de domaine (DNS).
GOOGLE_SITE_VERIFICATION=
# Raijin — google (lecture réelle, si GOOGLE_SERVICE_ACCOUNT_JSON est fourni) ou fake (données simulées déterministes,
#   dev et tests e2e ; REFUSÉ en production). Vide = google si le JSON est fourni, sinon « Non connecté ».
ANALYTICS_PROVIDER=
# Raijin — durée du cache Redis des réponses Google, en secondes (PROMPT.md §4.7 : 1 h) ; erreurs gardées 5 min
ANALYTICS_CACHE_TTL_S=3600

# ---------------------------------------------------------------------
# Espace admin (rôle ADMIN par CLI, 2FA TOTP, agrégats, alertes ; docs/ARCHITECTURE.md §14)
# ---------------------------------------------------------------------
# Raijin — rôle ADMIN : jamais depuis l'interface. pnpm nx run api:make-admin --email=ton@email (--revoke pour retirer)
# Raijin — session admin : expiration après N minutes sans activité admin, et durée maximale après la saisie du code
ADMIN_SESSION_IDLE_MINUTES=30
ADMIN_SESSION_MAX_HOURS=8
# Raijin — nom affiché dans l'application d'authentification (Google Authenticator, 1Password, Aegis…)
ADMIN_TOTP_ISSUER="Raijin Shield"
# Raijin — codes 2FA faux tolérés avant blocage temporaire (compteur Redis par compte), durée du blocage
ADMIN_TOTP_MAX_ATTEMPTS=5
ADMIN_TOTP_LOCKOUT_MINUTES=15
# Raijin — agrégats nocturnes DailyMetric (cron UTC, file maintenance) : AVANT la purge (PURGE_CRON), qui ne supprime
#   les événements d'un jour qu'une fois ce jour agrégé
METRICS_CRON="15 2 * * *"
# Raijin — vérification des alertes admin (cron UTC) : job en échec N fois de suite, quota au-delà du ratio
ADMIN_ALERTS_CRON="*/10 * * * *"
ADMIN_ALERT_JOB_FAILURES=3
ADMIN_ALERT_QUOTA_RATIO=0.8
# Jupiter — plafond d'appels de devis par jour UTC pour le calcul du ratio (sans clé : 0,5 req/s,
#   https://developers.jup.ag/docs/api-rate-limit) ; vide = appels comptés sans ratio ni alerte
JUPITER_DAILY_CALL_BUDGET=40000
# RugCheck — plafond d'appels par jour UTC (limite publique non documentée, https://api.rugcheck.xyz/swagger/index.html) ;
#   vide = appels comptés sans ratio ni alerte
RUGCHECK_DAILY_CALL_BUDGET=
# Raijin — conservation du journal d'audit (AuditLog), en jours
AUDIT_LOG_RETENTION_DAYS=365

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
  `ANALYSIS_FIXTURES` est activé, si `JOBS_TEST_TRIGGER=1` ou `PUSH_PROVIDER=fake`, si une seule des deux clés
  VAPID est fournie (les deux ou aucune : sans clés, push indisponible), ou si `WATCH_DAILY_CREDIT_BUDGET`
  dépasse `HELIUS_DAILY_CREDIT_BUDGET`, ou `WATCH_DAILY_CREDIT_BUDGET + WALLET_DAILY_CREDIT_BUDGET` aussi (phase 5), ou si
  `BILLING_PROVIDER=fake` (phase 6, `loadBillingConfig` de `libs/api/billing` ; `stripe` sans clé valide démarre en mode
  paiement indisponible ; hors production, une clé `sk_live_` est refusée) (ou si `PURGE_CRON` n'est pas un cron à 5 champs, `VAPID_SUBJECT` ni
  `mailto:` ni `https:`). Les messages
  citent le nom de la variable, jamais sa valeur.
- **Développement / test** : valeurs de repli non secrètes (ports locaux 5433 / 6380 / 1026) ; les
  secrets absents ou factices sont générés aléatoirement à chaque démarrage, avec un avertissement
  (les sessions ne survivent donc pas à un redémarrage tant qu'aucun secret n'est fourni).
- Tests e2e de l'API (`pnpm nx e2e api-e2e`) : l'API construite est lancée par Jest (`apps/api-e2e/src/support/
  api-server.ts`) sur le port 3200 avec `ANALYSIS_FIXTURES=1`, `JOBS_TEST_TRIGGER=1`, `PUSH_PROVIDER=fake`,
  `ALERT_EMAIL_BATCH_DELAY_S=1`, `ALERT_COOLDOWN_MINUTES=0`, `BULLMQ_PREFIX=raijin-e2e` ; journal dans
  `dist/api-e2e/api.log`.
- Phase 6 bis : en production, l'API refuse aussi de démarrer si `TOTP_ENCRYPTION_KEY` est absente, factice ou ne
  décode pas 32 octets, ou si `ANALYTICS_PROVIDER=fake`. Un `GOOGLE_SERVICE_ACCOUNT_JSON` illisible ne bloque pas le
  démarrage : l'admin affiche l'erreur `auth_failed`.
- L'état `configured` / `not_configured` des services (ex-`GET /api/v1/health/config`, public) n'est plus servi que
  par `GET /api/v1/admin/health` (champ `services`), sans aucune valeur (phase 6 bis, mineur M3).

