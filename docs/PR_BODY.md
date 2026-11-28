# Raijin Shield v1.0

Le bouclier anti-rug des memecoins Solana : on colle l'adresse d'un token, Raijin vérifie les signaux de rug (autorités, liquidité, concentration des détenteurs, taxes, revente…) et rend un verdict clair — **Sain / Prudence / Danger** — avant de signer. Lecture seule on-chain : aucune signature, aucun swap, aucune clé privée. **Pas un conseil en investissement.**

Relecture finale indépendante : **VALIDÉE au tour 9** (`docs/REVIEW.md`, commit `82ff11c`).

## Ce que contient la v1

- **App Angular** (mobile first 320 → 1440, PWA, zoneless) : analyse de token (9 contrôles sourcés, verdict déterministe), page de partage `/t/<mint>` avec verdict statique et images Open Graph, suivis et alertes (e-mail + push), scan de wallet en lecture seule, compte et 2FA admin.
- **Plans** : Gratuit et **Pro à 14,90 € TTC/mois ou 149 € TTC/an**, essai Pro 7 jours sans carte (anti-abus), Stripe Checkout + Customer Portal, webhooks vérifiés et idempotents.
- **API NestJS** (Prisma, Postgres 17, Redis/BullMQ) : auth par cookies `__Host-`, quotas, garde `X-Raijin-Edge` exigé en production, limites par IP et par compte.
- **Espace admin** (2FA obligatoire) : vue d'ensemble, trafic, SEO, acquisition, revenus, essais, utilisateurs, produit, santé ; GA4 Data API et Search Console en lecture seule.
- **Landing Astro** : SEO technique complet, guides, tarifs, pages légales (éditeur renseigné), GA4 avec Consent Mode v2.
- **Raijin-banc-de-test** : mesure de la justesse des verdicts, porté de Supabase vers le VPS (mode ombre et bascule documentés).
- **Infra** : Docker Compose derrière le Traefik existant du VPS, environnements **prod** et **dev** isolés, déploiement continu par GitHub Actions avec porte SSH à commande forcée, contrôle strict des images, retour arrière automatique ; la prod n'est activée que par l'utilisateur sur le VPS (aucune clé capable de déployer la prod dans GitHub). Installation guidée : `bash infra/vps-install.sh`.
- **Outil de variables** : `bash tools/env/organiser-env.sh` (`.env`, `.env.dev`, `.env.prod` rangés, aucune valeur affichée).

## Vérifications (sur `82ff11c`)

| Contrôle | Résultat |
|---|---|
| lint · typecheck · test · build (44 projets) | ✅ CI run 46092471466 |
| e2e (responsive 425+424, visuel 236, parcours 43, reste 83, API 72/72, banc 79) | ✅ run 46094650646 |
| Lighthouse mobile (médiane de 3) | ✅ /analyse 99 · /analyse/&lt;mint&gt; 98 · /t 100 · landing 100 ×3 ; A11y/BP/SEO 100 |
| Images Docker de production + déploiement dev derrière Traefik factice | ✅ run 46093876572 |
| Secrets (gitleaks, historique complet) | ✅ aucune fuite |
| Paiement Stripe de bout en bout (mode test, carte 4242) | ✅ `stripe-live-test.spec.ts` |
| Audits de sécurité 1 à 7 | ✅ aucun critique ni important ouvert (`docs/PROGRESS.md`) |

## En attente (simulation testée, branchement documenté)

- **Resend** (e-mails transactionnels) : compte à créer, `RESEND_API_KEY` / `BENCH_RESEND_API_KEY` ; Mailpit en dev.
- **Backblaze B2** (sauvegardes), **UptimeRobot**, **Sentry**, profils sociaux : comptes à créer.
- **Google** : vérification GA4 en temps réel, sitemap Search Console et événements clés après la mise en ligne de la landing.
- **Secrets générés au déploiement** sur le VPS et secrets GitHub du déploiement continu (`docs/SECRETS-CHECKLIST.md`).
- **Pages légales** : médiateur de la consommation et mention de TVA (décision de l'éditeur).
- **Bot Telegram et radar des nouveaux tokens (v1.1)** : développés et testés sur une branche locale séparée, intégrés après cette PR.

## Pour mettre en ligne (par l'éditeur)

1. Fusionner cette PR dans `main` (Claude ne fusionne jamais).
2. Préparer le VPS : `bash infra/vps-install.sh --check`, puis `bash infra/vps-install.sh` (`docs/DEPLOY.md`, partie C).
3. Créer les secrets GitHub proposés par le script, puis activer le déploiement automatique du dev (`DEPLOY_DEV_AUTO=1`).
4. Activer la prod sur le VPS avec la commande indiquée dans `docs/DEPLOY.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
