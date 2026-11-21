# PROGRESS — Raijin Shield

## ACTION REQUISE (vide si rien)
- Comptes existants (réponse du 2026-11-21) : **Helius uniquement**. Les autres services restent en simulation locale (Mailpit, BillingProvider simulé, Google désactivé).
- **Helius (phase 1 ter)** : ops-chrome créera les clés « raijin » et « raijin-banc-de-test » dans ton tableau de bord Helius ; tu devras copier toi-même la clé dans `.env` (`HELIUS_API_KEY`). Prépare une session Chrome connectée à Helius.

- **`.env.example` à créer par toi** : les permissions de Claude Code (règle `Read(./.env.*)`) empêchent aussi d'écrire ce fichier. Le modèle complet (variables commentées avec l'URL où les obtenir) est dans `docs/ENV.md`. Deux options : lancer `cp` du bloc de `docs/ENV.md` vers `.env.example`, ou ajouter dans `.claude/settings.json` une règle `allow` `Write(./.env.example)` (c'est à toi de décider de modifier les permissions).

## Statut : phase 1 — Socle — en cours

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
| Helius | compte créé | projet + clés (phase 1 ter), clé à copier dans `.env` par l'utilisateur | ops-chrome en phase 1 ter ; en attendant, RPC public + fixtures |
| Google (GA4, GSC, Cloud) | — | compte dédié | créer le compte ; services désactivés sans variables |
| Zoho, B2, UptimeRobot, Sentry | — | comptes | avant la mise en ligne (phase 8 ter) |

## Journal des phases

### Phase 0 — Amorçage — terminée (2026-11-21)
- Garde-fou dossier : OK (kit seul : CLAUDE.md, PROMPT.md, README.md, .claude/, libs/brand/, docs/). `raijin-old` présent (lecture seule) : phase 1 bis possible.
- Outils : node v22.23.2, pnpm 11.6.0 (corepack), git 2.43.0, docker compose v2.35.1, gh 2.45.0.
- GitHub : connecté (`kyoshiroDev`). Aucun dépôt `raijin` préexistant, `raijin-old` local sans remote : aucun renommage nécessaire.
- Git local : `git init -b main`, `.gitignore` (secrets, builds, caches), commit `ea411f0 chore: kit de départ Raijin Shield`.
- Distant : https://github.com/kyoshiroDev/raijin (privé), `main` et `dev` poussées ; travail sur `dev`. Pas de protection de branche (offre payante) : `main` protégée par `.claude/settings.json`.

### Phase 1 — Socle
- Plan (architect) : socle Nx 24 « integrated » (pnpm, sans Nx Cloud, alias `@raijin/*` dans `tsconfig.base.json`), 21 projets taggés (dont `brand`) `scope:*`/`type:*`, frontières bloquantes dans `eslint.config.mjs`, cibles lint/typecheck/test/build en cache, Tailwind 4 branché sur `libs/brand/tokens.css` via un thème unique `libs/web/ui/src/styles/theme.css`, PWA de base, route `/_design` (dev seulement, placeholder dans `libs/web/ui`), contrats Zod initiaux (`libs/shared/contracts` : adresse Solana/mint/wallet, `Verdict`, `CheckStatus`, `ApiError {code, message}`) et utilitaires (`libs/shared/util` : base58, `truncateMiddle`, montants compacts fr-FR), CI GitHub, `docs/ARCHITECTURE.md`, `docs/ENV.md`, `docs/graph.html`. Détail : `docs/ARCHITECTURE.md`.
- Tâches :
  - [x] Workspace Nx, projets, tags, frontières, CI, thème Tailwind, PWA, contrats et utilitaires de base (architect)
  - [ ] Créer `.env.example` racine à partir du bloc de `docs/ENV.md` (bloqué pour les agents par la règle deny `.env.*` de `.claude/settings.json` : à faire par l'utilisateur ou l'orchestrateur)
  - [ ] Composants de base dans `libs/web/ui` + page `/_design` remplie, tous états : Button, VerdictBadge, Card, Input + bouton Coller, AddressChip, BottomSheet, TabBar, Sidebar, Skeleton, EmptyState, Toast ; coquille de navigation (TabBar < 1024 px, Sidebar ≥ 1024 px) (ui-mobile-first). Contrats à utiliser : `Verdict`/`VERDICT_LABELS` (`@raijin/shared-contracts`), `truncateMiddle`/`formatCompactAmount` (`@raijin/shared-util`). Uniquement les utilitaires générés par les tokens (les palettes Tailwind par défaut sont désactivées).
  - [ ] Tests : `run-many -t lint typecheck test build`, Playwright responsive de `/_design` (320 → 1920, sans scroll horizontal, cibles ≥ 44 px), axe, captures dans `docs/screenshots/phase-1/` (test-e2e)
  - [ ] Audit de sécurité du socle (CI, dépendances, `.gitignore`, aucune donnée sensible) (security-reviewer)
- Tests :
- Sécurité :
- Commits :
- Décisions : `.env.example` : chaque variable précédée d'un commentaire avec le service et l'URL de la page où l'obtenir (ou la commande pour la générer), groupée par service (demande utilisateur, à appliquer à chaque nouvelle variable).
- Décisions : comptes externes supposés absents tant que l'utilisateur n'a pas répondu (simulations section 0 ter).

### Phase 1 bis — Banc de test, import
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
- CI run 44955347320 en échec : `ERR_PNPM_IGNORED_BUILDS` (nx, @swc/core) au `pnpm install --frozen-lockfile`. À corriger par architect (allowBuilds dans pnpm-workspace.yaml) après les agents en cours.
(aucun)
