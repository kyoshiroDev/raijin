# PROGRESS — Raijin Shield

## ACTION REQUISE (vide si rien)
- **Question groupée (section 0 ter)** : quels comptes de `docs/COMPTES.md` existent déjà (domaine OVH, Stripe, Resend, Helius, Google, Zoho, B2, UptimeRobot, Sentry) ? En attendant ta réponse, tout est développé avec les simulations locales (Mailpit, BillingProvider simulé, RPC public + fixtures, Google désactivé).

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
| Helius | — | compte + clé | créer le compte ; dev via RPC public + fixtures |
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
- Plan (architect) : en cours
- Tâches :
- Tests :
- Sécurité :
- Commits :
- Décisions : comptes externes supposés absents tant que l'utilisateur n'a pas répondu (simulations section 0 ter).

## Blocages
(aucun)
