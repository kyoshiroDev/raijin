# SECURITY — Raijin Shield

Menaces, parades en place et risques résiduels pour Raijin (app, API, landing) et le Raijin-banc-de-test
(PROMPT.md §8). Chaque parade renvoie au fichier ou au mécanisme qui la porte et au test qui la vérifie ; une
parade absente est écrite comme risque résiduel. Sources : code du dépôt au 2026-11-24 et audits du
`security-reviewer` consignés dans `docs/PROGRESS.md` (sections « Sécurité » des phases 1 à 9). Détails de
conception : `docs/ARCHITECTURE.md` (§8 auth, §9 Solana, §14 admin, §17 banc), déploiement : `docs/DEPLOY.md`.

## Principes

- **Lecture seule** : aucune signature, aucun swap, aucune garde de clé privée, aucune commission. Le scan de
  wallet ne lit que des comptes publics ; la page `/wallet` refuse une phrase de récupération collée.
- **Données externes hostiles** : noms, symboles, URLs de métadonnées et réponses des sources (Helius,
  DexScreener, GeckoTerminal, Jupiter, RugCheck) sont validés par Zod, nettoyés et échappés ; aucune image de
  token n'est stockée ni affichée en v1 (`libs/shared/contracts/src/lib/analysis/token.ts`).
- **Secrets côté serveur seulement**, par variables d'environnement de `raijin-api` et `raijin-bench-api` ; le
  front de l'app et celui du banc n'ont aucune clé (la clé publiable Stripe n'est pas utilisée).
- **Un seul contrat** front/back (`libs/shared/contracts`) : la validation est la même des deux côtés.

## Menaces et parades

### 1. XSS via les métadonnées de tokens (et autres données affichées)
- **Parades** :
  - Nettoyage des textes non fiables (caractères de contrôle, invisibles, contrôles bidirectionnels « Trojan
    Source », longueur bornée) : `libs/shared/util/src/lib/untrusted-text.ts`, appliqué à la collecte
    (`libs/api/solana/src/lib/collect/facts-collector.ts`, `rugcheck-digest.ts`) et avant validation côté front
    (`libs/web/data-access/src/lib/analysis/analysis-shape.ts`, mineur m2 phase 3).
  - URLs externes en `https` absolu, hôte en liste blanche, sans identifiants ni port ni barre oblique inverse :
    `libs/shared/util/src/lib/external-url.ts` (`isAllowedHttpsUrl`), utilisé par
    `libs/web/feature-analyse/src/lib/analysis/check-display.ts` ; liens Phantom/Solflare du wallet en liste
    blanche exacte ; banc : `apps/raijin-banc-de-test/src/app/shared/utils/safe-url.ts`.
  - Rendu Angular échappé par défaut : aucun `innerHTML` ni `bypassSecurityTrust*` dans `apps/web`,
    `libs/web` et `apps/raijin-banc-de-test` (vérifié par recherche). Landing : `set:html` réservé aux SVG
    internes (`RaiMascot.astro`, `Icon.astro`), JSON-LD échappé.
  - Pages HTML produites par l'API : `escapeHtml` des balises OG de `/t/<mint>`
    (`libs/api/analysis/src/lib/share/share-page.service.ts`), image OG par satori (pas de HTML), e-mails
    échappés (`libs/api/notifications/src/lib/templates/*`).
  - CSP stricte posée par Traefik (`infra/docker-compose.yml`, labels `*-headers`) : `script-src 'self'` pour
    l'app et le banc, `default-src 'none'` (Helmet) pour l'API, `object-src 'none'`, `frame-ancestors 'none'`.
- **Tests** : `untrusted-text.spec.ts`, `external-url.spec.ts` (libs/shared/util), `share-page.service.spec.ts`
  (« nom et symbole hostiles : aucune balise injectée »), `check-display.spec.ts`, `analysis-result.spec.ts`,
  `apps/web-e2e/src/analysis.flow.spec.ts` ; job CI `images` (`infra/ci/check-stack.sh`) pour les en-têtes.
- **Risque résiduel** : `style-src 'unsafe-inline'` sur l'app et le banc (styles de composants injectés par
  Angular ; un nonce casserait le cache du service worker, décision phase 8). Une injection CSS reste donc
  possible si un échappement manquait ; `script-src` reste strict.

### 2. CSRF
- **Parades** : jeton double-submit signé `nonce.HMAC(COOKIE_SECRET, nonce.sid)` lié à la session, en en-tête
  `X-CSRF-Token`, gardé **en mémoire** côté front (pas de cookie lisible inter-sous-domaines) :
  `libs/api/core/src/lib/security/csrf.ts` (`CsrfGuard`, global), `libs/web/data-access` (intercepteur) ; cookies
  `SameSite=Lax` ; CORS limité à `CORS_ORIGINS` (HTTPS imposé en prod, `app-config.ts`). Webhook Stripe seul
  exempté (`@SkipCsrf`, protégé par signature). Banc : CSRF `rjb_*` signé lié à la session
  (`libs/bench/core/src/lib/auth/csrf.ts`). Jeton anonyme refusé avec une session (M2 phase 2).
- **Tests** : `libs/api/core/src/lib/security/security.spec.ts` (jeton lié à sa session, autre secret refusé),
  `libs/web/data-access/src/lib/auth/csrf-token.spec.ts`, `apps/api-e2e/src/api/auth.e2e.spec.ts`,
  `libs/bench/core/src/lib/auth/auth.e2e.spec.ts`.
- **Risque résiduel** : le POST d'analyse anonyme exige aussi le jeton (dispense refusée en phase 3) ; aucun
  connu au-delà d'une XSS (qui pourrait lire le jeton en mémoire, voir menace 1).

### 3. Vol ou fixation de session
- **Parades** : cookies `HttpOnly`, `Secure` (imposé en prod), `SameSite=Lax`, tous préfixés `__Host-` en mode
  Secure (`__Host-rj_at`, `__Host-rj_rt`, `__Host-rj_csrf` : `Path=/`, aucun `Domain`, donc non déposables par un
  sous-domaine comme `dev.raijinshield.com`) (`libs/api/core/src/lib/security/cookies.ts`) ; `POST /auth/refresh`
  refuse (401 `AUTH_SESSION_EXPIRED` + effacement) un en-tête `Cookie` qui répète le nom du refresh, et exige que
  le refresh appartienne à la session (`sid`) de l'access signé quand il est présent, sans consommer ni révoquer
  le refresh d'une autre session (`auth.controller.ts`, `SessionService.rotate`) ; migration : l'ancien
  `__Secure-rj_rt` (`Path=/api/v1/auth`) est accepté une dernière fois, seulement lié à un `__Host-rj_at` signé de
  la même session, puis expiré à chaque pose de session ; access JWT 15 min ;
  refresh **opaque haché** en base, rotation à chaque usage, réutilisation hors délai de grâce = révocation de
  toute la famille + audit (`libs/api/auth/src/lib/services/session.service.ts`) ; déconnexion globale au
  changement ou à la réinitialisation du mot de passe, abonnements push supprimés (`49c8904`) ; suspension
  coupe les sessions ; sessions admin 30 min d'inactivité / 8 h max (`admin-session.ts`) ; banc 2 h / 12 h.
- **Tests** : `session.service.spec.ts` (rotation, réutilisation, course, suspension, sid différent),
  `security.spec.ts` (attributs des cookies, nom répété, ancien nom), `auth.controller.spec.ts` (double cookie,
  sid différent, migration depuis `__Secure-rj_rt`), `auth.e2e.spec.ts`, `admin-security.e2e.spec.ts`.
- **Risque résiduel** : réutilisation d'un refresh tolérée < 10 s (onglets concurrents, 409 sans révocation) ;
  pas de liaison de session à l'appareil ou à l'IP.

### 4. Brute force et énumération de comptes
- **Parades** : argon2id (`libs/server/security/src/lib/password.ts`) ; verrouillage après échecs avec
  **tentative réservée avant la vérification** (Lua INCR + PEXPIRE atomiques, clé jamais en clair, n3 phase 9) :
  `libs/api/auth/src/lib/services/login-attempts.service.ts` ; réponse identique avant/après argon2 (I1 phase 2) ;
  inscription, renvoi, lien magique et mot de passe oublié répondent 202 neutre ; `@AuthThrottle` renforcé sur
  l'auth et la 2FA ; 2FA admin TOTP bloquée après 5 essais, compteur incrémenté avant vérification (I1 phase
  6 bis) ; jetons e-mail hachés, à usage unique, invalidant les précédents (`auth-token.service.ts`) ; banc :
  verrou par empreinte d'IP 5 / 15 min + global 50, aucune inscription.
- **Tests** : `login-attempts.service.spec.ts`, `auth.service.spec.ts`, `session.service.spec.ts`
  (`AuthTokenService`), `admin-security.e2e.spec.ts` (rafale 2FA), `auth.e2e.spec.ts`.
- **Risque résiduel** : un tiers peut verrouiller un compte en connaissant son e-mail (accès de secours : lien
  magique) et le verrouillage reste une faible source d'énumération, atténuée par le throttling ; si Redis
  tombe, les compteurs passent en mémoire (correct en mono-instance seulement).

### 5. Abus des quotas et des crédits Helius
- **Parades** : quotas par jour (anonyme 3, Gratuit 5, essai 50 ; scan de wallet Pro 20 / essai 10) réservés
  atomiquement puis remboursés en cas d'échec, avec **plafond quotidien de remboursements**
  (`libs/api/analysis/src/lib/quota/quota.service.ts`) ; identité anonyme = HMAC (`IP_HASH_SECRET`, obligatoire
  en prod) d'une IP regroupée en **/64 pour IPv6** (`libs/api/core/src/lib/security/ip-bucket.ts`, `ip-hash.ts`) ;
  budget de crédits Helius par voie (`analysis`, `watch`, `wallet`) en Lua (`redis-credit-budget.ts`), décompté
  à chaque tentative ; `getMint` (1 crédit) avant la collecte ; compte > 2 Mo arrêté tôt (N1 phase 3) ; cache
  60/300 s, déduplication et verrou par mint ; file de débit et disjoncteur (`upstream-gate.ts`) ; banc : budget
  propre 10 000 crédits/jour, préfixe Redis `raijin-bench:`, ACL Redis séparées.
- **Tests** : `quota.service.spec.ts`, `redis-credit-budget.spec.ts`, `upstream-gate.spec.ts`,
  `throttler.spec.ts` (IPv6 /64), `apps/api-e2e/src/api/analysis.e2e.spec.ts`, `wallet.e2e.spec.ts`.
- **Risque résiduel** : le budget Helius est un plafond **global** ; un attaquant disposant de nombreuses IPv4
  ou /64 peut l'épuiser et dégrader l'analyse pour tous jusqu'au lendemain (pas de captcha ni de preuve de
  travail). Sans clé Helius, repli sur le RPC public plus limité.

### 6. Webhooks Stripe falsifiés ou rejoués
- **Parades** : corps brut + `Stripe.webhooks.constructEvent` avec tolérance d'horodatage, signature bornée
  (`libs/api/billing/src/lib/provider/stripe-billing.provider.ts`) ; événement du mode réel refusé en mode
  test ; idempotence par `StripeEvent` dans la transaction, `lastEventAt` contre le désordre, abonnement relu
  chez Stripe (`billing-webhook.service.ts`) ; `FakeBillingProvider` et rejeu de fixtures refusés en prod.
- **Tests** : `billing-webhook.service.spec.ts` (signature absente/fausse, corps modifié, trop ancien, rejeu,
  ordre inverse), `billing-http.spec.ts`, `apps/api-e2e/src/api/billing.e2e.spec.ts`.
- **Risque résiduel** : jamais testé contre le compte Stripe réel (compte non branché, « À brancher ») ; la
  compromission de `STRIPE_WEBHOOK_SECRET` permettrait de forger des événements, mais l'état est relu chez Stripe.

### 7. Injection SQL
- **Parades** : Prisma paramétré partout (aucun `$queryRawUnsafe`/`$executeRawUnsafe` hors code généré) ; seul
  `Prisma.raw` : noms de table/colonne issus d'une liste de règles codée en dur
  (`libs/api/alerts/src/lib/purge/purge.service.ts`) ; banc : client `BenchDb` compilé en SQL paramétré,
  identifiants filtrés par `^[a-z_][a-z0-9_]{0,62}$` (`libs/bench/engine/src/db/bench-db.ts`) ; entrées
  validées par Zod (`zod-validation.pipe.ts`) ; rôles Postgres séparés `raijin`/`raijin_bench`, CONNECT retiré
  à PUBLIC (`infra/postgres/init`).
- **Tests** : tests de `libs/bench/engine` et `libs/bench/prisma` (isolement raijin ↔ raijin_bench), tests des
  pipes et contrats Zod ; job CI `images`.
- **Risque résiduel** : faible ; aucun test dédié aux charges d'injection sur `BenchDb`.

### 8. SSRF vers les sources externes
- **Parades** : URLs de base des sources fixées par la configuration, jamais issues d'une donnée reçue ; appel
  durci `requestJson` (`redirect: 'error'`, délai par appel, taille de réponse bornée, signal global) :
  `libs/api/solana/src/lib/core/http.ts` ; mints validés en base58 (y compris le mint résolu d'une paire) ;
  aucune URL de métadonnées n'est récupérée (pas d'image) ; endpoints Web Push limités à 4 services connus et
  revalidés avant chaque envoi (`libs/server/push/src/lib/web-push.sender.ts`, `PUSH_SERVICE_HOSTS`) ; la
  landing redirige vers l'app au lieu d'appeler l'API.
- **Tests** : `libs/api/solana/src/lib/core/http.spec.ts` (redirect error, délai, flux interrompu), tests de
  `libs/server/push`, `apps/api-e2e/src/api/watches.e2e.spec.ts`.
- **Risque résiduel** : le code porté du banc (`libs/bench/engine`) passe par `runtimeFetch`
  (`ported/runtime-fetch.ts`, enveloppé par `@raijin/bench-solana` pour le recul sur 429) et n'a pas le même
  durcissement uniforme que `requestJson` (redirections, taille) ; URLs toujours codées en dur.

### 9. Fuite de secrets
- **Parades** : `.gitignore` (`.env`, `.env.*`, `!.env.example`, `.secrets/`) ; `.env.example` à valeurs
  factices ; configuration validée au démarrage, secrets absents, factices ou < longueur minimale **refusés en
  prod** (`libs/api/core/src/lib/config/app-config.ts`, idem `libs/bench/core/src/lib/config`) ; journaux
  expurgés (`libs/server/security/src/lib/redact.ts`, `safeErrorMessage`, mot de passe Redis masqué) ;
  erreurs `{code, message}` sans stack en prod (`api-exception.filter.ts`) ; Swagger en dev seulement ; secret
  TOTP chiffré AES-256-GCM (`secret-box.ts`), codes de secours HMAC ; mots de passe Postgres/Redis par fichiers,
  pgpass en tmpfs (m3 phase 8 bis) ; sauvegardes chiffrées (rclone crypt, `infra/backup.sh`) ; URL Supabase
  saisie masquée et jamais écrite (`infra/bench-migrate.sh`) ; CI sans secret GitHub (valeurs éphémères).
- **Scan de secrets en CI** : job `secrets` de `.github/workflows/ci.yml`, gitleaks v8.30.1 (image officielle
  épinglée par digest, sans réseau, sortie expurgée) sur les commits du push ou de la PR, historique complet si
  la base est inconnue ; bloquant. Exceptions : `.gitleaks.toml` (règles par défaut + adresses Solana publiques
  en base58) et `.gitleaksignore` (empreintes des faux positifs connus de l'historique : clés factices des
  tests, mots de passe Redis d'exemple, jeton JWT forgé du test du banc, exemple `curl` de `docs/BENCH.md`).
- **Tests** : `app-config.spec.ts`, `redact.spec.ts` (api-core et server-security), `throttler.spec.ts`
  (mot de passe jamais journalisé) ; audit phase 1 : aucun secret dans l'historique ; scan gitleaks de
  l'historique local complet (190 commits, 2026-11-24) : seulement des faux positifs, mis en exception.
- **Risque résiduel** : gitleaks ne repère que des motifs connus (un secret sans forme reconnaissable passe) ;
  une valeur ajoutée à `.gitleaksignore` doit être relue ; qui lit `infra/.env.api` sur le VPS obtient tout
  (clé de chiffrement TOTP comprise) : la protection repose sur l'accès au VPS.

### 10. Accès à l'espace admin
- **Parades** : rôle relu en base, `AdminGuard` + `@AdminRoute` ; non-admin et anonyme reçoivent un **404**
  identique sur toutes les variantes de `admin/*`, débit compté avant l'espace admin, `no-store` homogène
  (n1/n2 phase 9) : `libs/api/auth/src/lib/admin-security/admin-area.middleware.ts`, `admin.guard.ts` ; 2FA TOTP
  obligatoire (RFC 6238, 10 codes de secours), confirmation par mot de passe à l'enrôlement ; actions auditées
  (`AuditLog`, purge `AUDIT_LOG_RETENTION_DAYS`) ; création d'admin par CLI seulement (`admin-cli.ts`) ; chunk
  `/admin` chargé en différé derrière une garde (`apps/web/src/app/admin-area.guard.ts`).
- **Tests** : `admin-area.http.spec.ts`, `admin.guard.spec.ts`, `apps/web/src/app/admin-area.guard.spec.ts`,
  `apps/api-e2e/src/api/admin-security.e2e.spec.ts`, `admin-analytics.e2e.spec.ts`, `apps/web-e2e` (admin.flow).
- **Limite de débit propre à l'espace admin** : `AdminAreaMiddleware`
  (`libs/api/auth/src/lib/admin-security/admin-area.middleware.ts:37`) s'exécute avant la garde globale du
  throttler ; il compte donc lui-même chaque requête sur `admin/*` (`RATE_LIMIT_PER_MINUTE` par préfixe d'IP,
  IPv6 regroupée en /64, fenêtre de 60 s, compteur `admin-area` du stockage du throttler) **avant** de lire le
  jeton et la base. Au-delà, il répond 404 `NOT_FOUND` sans lecture en base, **y compris à un admin légitime**,
  jusqu'à la fin de la fenêtre de 60 s. Raison (audit 6 bis n2) : sans ce compteur, un jeton USER ou une rafale
  anonyme déclencherait une lecture en base par requête sans limite ; et répondre 429 au lieu de 404
  révélerait que les routes admin existent.
- **Risque résiduel** : l'admin est servi par la même API publique (pas de restriction réseau ni d'IP) ; un
  admin qui partage son préfixe d'IP avec un client bruyant (NAT, même /64) peut recevoir des 404 pendant 60 s.

### 11. Accès au banc (Raijin-banc-de-test)
- **Parades** : `banc.raijinshield.com` derrière **basicAuth Traefik** (`raijin-bench-auth`, en-tête retiré),
  puis compte propriétaire unique : argon2id + TOTP ou code de secours, sessions 2 h / 12 h, CSRF signé,
  aucune inscription, CLI `create-owner`/`set-password`/`reset-2fa` (`libs/bench/core/src/lib/auth/*`) ; config
  refusée en prod si secret absent ou factice ; débit Traefik 10 req/s ; `X-Robots-Tag: noindex` ; base
  `raijin_bench` et ACL Redis séparées ; aucune clé dans le front du banc ; mode ombre (push, e-mail,
  auto-paper coupés).
- **Tests** : `libs/bench/core/src/lib/auth/auth.e2e.spec.ts`, `apps/raijin-banc-de-test-e2e` (24/24, 0 appel
  réseau), job CI `images` (401 sans basicAuth, ACL Redis dans les deux sens, noindex).
- **Risque résiduel** : la valeur `BENCH_BASIC_AUTH_USERS` est fournie par l'utilisateur ; vide, la première
  barrière disparaît (le compte propriétaire reste exigé).

### 12. IP falsifiée derrière Traefik (`X-Forwarded-For`)
- **Parades** : `TRUST_PROXY` **obligatoire en prod** et égal au nombre exact de proxys (1, Traefik seul : le
  front reste même origine, nginx ne proxifie rien), `app.set('trust proxy', …)`
  (`libs/api/core/src/lib/http/setup-app.ts`, `app-config.ts`, I2 phase 2) ; Traefik remplace les
  `X-Forwarded-*` reçus de clients non approuvés (comportement par défaut).
- **Tests** : `app-config.spec.ts` (TRUST_PROXY requis et borné), `throttler.spec.ts`.
- **Risque résiduel** (`docs/DEPLOY.md` §464-467, M7 phase 8) : un conteneur du réseau Traefik partagé avec
  MyTradingCoach peut joindre l'API sans passer par Traefik et forger `X-Forwarded-For` (contournement des
  limites par IP, pas d'accès aux comptes) ; si l'instance Traefik existante a `forwardedHeaders.insecure`, ou
  si un CDN est ajouté sans ajuster `TRUST_PROXY` et `trustedIPs`, l'en-tête devient falsifiable.

### 13. Chaîne d'approvisionnement
- **Parades** : `pnpm install --frozen-lockfile` en CI ; scripts d'installation refusés par défaut, chaque
  paquet tranché dans `allowBuilds` (`pnpm-workspace.yaml`) ; `overrides` de sécurité justifiés ; actions GitHub
  épinglées par SHA + Dependabot (`.github/dependabot.yml`, M2 phase 1) ; aucune dépendance téléchargée au
  runtime (liste des domaines jetables copiée dans le dépôt) ; contrôle des modules externes de l'image
  (`infra/docker/check-externals.cjs`) ; **`pnpm audit --prod --audit-level=high` bloquant** dans le job
  `verifier` de la CI (section « Dépendances ») ; scan de secrets gitleaks (menace 9).
- **Tests** : CI (install figée, audit des dépendances de production, build des images) ; audits de phase.
- **Risque résiduel** : les vulnérabilités **modérées et basses** de production ne bloquent pas la CI (relevées
  aux audits de phase) ; les dépendances de développement ne sont pas auditées en CI (3 alertes modérées
  d'outillage justifiées ci-dessous) ; l'analyse des images (Trivy, M9 phase 8) n'est pas une étape de CI.

### 14. Déni de service
- **Parades** : throttler NestJS global (Redis, repli mémoire) et renforcé sur l'auth et l'analyse anonyme
  (`libs/api/core/src/lib/throttler/throttler.ts`) ; débit Traefik 20 req/s (rafale 60) par IP sur l'API ;
  corps JSON borné (`setup-app.ts`) ; délais et tailles bornés vers les sources ; arrêt du scan de wallet à
  15 s ; limites mémoire/CPU par conteneur (`mem_limit`, pour protéger MTC) ; Redis `noeviction`,
  `maxmemory 200mb` ; healthchecks et veille (`infra/watchdog.sh`, timers systemd) ; mode maintenance 503.
- **Tests** : `throttler.spec.ts`, `http.spec.ts`, `wallet.e2e.spec.ts`, job CI `images` (démarrage complet).
- **Risque résiduel** : pas de CDN ni de protection volumétrique devant Traefik (M7, hors v1) : une attaque
  réseau saturerait le VPS partagé avec MyTradingCoach ; épuisement du budget Helius (menace 5).

### 15. Données personnelles (RGPD)
- **Parades** : export JSON et suppression du compte (`libs/api/users/src/lib/users.controller.ts`,
  `users.service.ts`) avec résiliation Stripe immédiate et suppression du client Stripe, 503 sans suppression si
  Stripe échoue (I1 phase 6, `account-billing-closer.ts`) ; IP jamais stockée en clair (HMAC) ; adresse de wallet
  **jamais persistée** ni journalisée, cache Redis ≤ 10 min sous clé HMAC sans adresse en clair, jamais dans
  l'URL (`libs/api/wallet`) ; rétentions : analyses et événements 90 j, `TrialFingerprint` 90 j, `AuditLog`
  purgé, purge conditionnée à l'agrégation (`purge.service.ts`) ; GA4 en Consent Mode v2 basique, **aucune
  requête Google avant accord** (bannière CNIL, landing) ; polices auto-hébergées ; attribution en
  `sessionStorage` de premier niveau, mentionnée dans la politique de confidentialité.
- **Tests** : `apps/api-e2e/src/api/auth.e2e.spec.ts` (export, suppression), `wallet.e2e.spec.ts`,
  `apps/web-e2e` (landing.consent), `apps/landing/src/lib/analytics/analytics.spec.ts`, tests de purge
  (`libs/api/alerts`).
- **Risque résiduel** : `TrialClaim` (HMAC de l'e-mail normalisé) gardé 24 mois après suppression, pour
  l'unicité de l'essai (décision phase 6, à mentionner dans la politique) ; mentions légales « À compléter »
  par l'utilisateur ; sauvegardes hors site gardées 30 j (une suppression n'y est effective qu'après ce délai).

### 16. Produit et contenus
- **Parades** : aucune fonction de signature ni de swap ; liens vers les tokens en `jup.ag/tokens/<mint>`
  (m5 phase 8 bis) ; mention « pas un conseil en investissement » sur analyse, `/t`, wallet, abonnement,
  e-mails et landing ; jamais « Sain » si les autorités sont inconnues ou si ≥ 3 contrôles sont indisponibles
  (`docs/SCORING.md`).
- **Tests** : contrôle de textes de la phase 9 (T11), tests du moteur `risk-engine`.
- **Risque résiduel** : un verdict reste une estimation fondée sur des sources tierces (indisponibles ou
  manipulables), ce que l'interface rappelle.

## Risques résiduels prioritaires (synthèse)

1. Pas de CDN ni de protection volumétrique ; API joignable depuis le réseau Traefik partagé (IP forgeable).
2. Budget Helius global épuisable par un attaquant à nombreuses IP (dégradation de l'analyse pour tous).
3. CI : audit bloquant seulement à partir de `high` en production ; pas d'analyse des images (Trivy).
4. `style-src 'unsafe-inline'` sur l'app et le banc.
5. Webhooks et facturation jamais éprouvés contre le compte Stripe réel (« À brancher »).

## Dépendances (`pnpm audit`, `pnpm peers check`)

Relevé du 2026-11-24 (phase 9, T2), Nx 24.0.6, pnpm 11.6.0.

- `pnpm audit --prod` : **0 vulnérabilité** (critère de chaque audit de phase). En CI, `pnpm audit --prod
  --audit-level=high` bloque le job `verifier` dès une vulnérabilité haute ou critique en production.
- `pnpm audit` (dépendances de développement comprises) : 3 alertes **modérées**, toutes transitives d'outillage,
  absentes des images de production (`dist/apps/*/package.json` générés ne les contiennent pas). Aucune n'est
  corrigée en amont à ce jour (dernières versions de Nx, Jest, test-exclude et sockjs vérifiées) ; un `overrides`
  imposerait une version majeure à des dépendances épinglées exactement par Nx. Décision : **justifiées, non
  surchargées**, revues à chaque montée de Nx ou de Jest.

| Alerte | Paquet (chemin) | Pourquoi elle ne s'applique pas |
|---|---|---|
| GHSA-w5hq-g745-h8pq (modérée) | `uuid` 8.3.2 via `@nx/webpack` → `webpack-dev-server` → `sockjs` | Le défaut touche `v3`/`v5`/`v6` appelées avec un tampon `buf` fourni ; `sockjs` n'appelle que `uuid.v4()` sans tampon. `webpack-dev-server` n'est jamais lancé (API servie par `@nx/js:node`, front par `@angular/build`). |
| GHSA-3g3m-2fjr-6pw4 (modérée) | `glob` 10.5.0 / 13.0.7 via `jest-config`, `test-exclude` | Contournement de l'annulation par `AbortSignal` : Jest et la couverture n'utilisent pas de signal, sur des motifs écrits par le projet, en local et en CI. |
| GHSA-g3hv-75wg-m249 (modérée) | `minimatch` 9.0.9 / 10.2.5 via `nx`, `@nx/devkit` (épinglé `10.2.5`), `glob` | Déni de service par des motifs construits par un attaquant : seuls les motifs de configuration du dépôt (`nx.json`, `project.json`, ESLint) sont évalués, jamais une entrée utilisateur. |

Avertissements de dépendances pairs (`pnpm peers check`), tous d'outillage, sans effet à l'exécution :

| Pair attendu | Installé | Demandé par | Décision |
|---|---|---|---|
| `@babel/core` ^7 | 8.0.5 (via `@angular/build` 22) | plugins `@babel/plugin-syntax-*` de `babel-preset-jest` | Jest utilise son propre `@babel/core` 7.29 (présent) ; le 8 sert uniquement à `@angular/build`. Rien à faire. |
| `chokidar` ^4 / ^6 | 5.0.0 | `@angular-devkit/core` 19 (`@nestjs/schematics`) et 22 | Pair **optionnel** (mode surveillance des schematics) ; aucun schematic NestJS lancé en surveillance. |
| `@emnapi/core`, `@emnapi/runtime` ^1.7.1 | 2.0.0-alpha.6 | `@napi-rs/wasm-runtime` 1.2.7 | Repli WebAssembly des binaires natifs, inutilisé sur linux-x64 (binaires natifs présents). |
