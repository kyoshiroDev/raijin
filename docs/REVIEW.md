VERDICT : REFUSÉ

# Relecture finale : Raijin Shield (final-reviewer, tour 8)

Relecture indépendante du 2026-11-28, branche `dev`, **commit `73394a1`** (arbre propre, identique à `origin/dev`). Cahier des charges : `PROMPT.md`. Le relecteur n'a modifié aucune ligne de code ; il n'a écrit que ce fichier.

## Correction exigée (liste exacte)

1. **Tags Nx manquants sur `web-e2e`** (PROMPT §1 « Tags et frontières sur chaque projet : `scope:…` et `type:…` »). Le graphe Nx (`nx graph --file=…json`, 44 projets) montre que `web-e2e` est le **seul** projet sans aucun tag (`"tags": []`) ; `apps/web-e2e/project.json` n'a pas de clé `tags`. Conséquence : `@nx/enforce-module-boundaries` ne lui applique aucune contrainte (il pourrait importer `scope:bench` ou `scope:api` sans que le lint échoue), alors que `api-e2e` (`scope:api`, `type:app`) et `raijin-banc-de-test-e2e` (`scope:bench`, `type:app`) sont étiquetés. À faire : ajouter `"tags": ["scope:web", "type:app"]` dans `apps/web-e2e/project.json` (il n'importe aujourd'hui que `@raijin/shared-contracts`, autorisé), puis `nx run-many -t lint typecheck` vert. Responsables : `architect`, puis `test-e2e`.

## Points EN ATTENTE (compte manquant ou action de mise en ligne de l'utilisateur)

Ces points ne bloquent pas le verdict : la simulation existe, elle est testée et le branchement est documenté. À reprendre dans le corps de la PR.

| Point | Simulation testée | Branchement documenté |
|---|---|---|
| Resend : e-mail de test reçu, `RESEND_API_KEY`, `BENCH_RESEND_API_KEY` (compte non créé) | `SmtpMailer` vers Mailpit ; api-e2e 72/72 (run 46089306532) ; captures `docs/screenshots/phase-10/email-*` | `docs/DEPLOY.md`, `docs/ENV.md`, `docs/SECRETS-CHECKLIST.md` l. 13, 72 |
| B2, UptimeRobot, Sentry, profils sociaux (comptes non créés, phase 8 ter) | sauvegarde et restauration (`infra/ci/test-restore.sh`) | `docs/DEPLOY.md`, `docs/COMPTES.md`, `SECRETS-CHECKLIST.md` l. 20, 73 |
| Google : GA4 en temps réel, sitemap dans Search Console (après mise en ligne de la landing) | `landing.consent.spec.ts`, `libs/api/analytics` (données simulées) | `docs/DEPLOY.md` partie B, `docs/OPS-LOG.md` |
| Secrets générés au déploiement (VPS) et secrets GitHub du déploiement continu (`SECRETS-CHECKLIST.md` l. 26-31, 43-46, 63-71 ; l. 71 `BENCH_JUP_API_KEY` facultative) | valeurs factices en CI (`infra/ci/fake-env.sh`), `test-vps-setup.sh` | `docs/SECRETS-CHECKLIST.md`, `docs/DEPLOY.md` C2-C5 |
| Pages légales : médiateur de la consommation et régime de TVA (décision de l'utilisateur) | composant `LegalTodo` | `docs/DEPLOY.md` |

## Corrections du tour 7 : vérification

| Correction exigée au tour 7 | Statut | Preuve |
|---|---|---|
| 1. Mots collés sur la landing | OK | `ea56c9b` : `{' '}` et `&nbsp;:` dans `cgu.astro`, `confidentialite.astro`, `comment-ca-marche.astro`, SIREN/SIRET en `whitespace-nowrap` ; intégration de build `frenchTypography` (`astro.config.mjs`, espaces insécables, body seulement, hors `script`/`code`/attributs) ; détecteur `src/lib/glued-words.ts` + spec, test par page dans `dist.spec.ts`. **Relancé par le relecteur** (Node 24.14 de `.nvmrc`) : `nx run-many -t lint typecheck test build -p landing --skip-nx-cache` vert, 15 fichiers, 158 tests. HTML construit vérifié : « France (voir », « les <a href="/mentions-legales"> », « contact&nbsp;: <a href="mailto: », « </a>, <a href="/guides/mint-authority"> », « mint authority</a> et », « assistance : ». Captures relues : `landing-cgu-390`, `landing-confidentialite-390`, `landing-mentions-legales-320`, `landing-comment-ca-marche-390` : texte correct |
| 2. Audit de `a10220e` et `9e28d50` consigné | OK | `docs/PROGRESS.md` dernière ligne « Audit 7 » : 0 critique, 0 important, 2 mineurs acceptés |

`73394a1` (après l'audit 7) ne touche que `.gitleaksignore` et `REVIEW.md`. Les 4 empreintes ajoutées ont été relues une à une : `REVIEW.md:47` (préfixes `sk_live_`/`sk_test_` et clés factices des specs), `radar-profiles.json:185,191` (adresses publiques de contrats EVM `0x…` de la fixture DexScreener ; le commentaire dit « mint Solana », imprécis mais sans effet), `http_client.spec.ts:12` (`FAKE_KEY = 'abcd1234-…'`). Aucun vrai secret masqué.

## Tableau point par point

| # | Point | Statut | Preuve |
|---|---|---|---|
| 1.1 | §4.1 Analyse (base58, liens, 9 contrôles sourcés, verdict déterministe, cache 60 s, file à débit limité, `/t/<mint>`, OG) | OK | `libs/shared/util`, `libs/api/solana`, `libs/shared/risk-engine`, `docs/SCORING.md`, `libs/api/analysis`, `libs/web/feature-analyse` ; `analysis.e2e`, `analysis.flow` verts (run 46089306532) ; `analyse-prudence-390` relue (verdict icône + mot, 9 contrôles icône + statut, analyse partielle signalée) |
| 1.2 | §4.2 Suivis, alertes push/e-mail, écran Alertes, 404, maintenance | OK | `libs/api/alerts`, `libs/web/feature-suivis` ; `watches.e2e`, `watch.flow` verts ; `suivis-rempli-1024` relue (cartes de même hauteur, badges icône + mot) |
| 1.3 | §4.3 Scan de wallet en lecture seule, délégations | OK | `libs/api/wallet`, `libs/web/feature-wallet`, `wallet.e2e`, `wallet.flow` ; aucun `signTransaction`/`sendTransaction`/`sendRawTransaction` dans `apps/` et `libs/` ; Jupiter limité à `/swap/v1/quote` (`libs/api/solana/src/lib/clients/jupiter.ts`) |
| 1.4 | §4.4 Auth, plans en config, Stripe idempotent, RGPD | OK | `libs/api/auth`, `libs/api/billing`, `auth.e2e`, `billing.e2e`, `billing.flow` verts ; paiement test réel `stripe-live-test.spec.ts`, captures `stripe-test/*` |
| 1.5 | §4.5 Landing (pages, guides, SEO, mention légale) | OK | `apps/landing/src/pages`, `dist.spec.ts` (158 tests verts), `landing.pages.spec.ts` vert ; `landing-accueil-320/1440` relues (hero avec Rai, 3 verdicts, 9 contrôles, démo, tarifs, FAQ, CTA, mention légale en pied) |
| 2.1 | `nx run-many -t lint typecheck test build` | OK | CI push `73394a1` (run 46085663994) : `NX_BASE=4b825dc…` (arbre vide) donc tous les projets : « Successfully ran targets lint, typecheck, test, build for 44 projects and 3 tasks they depend on ». Relance locale complète non faite (machine partagée, charge 13 sur 8 cœurs) ; relance locale de `landing` verte (ci-dessus). L'échec du run 46082604110 (`ea56c9b`) était gitleaks, corrigé par `73394a1` |
| 2.2 | e2e web, API, banc ; responsive ; axe | OK | **Lancé par le relecteur** sur `73394a1` (run 46089306532) : responsive-1 425, responsive-2 424, visuel 236, parcours 43, reste 84 (1 instable passé au 2e essai, 2 ignorés), api-e2e 72/72, banc 79 ; tous les jobs verts |
| 2.3 | Lighthouse mobile ≥ 95 | OK | **Lancé par le relecteur** (run 46088698706, médiane de 3) : `/analyse` 98, `/analyse/<BONK>` 95 (94/95/95), `/t/<BONK>` 100, landing `/`, `/tarifs`, guide 100 ; Access., BP, SEO 100 partout ; « Tous les scores ≥ 95 » |
| 2.4 | Images Docker de production | OK | **Lancé par le relecteur** (run 46087718530) : vert |
| 3.1 | Captures de chaque page aux 5 largeurs | OK | `phase-7` : 13 pages × 5 largeurs (inventaire complet) ; `phase-9` : 377 captures, chaque écran en 320/390/768/1024/1440 (seul `public-statique` en 2, complété par `phase-10`) |
| 3.2 | Élégance des captures relues | OK | relues : `landing-cgu-390`, `landing-confidentialite-390`, `landing-mentions-legales-320`, `landing-comment-ca-marche-390`, `landing-accueil-320`, `landing-accueil-1440`, `landing-accueil-banniere-390`, `analyse-prudence-390`, `suivis-rempli-1024`, `admin-ecran-utilisateurs-390`, `fin-essai-390` : aucun débordement, aucun mot collé, hiérarchie nette |
| 4.1 | Aucune couleur en dur | OK | grep `#hex` (apps/web, apps/landing, banc, libs/web) : seulement `theme-color`, le bloc de jetons du banc (`apps/raijin-banc-de-test/src/styles.css`) et la fixture de QR code noir/blanc |
| 4.2 | Aucune taille en dur | OK | aucune valeur arbitraire `-[NNpx|rem|em]` ni `style="…px"` |
| 4.3 | Une action jaune par écran | OK | test « un seul bouton thunder par écran » (suite visuelle verte) ; app : `analyse-prudence-390` (« Analyser » seul), `fin-essai-390` (« Garder Pro » seul) ; landing : un jaune par section visible (hero « Analyser », carte Pro, CTA final) |
| 4.4 | Verdicts icône + mot | OK | `verdict-badge.ts`, `VerdictBadge.astro` ; captures relues |
| 4.5 | Rai aux bons endroits | OK | hero landing, fin d'essai (bravo), états vides/erreurs, 404 ; jamais à la place d'un verdict ; absent du banc et de l'admin |
| 5.1 | Dernier rapport security-reviewer soldé | OK | Audit 7 (`PROGRESS.md`) : 0 critique, 0 important ; mineurs acceptés et consignés ; changements postérieurs (`ea56c9b` texte de la landing, `73394a1` `.gitleaksignore`) relus par le relecteur, sans impact de sécurité |
| 5.2 | Secrets dans le dépôt et l'historique | OK | **gitleaks v8.30.1 lancé par le relecteur sur tout l'historique** (329 commits, image locale, `--network none`) : « no leaks found » ; `git log --all -p` + grep (`sk_live_`/`sk_test_`, `rk_`, `whsec_`, `re_…`, `AIza`, `BEGIN PRIVATE KEY`, `ghp_`, `xox`, affectations `*_KEY/SECRET/TOKEN=`) : uniquement des valeurs factices de tests ; seul `.env.example` a jamais été suivi |
| 6 | Essai Pro 7 j, 50/j, retour en Gratuit avec suivis en pause, anti-abus, 3 e-mails, aucune urgence | OK | `apps/api-e2e/src/api/trial.e2e.spec.ts` (domaine jetable l. 141, message neutre, pause des suivis), `libs/api/trial`, `trial.flow.spec.ts` ; `fin-essai-390` sans compte à rebours |
| 6 ter | Admin et suivi d'audience | OK | `admin-security.e2e.spec.ts` (anonyme 404 l. 105, admin sans 2FA 403 `ADMIN_2FA_ENROLLMENT_REQUIRED` l. 135-138) ; `landing.consent.spec.ts` (aucun `_ga` avant choix l. 51, « Tout refuser » l. 43-56) ; `landing-accueil-banniere-390` : « Tout refuser » et « Tout accepter » de même style côte à côte ; UTM `auth.service.ts:84` ; `admin-ecran-utilisateurs-390` lisible |
| 6 quater | Banc et VPS | OK | builds verts (run 46085663994) ; aucune dépendance `supabase` dans les `package.json` ni `@supabase` dans le code ; `docs/BENCH.md` §2-§12 (inventaire, mort non porté, bench-migrate, ombre, bascule, retour arrière) ; `infra/ci/test-bench-migrate.sh` ; e2e banc 79 verts ; aucun projet hors `scope:bench` n'importe `@raijin/bench*` (grep) ; `docker-compose.yml` : aucun `ports:`, `mem_limit` sur les 9 services, réseau Traefik `external: true`, basicAuth et `X-Robots-Tag: noindex` sur le banc |
| 6 quinquies | Services | OK | `OPS-LOG.md` ; secrets des comptes existants cochés ; Stripe test de bout en bout ; Resend, B2, UptimeRobot, Sentry EN ATTENTE |
| 6 bis | Juridique | OK | grep des mots interdits et promesses de gain : rien (seules occurrences de « garantie » = déni de garantie) ; mention légale en pied et sur les tarifs ; aucune signature ni swap |
| 7 | Nx : frontières, alias, apps fines, CI | **KO** | `@nx/enforce-module-boundaries` actif (`eslint.config.mjs`), alias `@raijin/...`, aucun import relatif entre projets, apps Raijin fines (api 134 l., web 441 l.), `.github/workflows/ci.yml` présent. **Mais `web-e2e` n'a aucun tag** (voir correction 1) |
| 8 | Docs | OK | `README.md`, `docs/DEPLOY.md`, `docs/SECURITY.md`, `docs/SCORING.md`, `docs/BENCH.md`, `docs/API.md`, `docs/ENV.md`, `.env.example` suivi (non lu, règle de refus) |

Remarques non bloquantes : `/analyse/<BONK>` est à la limite (médiane 95, un passage à 94) ; commentaire « mint Solana » de `.gitleaksignore` à corriger en « contrats EVM » ; la machine locale a Node 22.23.2 par défaut alors que `package.json` exige `>=22.23.4` (`.nvmrc` : 24.14.0) ; le front du banc garde 8 671 lignes dans l'app (import de l'ancien scanner, logique pure dans `libs/bench/web-logic`).
