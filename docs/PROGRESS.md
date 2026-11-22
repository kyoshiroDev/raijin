# PROGRESS — Raijin Shield

## ACTION REQUISE (vide si rien)
- Comptes existants (réponse du 2026-11-21) : **Helius uniquement**. Les autres services restent en simulation locale (Mailpit, BillingProvider simulé, Google désactivé).
- **Helius : clés à copier dans ton `.env`** (https://dashboard.helius.dev → API Keys → bouton copier) : ligne « raijin-api » → `HELIUS_API_KEY` ; ligne « raijin-banc-de-test » → `BENCH_HELIUS_API_KEY`. Coche ensuite `docs/SECRETS-CHECKLIST.md`.
- **Question Helius** : la clé existante « Raijin » (créée le 21/11) a été utilisée le 22/11 vers 1 h 15 : sert-elle à l'ancien scanner en production ? (on n'y touche pas). Veux-tu renommer le projet auto-nommé « Singerrag » en « raijin » ? La clé inutilisée « Llamasage » peut être supprimée par toi si tu veux.

- **`.env.example` à créer par toi** : les permissions de Claude Code (règle `Read(./.env.*)`) empêchent aussi d'écrire ce fichier. Le modèle complet (variables commentées avec l'URL où les obtenir) est dans `docs/ENV.md`. Deux options : lancer `cp` du bloc de `docs/ENV.md` vers `.env.example`, ou ajouter dans `.claude/settings.json` une règle `allow` `Write(./.env.example)` (c'est à toi de décider de modifier les permissions).

## Statut : phase 1 ter — Services en mode test via Chrome — en cours (phases 1 et 1 bis terminées)

## Compréhension et plan (10 lignes)
1. Raijin Shield : SaaS anti-rug pour memecoins Solana ; on colle un mint, on obtient Sain / Prudence / Danger, sourcé et déterministe.
2. Lecture seule on-chain : aucune signature, aucun swap, aucune promesse de gain, « pas un conseil en investissement ».
3. Monorepo Nx + pnpm : `apps/web` (Angular zoneless, PWA), `apps/api` (NestJS 11, Prisma, Postgres 17), `apps/landing` (Astro 5), banc de test (front + API).
4. Libs par scope/type avec frontières ESLint bloquantes ; `libs/shared/risk-engine` pur, partagé Raijin ↔ banc ; aucun projet Raijin ne dépend de `scope:bench`.
5. Charte : thème sombre, jaune `thunder` unique, verdict = icône + mot, mobile first 320 → 1920 px, mascotte Rai (3 poses).
6. Fonctions : analyse (9 contrôles), suivis + alertes (push VAPID, e-mail), scan de wallet, auth cookies httpOnly, plans Gratuit/Pro + essai 7 j sans carte, Stripe.
7. Admin (2FA, 9 écrans, GA4 Data API, Search Console), landing SEO + GA4 Consent Mode v2, attribution UTM.
8. Banc : import de l'ancien scanner (1 bis), portage Supabase → VPS (8 bis), mesure de justesse des verdicts (7 bis).
9. Infra VPS derrière le Traefik existant, sans toucher MTC / XMR ; `deploy.sh` et `bench-migrate.sh` lancés par l'utilisateur seulement.
10. Boucle par phase : architect → agents en parallèle → test-e2e → security-reviewer → commit sur `dev` ; à la fin, final-reviewer puis PR `dev → main` (jamais mergée par moi).

## À brancher (service · prêt · manque · comment l'activer)
| Service | Prêt | Manque | Comment l'activer |
|---|---|---|---|
| Domaine raijinshield.com | — | achat OVH (utilisateur) | acheter, puis phase 8 ter (DNS via ops-chrome) |
| Stripe | — | compte (mode test) | créer le compte, puis phase 1 ter |
| Resend | — | compte + domaine | créer le compte ; dev via Mailpit |
| Helius | compte (plan Free : 1 M crédits/mois, RPC 10 req/s, DAS 2 req/s, partagés entre les 2 clés) ; clés « raijin-api » et « raijin-banc-de-test » créées | copie des clés dans `.env` par l'utilisateur ; restriction IP du VPS | copier les clés ; phase 8 ter : API Keys → Access control (IP/CIDR du VPS) |
| Google (GA4, GSC, Cloud) | — | compte dédié | créer le compte ; services désactivés sans variables |
| Zoho, B2, UptimeRobot, Sentry | — | comptes | avant la mise en ligne (phase 8 ter) |

## Journal des phases

### Phase 1 ter — Services en mode test via Chrome — terminée pour Helius (2026-11-22)
- Comptes disponibles : Helius seulement. Stripe, Resend, Google : reportés (« À brancher »), à reprendre dès que les comptes existent.
- Tâches : [x] Helius : clés « raijin-api » (nommée ainsi pour ne pas confondre avec la clé existante « Raijin ») et « raijin-banc-de-test », sans restriction pour l'instant (ops-chrome) · [x] `docs/SECRETS-CHECKLIST.md`, `docs/OPS-LOG.md`
- Décisions : URL RPC `https://mainnet.helius-rpc.com/?api-key=…` → ne jamais journaliser l'URL complète ; quota 10 req/s partagé entre API Raijin et banc (à répartir dans le rate limiter, phase 3). Variable `BENCH_HELIUS_API_KEY` à ajouter à docs/ENV.md (bench-quant, phase 8 bis).


### Phase 2 — API et auth — planifiée
- Plan (architect, 2026-11-22) : décisions dans `docs/ARCHITECTURE.md` §8 (Prisma, socle, Mailer, cookies, CSRF, URLs, infra de dev). Contrats posés dans `libs/shared/contracts/src/lib/auth/` + `error.ts` (codes `AUTH_*`). Libs générées : `api-prisma` (`libs/api/prisma`, `scope:api`/`type:data-access`) et `api-core` (`libs/api/core`, `scope:api`/`type:util`), vides. `docker-compose.dev.yml` (Postgres 17, Redis 8, Mailpit) + cibles `api:dev-infra` / `api:dev-infra-stop`. `docs/ENV.md` : `COOKIE_SECURE`, `EMAIL_VERIFY_TTL`, `PASSWORD_RESET_TTL`, `MAGIC_LINK_TTL`, `TRUST_PROXY` ajoutées ; `JWT_REFRESH_SECRET` retirée (refresh opaque haché).
- Contrats disponibles (`@raijin/shared-contracts`) : `registerRequestSchema`, `loginRequestSchema`, `magicLinkRequestSchema`, `magicLinkVerifyRequestSchema`, `verifyEmailRequestSchema`, `resendVerificationRequestSchema`, `forgotPasswordRequestSchema`, `resetPasswordRequestSchema`, `changePasswordRequestSchema`, `signupAttributionSchema`, `publicUserSchema` (plan `FREE|PRO`, rôle `USER|ADMIN`, `trial {status none|active|ended|ineligible, startedAt, endsAt}`, `emailVerified`), `authSessionSchema` (`user`, `accessTokenExpiresAt`, `csrfToken`), `csrfResponseSchema`, `messageResponseSchema`, `CSRF_HEADER`, `PASSWORD_RULES`/`PASSWORD_HINT`, `AUTH_ERROR_CODES`/`AUTH_ERROR_MESSAGES`, `relativePathSchema`, `emailSchema`. Toute évolution passe par architect.
- Routes cibles (`/api/v1`) : `GET auth/csrf` · `POST auth/register` (202) · `POST auth/login` · `POST auth/logout` (204) · `POST auth/refresh` · `GET auth/session` · `POST auth/verify-email` · `POST auth/verify-email/resend` (202) · `POST auth/magic-link` (202) · `POST auth/magic-link/verify` · `POST auth/password/forgot` (202) · `POST auth/password/reset` (204) · `POST auth/password/change` (204) · `GET users/me` (`PublicUser`) · `GET health`.
- Tâches (ordre et parallélisme) :
  - [ ] **T1 — Infra dev + Prisma** (nestjs-api) : dépendances (Prisma, adaptateur pg, argon2…) avec chaque script d'installation tranché dans `allowBuilds` ; `schema.prisma` du modèle §8.1, première migration, cible `api-prisma:prisma-generate` câblée en `dependsOn` (CI sans étape manuelle), `PrismaService`. Périmètre : `libs/api/prisma`, `nx.json`, `package.json`, `pnpm-workspace.yaml`. Préalable à T3/T4.
  - [ ] **T2 — Socle HTTP et sécurité** (nestjs-api, parallèle à T1) : `libs/api/core` (config Zod des variables, filtre `{code, message}` sans stack hors dev, pipe Zod, Helmet, CORS `CORS_ORIGINS` + credentials, throttler global Redis + renforcé auth, garde CSRF §8.5, cookies §8.4, `trust proxy`) ; `apps/api/src/main.ts` aminci, **suppression du `new Function` (M3)**, M6 traité ; `GET /health`. Swagger en dev seulement.
  - [ ] **T3 — Mailer** (nestjs-api, parallèle à T1/T2) : `libs/api/notifications` : `Mailer` abstrait, `SmtpMailer` (Mailpit), `ResendMailer` (fetch, sans SDK si possible), templates vérification / reset / lien magique / bienvenue / « compte existant » (HTML thème clair + texte, logo, couleurs depuis `libs/brand/tokens.json`), mention « pas un conseil en investissement » en pied.
  - [ ] **T4 — Auth et users** (nestjs-api, après T1 + T2 + T3) : `libs/api/auth` (argon2id, inscription neutre, connexion + verrouillage, refresh rotatif avec détection de réutilisation, logout, jetons e-mail hachés à usage unique, lien magique, reset, changement, normalisation `emailNormalized`, attribution UTM enregistrée, `AuditLog`), `libs/api/users` (`GET users/me` → `PublicUser`, `trial.status = none` tant que la phase 6 n'est pas faite). Couverture ≥ 80 % sur `api-auth`. Tests e2e `apps/api-e2e` contre Postgres + Mailpit du compose (lecture des liens via l'API Mailpit).
  - [ ] **T5 — Front auth** (ui-mobile-first, **parallèle à T1–T4** dès maintenant, sur les contrats) : `libs/web/data-access` (client auth : `AuthStore` signals, `csrfToken` en mémoire, intercepteur `X-CSRF-Token` + `withCredentials`, refresh automatique sur `AUTH_SESSION_EXPIRED`/401 une seule fois, capture UTM à la première visite), `libs/web/feature-compte` (écrans connexion, inscription + règles du mot de passe, « vérifie ta boîte », vérification d'e-mail, mot de passe oublié, réinitialisation, lien magique demande + atterrissage, compte : profil, plan, changement de mot de passe, déconnexion), garde de route, `apps/web/proxy.conf.json` (`/api` → `http://localhost:3000`). Validation des formulaires avec les schémas Zod des contrats, messages `AUTH_ERROR_MESSAGES`. Mobile first 320 → 1440, tokens uniquement, cibles ≥ 44 px. Tests Vitest avec `HttpTestingController` (aucune API réelle nécessaire).
  - [ ] **T6 — Tests** (test-e2e, après T4 + T5) : `run-many -t lint typecheck test build` ; `api-e2e` (parcours complet via Mailpit) ; Playwright des écrans d'auth (responsive 320/390/768/1024/1440, axe, clavier, captures sombres dans `docs/screenshots/phase-2/`, e-mails en clair depuis Mailpit).
  - [ ] **T7 — Audit** (security-reviewer, après T6) : OWASP auth (énumération, brute force, fixation, CSRF, redirection ouverte, jetons), cookies, en-têtes, rate limiting, M3/M6 clos, secrets, `allowBuilds`.
- Dépendances : T1 ∥ T2 ∥ T3 ∥ T5 → T4 (après T1, T2, T3) → T6 → T7. T5 se branche sur l'API réelle une fois T4 livré (aucun changement de contrat attendu).
- Tests :
- Sécurité :
- Commits :
- Décisions : voir `docs/ARCHITECTURE.md` §8. Refresh opaque haché (pas de JWT), CSRF double-submit signé avec jeton en mémoire côté front (pas de cookie lisible inter-sous-domaines), proxy dev Angular (même origine en local), enums `Plan`/`Role` en majuscules identiques Prisma ↔ contrats, mot de passe NIST (12 à 128 caractères, sans règle de composition), CGU acceptées explicitement à l'inscription (`acceptTerms: true`).

### Phase 0 — Amorçage — terminée (2026-11-21)
- Garde-fou dossier : OK (kit seul : CLAUDE.md, PROMPT.md, README.md, .claude/, libs/brand/, docs/). `raijin-old` présent (lecture seule) : phase 1 bis possible.
- Outils : node v22.23.2, pnpm 11.6.0 (corepack), git 2.43.0, docker compose v2.35.1, gh 2.45.0.
- GitHub : connecté (`kyoshiroDev`). Aucun dépôt `raijin` préexistant, `raijin-old` local sans remote : aucun renommage nécessaire.
- Git local : `git init -b main`, `.gitignore` (secrets, builds, caches), commit `ea411f0 chore: kit de départ Raijin Shield`.
- Distant : https://github.com/kyoshiroDev/raijin (privé), `main` et `dev` poussées ; travail sur `dev`. Pas de protection de branche (offre payante) : `main` protégée par `.claude/settings.json`.

### Phase 1 — Socle — terminée (2026-11-22)
- Plan (architect) : socle Nx 24 « integrated » (pnpm, sans Nx Cloud, alias `@raijin/*` dans `tsconfig.base.json`), 21 projets taggés (dont `brand`) `scope:*`/`type:*`, frontières bloquantes dans `eslint.config.mjs`, cibles lint/typecheck/test/build en cache, Tailwind 4 branché sur `libs/brand/tokens.css` via un thème unique `libs/web/ui/src/styles/theme.css`, PWA de base, route `/_design` (dev seulement, placeholder dans `libs/web/ui`), contrats Zod initiaux (`libs/shared/contracts` : adresse Solana/mint/wallet, `Verdict`, `CheckStatus`, `ApiError {code, message}`) et utilitaires (`libs/shared/util` : base58, `truncateMiddle`, montants compacts fr-FR), CI GitHub, `docs/ARCHITECTURE.md`, `docs/ENV.md`, `docs/graph.html`. Détail : `docs/ARCHITECTURE.md`.
- Tâches :
  - [x] Workspace Nx, projets, tags, frontières, CI, thème Tailwind, PWA, contrats et utilitaires de base (architect)
  - [ ] Créer `.env.example` racine à partir du bloc de `docs/ENV.md` (bloqué pour les agents par la règle deny `.env.*` de `.claude/settings.json` : à faire par l'utilisateur ou l'orchestrateur)
  - [x] Composants de base dans `libs/web/ui` + page `/_design` remplie, tous états : Button, VerdictBadge, Card, Input + bouton Coller, AddressChip, BottomSheet, TabBar, Sidebar, Skeleton, EmptyState, Toast ; coquille de navigation (TabBar < 1024 px, Sidebar ≥ 1024 px) (ui-mobile-first). Contrats à utiliser : `Verdict`/`VERDICT_LABELS` (`@raijin/shared-contracts`), `truncateMiddle`/`formatCompactAmount` (`@raijin/shared-util`). Uniquement les utilitaires générés par les tokens (les palettes Tailwind par défaut sont désactivées).
  - [x] Tests : `run-many -t lint typecheck test build`, Playwright responsive de `/_design` (320 → 1920, sans scroll horizontal, cibles ≥ 44 px), axe, captures dans `docs/screenshots/phase-1/` (test-e2e)
  - [x] Audit de sécurité du socle (CI, dépendances, `.gitignore`, aucune donnée sensible) (security-reviewer)
- Tests : run-many lint/typecheck/test/build vert (22 projets) ; couverture shared-util 100 % lignes / 91 % branches, shared-contracts 100 %. e2e (commit `464c284`) : 93/125, 32 échecs dus à 3 défauts web-ui (nom accessible du lien logo, cible logo 25,6 px à 320 px, line-clamp sans title) → corrigés par ui-mobile-first (`61d83b5`, bordures de contrôles ≥ 3:1 via `--color-line-strong`). **Revalidation : e2e 125/125** (responsive 9 largeurs + paysage, axe 0 violation, clavier, captures `docs/screenshots/phase-1/` relues), run-many vert 22 projets. Délai axe 90 s, workers 1 en CI / 3 en local.
- Sécurité : audit 1 + 1 bis : 0 critique, 1 important, 6 mineurs. I1 Astro 5 vulnérable → Astro 7.4.13 (corrigé, `9153bab`, écart assumé avec « Astro 5 » de PROMPT.md) ; `pnpm audit` 39 alertes → 3 modérées transitives d'outillage. M1 Nx 24.0.6 (undici 7.30.1), M2 actions épinglées par SHA + Dependabot : corrigés. M5 longueur du collage (maxlength 256) : corrigé. **Réaudit : aucun point critique ou important ouvert** (I1, M1, M2, M5 vérifiés). M7 (mineur) : 3 alertes modérées transitives d'outillage (uuid, glob, minimatch via Nx/Jest/webpack-dev-server), à suivre avec les montées de Nx. Planifiés : M3 `new Function` dans apps/api/src/main.ts → phase 2 (nestjs-api) ; M4 référence projet Supabase dans legacy/vercel.json → phase 8 bis (bench-quant) ; M6 Helmet/CORS/throttler → phase 2, CSP/HSTS Traefik → phase 8. Conforme : aucun secret dans l'historique, banc isolé, allowBuilds minimal.
- Commits : `22e75fd` socle Nx · `6731ad1` import du banc (1 bis) · `4f00f97` composants + /_design
- Décisions : Astro 7.4 exige Node ≥ 22.23.4 : `.nvmrc` = 24.14.0 (déjà installé via nvm). Les commandes locales tournent avec `PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"` (on ne change pas le Node par défaut de la machine, utilisé par d'autres projets). CI : Node 22 dernière version.
- Décisions : icônes via `lucide` (lucide-angular incompatible Angular 22) ; graphe Nx non commité (6 Mo, régénérable).
- Décisions : `.env.example` : chaque variable précédée d'un commentaire avec le service et l'URL de la page où l'obtenir (ou la commande pour la générer), groupée par service (demande utilisateur, à appliquer à chaque nouvelle variable).
- Décisions : comptes externes : seul Helius existe (réponse utilisateur) ; le reste en simulation (section 0 ter).

### Phase 1 bis — Banc de test, import — terminée (2026-11-22)
- Tests et sécurité : build/lint/test du banc verts (758 tests), inclus dans le run-many global et dans l'audit de la phase 1 (aucun secret, banc isolé). Commit `6731ad1`.
- Tâches :
  - [x] Front de `raijin-old` copié dans `apps/raijin-banc-de-test/` (src, public, ngsw-config.json ; 242 fichiers, 1,7 Mo), `supabase/` dans `legacy/supabase/` (1,9 Mo), plus `legacy/scripts/`, `legacy/docs/`, `legacy/vercel.json` en référence (`legacy/README.md`). Exclus : `.git`, `node_modules`, `.env*`, `.secrets/`, `dist`, `.angular`, `supabase/.temp`, `supabase/.branches`, `*.local.sql`, `src/environments/environment.ts` (généré, contenait la config réelle). Dépôt d'origine non modifié. (bench-quant)
  - [x] Projet Nx `raijin-banc-de-test` (tags `scope:bench`, `type:app`) : lint, typecheck, test (Vitest via `@angular/build:unit-test`), build (`@angular/build:application`, service worker en prod), serve (port 4300), `write-env`. `legacy/` n'est pas un projet Nx (`.nxignore`, `.prettierignore`). (bench-quant)
  - [x] Dépendances ajoutées : `@angular/service-worker@~22.2.0` (22.2.7), `@supabase/supabase-js@^2.119.0` (2.119.2, transitoire jusqu'à la phase 8 bis). Aucune 2e version d'Angular : le code était déjà en Angular 22 zoneless. (bench-quant)
  - [x] Renommage « Raijin-banc-de-test » (title, titres de routes, manifest `name`, `short_name` « Banc test », meta, textes iOS) ; badge permanent `app-bench-badge` « BANC DE TEST » couleur `warn` dans `PageHeader` (tous les écrans connectés) et sur connexion, mot de passe oublié/réinitialisé, compte ; pas de mascotte ; `<meta name="robots" content="noindex, nofollow, noarchive">` et `public/robots.txt` `Disallow: /` ; mention « pas un conseil en investissement ». (bench-quant)
  - [x] Config Supabase : aucune clé en dur dans les sources versionnées ; `src/environments/environment.ts` versionné avec valeurs factices, config réelle optionnelle via `environment.local.ts` (ignoré par Git) généré par `pnpm nx run raijin-banc-de-test:write-env` (refuse toute clé non publique) et `--configuration=local`. (bench-quant)
- Adaptations : `noUncheckedIndexedAccess: false` au niveau du projet seulement (289 erreurs d'indexation dans le code d'origine, qui ne l'activait pas ; correction reportée au portage pour ne pas toucher au comportement des calculs). Tailwind 4 limité aux sources du banc (`@import "tailwindcss" source(".")`). Thème d'origine conservé (police Inter auto-hébergée, CSP `font-src 'self'`, rayons/tailles différents de `libs/brand`) ; le `warn` du banc est identique au token `warn` de `libs/brand` (vérifié par `bench-badge.spec.ts`). Test `password-rules.spec.ts` : valeurs `[auth]` de `config.toml` figées dans le spec (import relatif vers `legacy/` refusé par `@nx/enforce-module-boundaries`, règle non désactivée). Aucune règle ESLint désactivée.
- Tests : `pnpm nx run-many -t lint typecheck test build -p raijin-banc-de-test` vert (79 fichiers, 758 tests ; build initial 540 ko / 130 ko transférés, sous le budget 1 Mo). Global `run-many -t lint typecheck test build` : tout vert sauf `web-ui:lint` et `web-ui:build` (paquet `lucide` importé mais absent de `libs/web/ui/package.json`, travail en cours de ui-mobile-first, hors banc).
- Points ouverts :
  - [ ] Inventaire `docs/BENCH.md` (Edge Functions, crons, tables, RLS, Realtime, Auth, Vault → équivalent cible) : phase 8 bis.
  - [ ] Sélecteurs `app-` conservés (renommage éventuel au portage) ; `strictTemplates` actif et vert.
  - [ ] `pnpm` signale des avertissements de dépendances pairs (préexistants, à examiner par architect).
  - [ ] Banc en production toujours sur Supabase + Vercel, inchangé (aucun déploiement, aucune commande supabase).

## Blocages
- ~~CI run 44955347320 en échec (`ERR_PNPM_IGNORED_BUILDS`)~~ : levé, `allowBuilds` nx + @swc/core dans pnpm-workspace.yaml.
