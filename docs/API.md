# API — Raijin Shield (`/api/v1`)

Référence de l'API REST de Raijin, établie depuis le code : contrôleurs NestJS de `libs/api/*` (et
`apps/api/src/app/health.controller.ts`), contrats Zod de `libs/shared/contracts`. En cas d'écart, **le code fait
foi**. Architecture détaillée : `docs/ARCHITECTURE.md` ; sécurité : `docs/SECURITY.md`.

## 1. Généralités

| Élément | Valeur |
|---|---|
| Préfixe | `/api/v1` (`GLOBAL_PREFIX`, `libs/api/core/src/lib/http/setup-app.ts`) |
| Version | `v1` dans le chemin ; une rupture de contrat ouvrirait `/api/v2` (pas de version par en-tête) |
| Format | JSON ; corps limité à **32 ko** (`JSON_BODY_LIMIT`) ; 1 Mo pour le seul webhook Stripe |
| Validation | chaque corps et chaque requête de liste passent par `ZodValidationPipe` avec le schéma du contrat (nommé dans les tableaux ci-dessous) |
| Erreurs | toujours `{ code, message }` (`apiErrorSchema`), `Cache-Control: no-store`, **jamais de stack en production** (ajoutée en dev pour les 500 seulement) |
| Documentation interactive | Swagger UI sur **`/api/v1/docs`** (JSON : `/api/v1/docs-json`) **hors production uniquement** (`swaggerEnabled = !isProduction`) ; absente en production |
| Maintenance | `MAINTENANCE_MODE=1` : toutes les routes sauf `/api/v1/health…` répondent **503 `MAINTENANCE`** avec `Retry-After: 300` |

Le produit est en **lecture seule on-chain** : aucune route ne signe, n'envoie de transaction ni ne propose de swap.
Les verdicts ne sont pas un conseil en investissement.

## 2. Authentification et sessions

### 2.1 Cookies

Tous `HttpOnly`, `SameSite=Lax`, sans `Domain`, `Secure` quand `COOKIE_SECURE=true` (production) :

| Rôle | Nom en production | Nom en dev (http://localhost) | Chemin |
|---|---|---|---|
| Access token (JWT, `JWT_ACCESS_TTL`, 15 min par défaut) | `__Host-rj_at` | `rj_at` | `/` |
| Refresh token opaque (`JWT_REFRESH_TTL`, 30 j par défaut) | `__Secure-rj_rt` | `rj_rt` | `/api/v1/auth` uniquement |
| Jeton CSRF | `__Host-rj_csrf` | `rj_csrf` | `/` |

Aucun jeton de session n'est renvoyé dans un corps de réponse : seul le jeton CSRF l'est (`csrfToken`), pour que le
front le garde en mémoire. Mots de passe hachés en argon2id.

### 2.2 CSRF (double-submit signé)

Garde globale (`CsrfGuard`) sur **POST, PUT, PATCH, DELETE** :

1. en-tête `Origin` présent et compris dans les origines autorisées (`APP_URL`, `LANDING_URL`, `CORS_ORIGINS`) ;
2. en-tête **`X-CSRF-Token`** identique au cookie CSRF ;
3. jeton signé `nonce.HMAC(COOKIE_SECRET, nonce.sid)` : lié à la session courante, ou à « anon » avant connexion.

Refus : **403 `AUTH_CSRF_INVALID`**. Seul le webhook Stripe est exempté (`@SkipCsrf()`, signature à la place).
Le jeton s'obtient par `GET /auth/csrf`, et est renouvelé par chaque réponse qui ouvre ou relit une session.

### 2.3 Refresh rotatif

`POST /auth/refresh` échange le cookie de refresh contre une nouvelle paire (même session ; l'ancien refresh est
marqué utilisé) :

| Cas | Réponse |
|---|---|
| Pas de cookie de refresh | 401 `UNAUTHORIZED` (le front ne retente pas) |
| Refresh valide | 200 `authSessionSchema`, nouveaux cookies |
| Refresh **déjà utilisé il y a moins de 10 s** (`REFRESH_REUSE_GRACE_MS`, refresh concurrent d'un autre onglet) | **409 `CONFLICT`** ; les cookies déjà tournés sont **conservés**, le front rejoue sa requête |
| Refresh déjà utilisé au-delà de la fenêtre (**rejeu**) | session **révoquée**, audit `auth.refresh_reuse_detected`, 401 `AUTH_SESSION_EXPIRED`, cookies effacés |
| Refresh expiré, session révoquée ou expirée | 401 `AUTH_SESSION_EXPIRED`, cookies effacés |
| Compte suspendu | 403 `ACCOUNT_SUSPENDED`, session révoquée |

### 2.4 Gardes

- **`AuthGuard`** (« session » ci-dessous) : cookie d'access absent → 401 `UNAUTHORIZED` ; invalide, expiré ou
  session révoquée → 401 `AUTH_SESSION_EXPIRED` (le front tente alors un refresh).
- **`OptionalAuthGuard`** (« optionnelle ») : visiteur anonyme accepté, session lue si présente.
- **Plan** : les droits (`Entitlements`) sont **toujours recalculés côté serveur** (`resolvePlanPolicy`) : abonnement
  Pro > essai Pro actif > Pro offert par un admin > Gratuit. Les actions des suivis, du push et du Checkout exigent un
  e-mail vérifié (403 `AUTH_EMAIL_NOT_VERIFIED`).
- **`@AdminRoute()`** : voir §3.10.

## 3. Routes

Légende « Auth » : — = publique ; opt. = session optionnelle ; session ; admin. Les mutations sont toutes soumises
au CSRF (§2.2), sauf mention. Les quotas journaliers se remettent à zéro à minuit **UTC**.

### 3.1 Santé

| Méthode | Chemin | Auth | Réponse | Notes |
|---|---|---|---|---|
| GET | `/health` | — | `{ status: 'ok'\|'degraded', service: 'raijin-api', database: 'up'\|'down' }` | 200, ou 503 si la base ne répond pas ; `no-store` ; servie même en maintenance |

L'état de configuration des services n'est pas public : il est servi par `GET /admin/health`.

### 3.2 Authentification (`/auth`)

Limite renforcée `@AuthThrottle()` (★) : `RATE_LIMIT_AUTH_PER_MINUTE` par IP et par route (10/min en production,
60 en dev/test).

| Méthode | Chemin | Auth | Corps | Réponse | Erreurs principales |
|---|---|---|---|---|---|
| GET | `/auth/csrf` | — | — | 200 `csrfResponseSchema` (pose le cookie CSRF) | — |
| POST | `/auth/register` ★ | — | `registerRequestSchema` (avec attribution UTM `signupAttributionSchema`) | **202** `messageResponseSchema` (réponse identique que l'e-mail existe ou non) | `VALIDATION_ERROR`, `AUTH_PASSWORD_REJECTED` |
| POST | `/auth/verify-email` ★ | — | `verifyEmailRequestSchema` | 200 `authSessionSchema` + cookies | 400 `AUTH_TOKEN_INVALID` |
| POST | `/auth/verify-email/resend` ★ | opt. | `resendVerificationRequestSchema` | 202 `messageResponseSchema` | — |
| POST | `/auth/login` ★ | — | `loginRequestSchema` | 200 `authSessionSchema` + cookies | `AUTH_INVALID_CREDENTIALS` (aussi en cas de verrouillage, `AUTH_LOCKOUT_THRESHOLD` échecs), 403 `ACCOUNT_SUSPENDED` |
| POST | `/auth/refresh` | cookie de refresh | — | 200 `authSessionSchema` + cookies | voir §2.3 |
| POST | `/auth/logout` | — | — | **204** ; cookies effacés, nouveau jeton CSRF anonyme | — (idempotent) |
| GET | `/auth/session` | opt. | — | 200 `sessionStateSchema` (`{ authenticated: false }` sans cookie) | 401 `AUTH_SESSION_EXPIRED` si seul le refresh est présent |
| POST | `/auth/magic-link` ★ | — | `magicLinkRequestSchema` | 202 `messageResponseSchema` | — |
| POST | `/auth/magic-link/verify` ★ | — | `magicLinkVerifyRequestSchema` | 200 `magicLinkSessionSchema` (+ `redirectPath`) + cookies | `AUTH_TOKEN_INVALID`, 403 `ACCOUNT_SUSPENDED` |
| POST | `/auth/password/forgot` ★ | — | `forgotPasswordRequestSchema` | 202 `messageResponseSchema` (sans énumération) | — |
| POST | `/auth/password/reset` ★ | — | `resetPasswordRequestSchema` | 204 ; toutes les sessions révoquées, cookies effacés | `AUTH_TOKEN_INVALID`, `AUTH_PASSWORD_REJECTED` |
| POST | `/auth/password/change` ★ | session | `changePasswordRequestSchema` | 204 ; les autres sessions sont révoquées | 400 `AUTH_INVALID_CREDENTIALS`, `AUTH_PASSWORD_REJECTED` |

Les codes d'auth sont volontairement peu bavards : aucun ne révèle si un e-mail possède un compte.

### 3.3 Compte (`/users`)

| Méthode | Chemin | Auth | Corps | Réponse | Notes |
|---|---|---|---|---|---|
| GET | `/users/me` | session | — | 200 `publicUserSchema` | — |
| GET | `/users/me/export` ★ | session | — | 200 JSON en pièce jointe `raijin-export.json` (RGPD) | `no-store` |
| DELETE | `/users/me` ★ | session | `deleteAccountRequestSchema` (mot de passe) | 204, cookies effacés ; abonnement Stripe clos | 400 `AUTH_INVALID_CREDENTIALS` |

### 3.4 Analyses (`/analyses`)

Limite renforcée `@AnalysisThrottle()` : `RATE_LIMIT_ANALYSIS_PER_MINUTE` par IP (10/min en production), en plus du
quota journalier.

| Méthode | Chemin | Auth | Corps | Réponse | Erreurs |
|---|---|---|---|---|---|
| POST | `/analyses` | opt. | `analysisRequestSchema` (mint ou lien) | 200 `analysisResponseSchema` ; en-tête `Server-Timing: analysis;dur=…` ; `no-store` | 400 `MINT_INVALID`, 404 `TOKEN_NOT_FOUND`, 422 `TOKEN_UNANALYZABLE`, **429 `QUOTA_EXCEEDED`**, 429 `RATE_LIMITED`, 503 `UPSTREAM_UNAVAILABLE` |
| GET | `/analyses/quota` | opt. | — | 200 `quotaInfoSchema` (restant aujourd'hui) | — |
| GET | `/analyses/:mint/latest` | — | — | 200 `analysisResultSchema` (dernière analyse de moins de 24 h, sans quota) ; `public, max-age=30` | 400 `MINT_INVALID`, 404 `ANALYSIS_NOT_FOUND` |

Quotas d'analyses par jour (défauts du catalogue `PUBLIC_PLAN_CATALOG`, surchargeables par l'environnement) :
anonyme **3** (par empreinte d'IP, `ANON_ANALYSIS_DAILY_LIMIT`), Gratuit **5** (`FREE_ANALYSIS_DAILY_LIMIT`), essai
Pro **50** (`TRIAL_ANALYSIS_DAILY_LIMIT`), Pro **illimité**. Les analyses en échec ont leur propre plafond
(`ANALYSIS_FAILED_DAILY_LIMIT`, `ANALYSIS_UPSTREAM_FAILED_DAILY_LIMIT`).

### 3.5 Scan de wallet (`/wallet-scans`)

| Méthode | Chemin | Auth | Corps | Réponse | Erreurs |
|---|---|---|---|---|---|
| POST | `/wallet-scans` | session, **Pro ou essai Pro** | `walletScanRequestSchema` (`{ address }`, **jamais dans l'URL**) | 200 `walletScanResponseSchema` ; `no-store` | 403 `WALLET_SCAN_PLAN_REQUIRED`, 400 `WALLET_INVALID`, 422 `WALLET_IS_TOKEN`, 422 `WALLET_TOO_LARGE` (> `WALLET_SCAN_MAX_ACCOUNTS`), 429 `WALLET_SCAN_QUOTA_EXCEEDED`, 429 `RATE_LIMITED`, 503 `UPSTREAM_UNAVAILABLE` |
| GET | `/wallet-scans/quota` | session | — | 200 `walletScanQuotaResponseSchema` | — |

Ordre des contrôles : session → plan → schéma. Quota : Pro **20**/jour, essai **10**/jour, Gratuit 0
(`WALLET_SCAN_DAILY_LIMIT_PRO`, `WALLET_SCAN_DAILY_LIMIT_TRIAL`) ; débit `RATE_LIMIT_WALLET_SCAN_PER_MINUTE` **par
utilisateur** (5/min en production).

### 3.6 Suivis (`/watches`)

| Méthode | Chemin | Auth | Corps | Réponse | Erreurs |
|---|---|---|---|---|---|
| GET | `/watches` | session | — | 200 `watchListResponseSchema` (suivis, dernier verdict, `planLimitsSchema`) | — |
| POST | `/watches` | session, e-mail vérifié | `watchCreateRequestSchema` | **201** `watchSchema` (200 si déjà suivi) | 403 `WATCH_LIMIT_REACHED`, 404 `ANALYSIS_NOT_FOUND` (token non analysé depuis 24 h), 403 `AUTH_EMAIL_NOT_VERIFIED` |
| POST | `/watches/keep` | session | `watchKeepRequestSchema` | 200 `watchListResponseSchema` (les autres passent en pause, jamais supprimés) | 400 `WATCH_KEEP_INVALID` |
| PATCH | `/watches/:id` | session | `watchUpdateRequestSchema` (pause / reprise) | 200 `watchSchema` | 404 `WATCH_NOT_FOUND`, 403 `WATCH_LIMIT_REACHED` |
| DELETE | `/watches/:id` | session | — | 204 | 404 `WATCH_NOT_FOUND` |

`:id` est un UUID ; tout autre format donne 404 `WATCH_NOT_FOUND` (aucun indice d'existence). Suivis actifs : Gratuit
**3**, Pro et essai **50** (`FREE_WATCH_LIMIT`, `PRO_WATCH_LIMIT`).

### 3.7 Alertes, notifications et push

| Méthode | Chemin | Auth | Corps / requête | Réponse | Erreurs |
|---|---|---|---|---|---|
| GET | `/alerts` | session | `alertListQuerySchema` (curseur, lu/non lu, types, mint) | 200 `alertListResponseSchema` | `VALIDATION_ERROR` |
| GET | `/alerts/unread-count` | session | — | 200 `alertUnreadCountSchema` | — |
| POST | `/alerts/read` | session | `alertReadRequestSchema` | 200 `alertUnreadCountSchema` | `VALIDATION_ERROR` |
| GET | `/notifications/settings` | session | — | 200 `notificationSettingsSchema` | — |
| PATCH | `/notifications/preferences` | session | `notificationPreferencesUpdateSchema` | 200 `notificationSettingsSchema` | 403 `PUSH_PLAN_REQUIRED` (push réservé au Pro et à l'essai) |
| GET | `/push/vapid-public-key` | — | — | 200 `vapidPublicKeyResponseSchema` ; `public, max-age=3600` | 503 `PUSH_NOT_SUPPORTED` (clés VAPID absentes) |
| POST | `/push/subscriptions` | session, Pro ou essai | `pushSubscriptionRequestSchema` | **201** `pushSubscriptionResponseSchema` | 400 `PUSH_SUBSCRIPTION_INVALID`, 403 `PUSH_PLAN_REQUIRED` |
| POST | `/push/unsubscribe` | session | `pushUnsubscribeRequestSchema` | 204 | 400 `PUSH_SUBSCRIPTION_INVALID` |

Historique des alertes conservé 30 jours (Gratuit) ou 90 jours (Pro, essai) ; e-mails d'alerte plafonnés par jour
(`ALERT_EMAIL_DAILY_MAX`).

### 3.8 Abonnement (`/billing`)

| Méthode | Chemin | Auth | Corps | Réponse | Erreurs |
|---|---|---|---|---|---|
| GET | `/billing/plans` | — | — | 200 `billingPlansResponseSchema` (plans, droits, prix en centimes TTC, mode test / réel) ; `public, max-age=300` | — |
| GET | `/billing/subscription` | session | — | 200 `billingAccountSchema` (plan effectif, abonnement, essai, disponibilité Checkout / portail) | — |
| POST | `/billing/checkout-sessions` | session, e-mail vérifié | `checkoutSessionRequestSchema` (**périodicité seulement**, `month` ou `year`) | 200 `billingRedirectSchema` | 409 `ALREADY_SUBSCRIBED`, 503 `BILLING_NOT_CONFIGURED`, 403 `AUTH_EMAIL_NOT_VERIFIED` |
| POST | `/billing/portal-sessions` | session | — | 200 `billingRedirectSchema` (portail Stripe : gestion, résiliation, factures) | 409 `NO_BILLING_ACCOUNT`, 503 `BILLING_NOT_CONFIGURED` |
| POST | `/billing/webhook` | **signature Stripe**, sans CSRF | corps brut | 200 `{ received: true }` | 400 `BILLING_WEBHOOK_INVALID` |
| POST | `/billing/simulation/checkout` | session, **simulation seulement** | `fakeCheckoutCompleteRequestSchema` | 200 `billingAccountSchema` | 404 hors `BILLING_PROVIDER=fake` |
| POST | `/billing/simulation/portal` | session, **simulation seulement** | `fakePortalActionRequestSchema` | 200 `billingAccountSchema` | 404 hors `BILLING_PROVIDER=fake` |

Le prix n'est jamais envoyé par le front : le serveur choisit l'identifiant de prix Stripe d'après la périodicité.
Prix de référence du Pro : **14,90 €/mois** ou **149 €/an** (TTC) ; la source à lire par les clients est
`GET /billing/plans`. Checkout et portail : `RATE_LIMIT_BILLING_PER_MINUTE` par utilisateur (10/min par défaut).
Les routes de simulation répondent 404 (comme une route inexistante) dès que le fournisseur n'est pas le faux
Stripe ; `BILLING_PROVIDER=fake` est refusé en production.

#### Webhook Stripe

- Chemin : `POST /api/v1/billing/webhook` ; corps lu **brut** (`billingWebhookRawBody`, monté avant le parseur JSON,
  1 Mo au plus) car la signature porte sur les octets exacts.
- Signature : en-tête `Stripe-Signature` vérifié par `Stripe.webhooks.constructEvent` avec `STRIPE_WEBHOOK_SECRET`
  et une tolérance de **300 s** ; mode test / réel de l'événement contrôlé. Échec : 400 `BILLING_WEBHOOK_INVALID`.
- Idempotence transactionnelle : l'identifiant d'événement (`StripeEvent`) est inséré dans la même transaction que
  ses effets ; un doublon est ignoré, une erreur provoque un rollback et un 500 pour que Stripe réessaie.
- L'état de l'abonnement est **relu chez Stripe** ; un événement plus ancien que le dernier appliqué est ignoré.
  Seul ce webhook écrit `Subscription` et `User.plan` (jamais la page de succès du Checkout).
- Événements traités : `checkout.session.completed`, `customer.subscription.*`, `invoice.paid`,
  `invoice.payment_failed`.

### 3.9 Essai Pro (`/trial`)

| Méthode | Chemin | Auth | Réponse | Erreurs |
|---|---|---|---|---|
| GET | `/trial/recap` | session | 200 `trialRecapSchema` (analyses, alertes, tokens Danger, suivis) | 404 `TRIAL_NOT_FOUND` |
| POST | `/trial/end-screen/seen` | session | 204 (l'écran de fin d'essai ne réapparaît plus) | — |

Durée de l'essai : 7 jours (`TRIAL_DAYS`).

### 3.10 Espace admin (`/admin`)

Chaque contrôleur porte `@AdminRoute()` = `AuthGuard` + `AdminGuard` :

1. rôle **relu en base** ; compte non ADMIN ou suspendu → **404 `NOT_FOUND`** (espace invisible) ;
2. débit `RATE_LIMIT_ADMIN_PER_MINUTE` par utilisateur (120/min par défaut) → 429 `RATE_LIMITED` ;
3. 2FA TOTP non activée → 403 `ADMIN_2FA_ENROLLMENT_REQUIRED` ;
4. session admin non vérifiée → 403 `ADMIN_2FA_REQUIRED` ; inactivité (`ADMIN_SESSION_IDLE_MINUTES`, 30) ou durée
   maximale (`ADMIN_SESSION_MAX_HOURS`, 8) dépassée → 403 `ADMIN_SESSION_EXPIRED`.

Codes en 403, jamais 401 : la session de l'app reste valide. Toutes les réponses sont `no-store`.

| Méthode | Chemin | Étape | Corps / requête | Réponse |
|---|---|---|---|---|
| GET | `/admin/security/status` | rôle seul | — | `adminSecurityStatusSchema` |
| POST | `/admin/security/enrollment` | rôle seul | — | `adminEnrollmentStartSchema` (QR code, secret) ; 409 `ADMIN_2FA_ALREADY_ENROLLED` |
| POST | `/admin/security/enrollment/confirm` ★ | rôle seul | `adminEnrollmentConfirmRequestSchema` (code + mot de passe) | `adminEnrollmentConfirmResponseSchema` (10 codes de secours, une seule fois) ; 409 `ADMIN_2FA_ENROLLMENT_EXPIRED`, 400 `ADMIN_2FA_INVALID` |
| POST | `/admin/security/verify` ★ | 2FA activée | `adminVerifyRequestSchema` (TOTP ou code de secours) | `adminSecurityStatusSchema` ; 400 `ADMIN_2FA_INVALID`, 429 `ADMIN_2FA_LOCKED` |
| POST | `/admin/security/recovery-codes` ★ | complète (code TOTP frais exigé) | `adminRegenerateRecoveryCodesRequestSchema` | `adminRecoveryCodesSchema` |
| POST | `/admin/security/end` | rôle seul | — | 204 (quitte l'espace admin) |
| GET | `/admin/overview` | complète | `adminRangeQuerySchema` | `adminOverviewSchema` |
| GET | `/admin/traffic` | complète | `adminRangeQuerySchema` | `adminTrafficSchema` (GA4, cache 1 h) |
| GET | `/admin/seo` | complète | `adminSeoQuerySchema` | `adminSeoSchema` (Search Console) |
| GET | `/admin/acquisition` | complète | `adminAcquisitionQuerySchema` | `adminAcquisitionSchema` (UTM) |
| GET | `/admin/revenue` | complète | `adminRangeQuerySchema` | `adminRevenueSchema` |
| GET | `/admin/trials` | complète | — | `adminTrialsSchema` |
| GET | `/admin/trial-conversion` | complète | — | `trialConversionReportSchema` |
| GET | `/admin/product` | complète | `adminRangeQuerySchema` | `adminProductSchema` |
| GET | `/admin/health` | complète | — | `adminHealthSchema` (jobs, quotas des API externes, services configurés) |
| GET | `/admin/users` | complète | `adminUserListQuerySchema` | `adminUserPageSchema` (recherche par e-mail auditée) |
| GET | `/admin/users/:id` | complète | `:id` UUID (sinon 404) | `adminUserDetailSchema` (consultation auditée) |
| POST | `/admin/users/:id/actions` | complète | `adminUserActionRequestSchema` (e-mail recopié pour confirmer) | `adminUserActionResultSchema` ; 409 `ADMIN_ACTION_NOT_ALLOWED`, 400 `ADMIN_CONFIRMATION_MISMATCH` |
| GET | `/admin/audit-logs` | complète | `adminAuditLogQuerySchema` | `adminAuditLogPageSchema` |

### 3.11 Page publique `/t/<mint>` et image Open Graph

Routes hors Swagger (`@ApiExcludeController`), sans session :

| Méthode | Chemin | Réponse |
|---|---|---|
| GET | `/share/t/:mint` | 200 `text/html` : document de l'app avec balises Open Graph et Twitter du dernier verdict ; `Cache-Control: public, max-age=60` ; CSP propre à la page (`sharePageCsp` : `default-src 'self'`, `script-src 'self'`, `img-src`/`connect-src` vers l'API, `frame-ancestors 'none'`) |
| GET | `/og/:mint.png` | 200 `image/png` (1200 × 630) du verdict, image générique si le mint est invalide ou inconnu ; `ETag` + 304 sur `If-None-Match` ; `public, max-age=600` ; `Cross-Origin-Resource-Policy: cross-origin` (robots des réseaux sociaux) |

En production, Traefik réécrit `https://app.raijinshield.com/t/<mint>` vers `/api/v1/share/t/<mint>`
(`infra/docker-compose.yml`, middleware `raijin-share-rewrite`).

### 3.12 Routes internes réservées aux tests

Hors Swagger, actives **seulement** avec `JOBS_TEST_TRIGGER=1` **hors production** ; la configuration refuse
`JOBS_TEST_TRIGGER` en production (échec du démarrage) et chaque route vérifie de nouveau à chaque requête : sinon
**404 `NOT_FOUND`**, comme une route inexistante. Elles restent soumises au CSRF.

| Méthode | Chemin | Rôle |
|---|---|---|
| POST | `/internal/jobs/:name/run` | exécute un job tout de suite (`{ mints? }` pour les passes de suivi) |
| POST | `/internal/fixtures/:scenario` | étape d'un scénario de fixtures (`{ step }`, `ANALYSIS_FIXTURES=1`) |
| GET | `/internal/push/outbox` | notifications du push simulé (`PUSH_PROVIDER=fake`) |
| POST | `/internal/trial/tick` | job de fin d'essai à un instant simulé (`{ now, userId? }`) |
| POST | `/internal/admin/age-session` | vieillit la session admin courante (`{ minutes }`, session requise) |
| POST | `/internal/billing/webhook-fixtures/:name` | rejoue un événement Stripe de fixture, signé à la volée, par le chemin du webhook |
| POST | `/internal/billing/fake-failures/:operation` | fait échouer la prochaine opération du faux Stripe (`cancel`, `deleteCustomer`) |
| GET | `/internal/billing/fake-customers?id=` | état d'un client du faux Stripe |

Le contrôleur `internal/billing` n'est même pas enregistré hors de ce mode.

## 4. Limites de débit

Throttler NestJS, stockage Redis partagé (repli en mémoire si Redis est indisponible, journalisé). Clé : IP réelle
(selon `TRUST_PROXY`, obligatoire en production), **IPv6 regroupée par /64**. Dépassement : **429 `RATE_LIMITED`**.

| Limite | Portée | Variable | Défaut |
|---|---|---|---|
| Globale | toutes les routes, par IP | `RATE_LIMIT_PER_MINUTE` | 120/min |
| Auth (★) | par IP et par route | `RATE_LIMIT_AUTH_PER_MINUTE` | 10/min en production, 60 en dev |
| Analyse | `POST /analyses`, par IP | `RATE_LIMIT_ANALYSIS_PER_MINUTE` | 10/min en production, 60 en dev |
| Scan de wallet | par utilisateur | `RATE_LIMIT_WALLET_SCAN_PER_MINUTE` | 5/min en production, 60 en dev |
| Abonnement | Checkout, portail, simulation, par utilisateur | `RATE_LIMIT_BILLING_PER_MINUTE` | 10/min |
| Admin | `admin/*`, par utilisateur | `RATE_LIMIT_ADMIN_PER_MINUTE` | 120/min |

Les quotas métier (analyses, scans, suivis, push) sont décrits route par route ci-dessus ; ils sont vérifiés **côté
serveur** à chaque requête.

## 5. Codes d'erreur

Liste fermée `apiErrorCodeSchema` (`libs/shared/contracts/src/lib/error.ts`) :

| Famille | Codes |
|---|---|
| Génériques | `VALIDATION_ERROR` (400, 413, 415), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404, 405), `CONFLICT` (409), `RATE_LIMITED` (429), `QUOTA_EXCEEDED` (429), `UPSTREAM_UNAVAILABLE` (503), `INTERNAL_ERROR` (500), `MAINTENANCE` (503) |
| Auth | `AUTH_INVALID_CREDENTIALS`, `AUTH_EMAIL_NOT_VERIFIED`, `AUTH_TOKEN_INVALID`, `AUTH_SESSION_EXPIRED`, `AUTH_CSRF_INVALID`, `AUTH_PASSWORD_REJECTED`, `AUTH_ACCOUNT_LOCKED` (réservé, plus renvoyé) |
| Analyse | `MINT_INVALID`, `TOKEN_NOT_FOUND`, `TOKEN_UNANALYZABLE`, `ANALYSIS_NOT_FOUND` |
| Suivis, alertes, push | `WATCH_LIMIT_REACHED`, `WATCH_NOT_FOUND`, `ALERT_NOT_FOUND`, `PUSH_NOT_SUPPORTED`, `PUSH_PLAN_REQUIRED`, `PUSH_SUBSCRIPTION_INVALID`, `WATCH_KEEP_INVALID` |
| Wallet | `WALLET_INVALID`, `WALLET_IS_TOKEN`, `WALLET_SCAN_PLAN_REQUIRED`, `WALLET_TOO_LARGE`, `WALLET_SCAN_QUOTA_EXCEEDED` |
| Abonnement, essai | `BILLING_NOT_CONFIGURED`, `ALREADY_SUBSCRIBED`, `NO_BILLING_ACCOUNT`, `BILLING_WEBHOOK_INVALID`, `TRIAL_NOT_FOUND` |
| Admin | `ADMIN_2FA_ENROLLMENT_REQUIRED`, `ADMIN_2FA_REQUIRED`, `ADMIN_SESSION_EXPIRED`, `ADMIN_2FA_INVALID`, `ADMIN_2FA_LOCKED`, `ADMIN_2FA_ALREADY_ENROLLED`, `ADMIN_2FA_ENROLLMENT_EXPIRED`, `ADMIN_ACTION_NOT_ALLOWED`, `ADMIN_CONFIRMATION_MISMATCH`, `ACCOUNT_SUSPENDED` |

Les messages sont en français, au ton neutre ; le front peut les afficher tels quels. Les erreurs inattendues sont
journalisées côté serveur (secrets et URL de connexion masqués) et rendues en 500 `INTERNAL_ERROR`.

## 6. En-têtes de sécurité

Posés par `setupApp` (Helmet) sur toutes les réponses JSON :

- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` (désactivée hors production quand Swagger
  est servi ; la page `/share/t/:mint` porte sa propre CSP) ;
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` en production ;
- `Cross-Origin-Resource-Policy: same-site` (sauf l'image OG : `cross-origin`) ;
- `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options`, et les autres défauts de
  Helmet ; `X-Powered-By` retiré ;
- **CORS strict** : seules les origines autorisées (`APP_URL`, `LANDING_URL`, `CORS_ORIGINS`), `credentials: true`,
  méthodes `GET, HEAD, POST, PUT, PATCH, DELETE`, en-têtes `Content-Type` et `X-CSRF-Token`, `max-age` 600 s ;
- `Cache-Control: no-store` sur les erreurs et les réponses personnelles ; cache public court explicite sur les
  routes publiques (plans, dernière analyse, page et image de partage, clé VAPID).

## 7. API du banc de test (privée)

`apps/raijin-banc-de-test-api` expose une API distincte, préfixe **`/api`** (et non `/api/v1`), base
`raijin_bench` séparée. Elle est **privée** : un seul compte, le propriétaire (`BENCH_OWNER_EMAIL`), sans
inscription ni mot de passe oublié (gestion par la CLI du conteneur). Connexion `POST /api/auth/login` par mot de
passe argon2id + TOTP (10/min par IP, `Origin` contrôlé), puis `GET /api/auth/session` et `POST /api/auth/logout` ;
toutes les autres routes exigent cette session (cookies httpOnly, CSRF double-submit), et le flux temps réel passe
par SSE (`GET /api/events`). Inventaire des routes, jobs et tables : **`docs/BENCH.md`**.
