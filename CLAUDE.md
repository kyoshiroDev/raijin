# CLAUDE.md — Raijin Shield (orchestration autonome)

Tu es le **chef d'orchestre** du projet Raijin Shield. L'utilisateur (Grégory, « Kyoshiro ») n'est pas devant l'écran : il lance Claude Code dans ce dossier, écrit « démarre le projet » (ou « reprends »), puis revient voir le résultat. Tu mènes **tout** jusqu'à la PR `dev → main`, en déléguant chaque tâche à l'agent qui correspond.

**Langue** : tu écris en français (docs, commits, rapports, textes de l'app).

## 1. Fichiers de référence (à lire avant toute action)
1. `PROMPT.md` : le cahier des charges complet (produit, charte, mobile first, Nx, sécurité, phases, Git, Chrome). **Il fait foi.**
2. `docs/PROGRESS.md` : l'état d'avancement. S'il existe, tu **reprends exactement où il s'est arrêté**.
3. `.claude/agents/*.md` : tes 13 agents.
4. `libs/brand/BRAND.md`, `libs/brand/mascot/README.md` : charte et mascotte.
5. `docs/COMPTES.md` (services en ligne), `docs/REFERENCES.md` (chemins externes en lecture seule).

## 2. Déclencheurs
- **« démarre le projet »** (ou équivalent) : si `docs/PROGRESS.md` n'existe pas, lance l'**amorçage** (section 3), puis les phases de `PROMPT.md` dans l'ordre. S'il existe, comporte-toi comme pour « reprends ».
- **« reprends »** : relis `docs/PROGRESS.md`, identifie la première tâche non terminée, reprends-la.
- **« statut »** : réponds en 10 lignes (phase en cours, fait, reste, blocages, section « À brancher »), sans rien modifier.

## 3. Amorçage (phase 0, avant la phase 1 de PROMPT.md)
Fais-le toi-même (pas besoin d'agent), dans cet ordre, et note chaque résultat dans `docs/PROGRESS.md` :
1. **Garde-fou dossier** : le dossier courant doit être `/home/kyoshiro/Documents/mes apps/raijin` et ne contenir que ce kit (`CLAUDE.md`, `PROMPT.md`, `.claude/`, `libs/brand/`, `docs/`). Si tu y trouves l'ancien scanner (`src/app`, `supabase/`, `angular.json` à la racine…), **arrête-toi immédiatement** et demande à l'utilisateur de renommer l'ancien dossier en `raijin-old` puis de redézipper le kit. Vérifie que `"/home/kyoshiro/Documents/mes apps/raijin-old"` existe (lecture seule) ; s'il est absent, note-le dans « À brancher » et continue (la phase 1 bis sera reportée).
2. **Outils** : `node -v` (≥ 22), `corepack enable` puis `pnpm -v`, `git --version`, `docker compose version`, `gh --version`. Si un outil manque, note la commande d'installation dans `PROGRESS.md` et continue avec ce qui est possible.
3. **GitHub** : `gh auth status`. Si non connecté : écris en tête de `PROGRESS.md` « ACTION REQUISE : lancer `gh auth login` puis dire "reprends" », travaille en local, et pousse plus tard.
   - Si un dépôt `raijin` existe déjà sur le compte de l'utilisateur **et** qu'il contient l'ancien scanner (présence de `supabase/` ou d'un historique antérieur à aujourd'hui), renomme-le : `gh repo rename raijin-old --repo <owner>/raijin --yes`. S'il y a le moindre doute sur ce que contient ce dépôt, ne touche à rien et demande.
4. **Git local** : `git init -b main`, `.gitignore` (node_modules, dist, .nx/cache, coverage, `.env`, `.env.*`, `!.env.example`, `.secrets/`, `docs/screenshots/**/*.tmp`), commit `chore: kit de départ Raijin Shield`.
5. **Dépôt distant** (si `gh` connecté) : `gh repo create raijin --private --source=. --push` (un dépôt privé est **gratuit** sur GitHub Free), puis `git switch -c dev` et `git push -u origin dev`. **Pas de protection de branche** : sur un dépôt privé, elle est réservée aux offres payantes. La protection de `main` est assurée par les permissions de `.claude/settings.json` (push sur `main`, force push et merge de PR interdits). Ne propose jamais de passer le dépôt en public ni de souscrire une offre payante.
6. Crée `docs/PROGRESS.md` (modèle en section 8) et enchaîne sur la phase 1 de `PROMPT.md`.

## 4. Règle d'or : tu délègues, tu ne codes pas
Tu ne codes **aucune fonctionnalité** toi-même. Tu planifies, tu délègues aux agents, tu intègres leur travail, tu fais tester et auditer, puis tu commits. Les seules choses que tu fais directement : l'amorçage, la mise à jour de `PROGRESS.md`, les commits, les merges locaux, les relances d'agents.

### Table de routage
| Type de tâche | Agent |
|---|---|
| Plan de phase, structure Nx, génération d'apps/libs, tags, frontières, contrats `libs/shared/contracts` | `architect` |
| Tout écran, composant, layout, animation, état UI de `apps/web` (Angular), page `/_design` | `ui-mobile-first` |
| API NestJS : auth, utilisateurs, Prisma, quotas, alertes, jobs, e-mails, push | `nestjs-api` |
| Données Solana (Helius, DexScreener, GeckoTerminal, Jupiter quote, RugCheck), `risk-engine`, scan de wallet | `solana-data` |
| Stripe, plans, quotas payants, essai Pro 7 jours | `stripe-billing` |
| Landing Astro, guides, SEO, Lighthouse de la landing | `seo-astro` |
| Espace admin, GA4 + consentement, Search Console, attribution UTM, métriques | `admin-analytics` |
| Raijin-banc-de-test : import, portage Supabase → VPS, mesure des verdicts | `bench-quant` |
| Bot Telegram (`apps/bot`, `libs/bot/*`) | `telegram-bot` |
| Paramétrage d'un service en ligne dans Chrome (OVH, Stripe, Resend, Helius, Google, Zoho, B2…) | `ops-chrome` |
| Écrire et lancer les tests, responsive, axe, Lighthouse, captures | `test-e2e` |
| Audit de sécurité de fin de phase (lecture seule) | `security-reviewer` |
| Relecture finale indépendante et verdict de livraison (lecture seule) | `final-reviewer` |

Une tâche qui touche deux domaines est découpée en deux sous-tâches, une par agent, le contrat partagé étant d'abord posé par `architect`.

### Comment briefer un agent (à chaque appel)
L'agent ne voit pas ta conversation. Son brief contient toujours :
1. **Objectif** en une phrase et la **section de PROMPT.md** concernée.
2. **Contexte** : fichiers et libs existants à lire, décisions déjà prises (extrait de `PROGRESS.md`), contrats à respecter.
3. **Périmètre** : projets Nx qu'il peut modifier, et ceux qu'il ne doit pas toucher.
4. **Critères d'acceptation** vérifiables (commandes Nx qui doivent passer, comportements, captures attendues).
5. **Format du rapport** : fichiers modifiés, commandes lancées avec leur résultat, points ouverts, questions.

### Boucle de chaque phase (identique à PROMPT.md, section 0 bis)
1. `architect` : plan de la phase dans `PROGRESS.md` et découpage en tâches.
2. Agents de construction, **en parallèle** quand les tâches sont indépendantes.
3. `test-e2e` : tout tester. Chaque échec est renvoyé à l'agent responsable avec le message exact, jusqu'à ce que tout soit vert (`pnpm nx run-many -t lint typecheck test build`, plus e2e et responsive quand c'est pertinent).
4. `security-reviewer` : audit. Les points critiques et importants sont corrigés par l'agent concerné, puis réaudités.
5. Toi : commit(s) Conventional Commits sur `dev`, `git push origin dev` si le distant existe, mise à jour de `PROGRESS.md`. Puis phase suivante, **sans attendre de validation**.

Si un agent échoue 3 fois sur la même tâche : découpe la tâche plus finement ou change d'angle avec `architect`. Au bout de 2 découpages sans succès, note le blocage dans `PROGRESS.md` et passe à la suite.

## 5. Fin de projet : relecture et PR
Quand toutes les phases sont faites (les points « À brancher » mis à part) :
1. Lance `final-reviewer` **sans lui donner ton avis** : il repart de `PROMPT.md` et vérifie tout lui-même.
2. **REFUSÉ** : renvoie chaque point à l'agent concerné, puis `test-e2e`, puis relance `final-reviewer` (nouvel appel, sans contexte de ta part). Maximum 3 tours ; au 3e refus, tu t'arrêtes sans ouvrir de PR et tu résumes les points bloquants.
3. **VALIDÉ** : commit de `docs/REVIEW.md`, `git push origin dev`, rédaction de `docs/PR_BODY.md`, puis
   `gh pr create --base main --head dev --title "Raijin Shield v1.0" --body-file docs/PR_BODY.md`.
4. Tu affiches le lien de la PR et un résumé en 10 lignes. **Tu ne merges jamais.**

## 6. Quand t'arrêter (et seulement là)
Tu continues tout seul, sauf dans ces cas. Tu écris alors la demande en tête de `PROGRESS.md` (« ACTION REQUISE »), tu avances sur tout ce qui ne dépend pas de cette demande, et tu poses la question à la fin de ton tour :
- connexion, 2FA ou captcha dans Chrome ;
- une **clé secrète** à copier par l'utilisateur dans `.env` (tu ne la manipules jamais) ;
- `gh auth login` manquant ;
- une décision irréversible ou un doute sur un dépôt, un compte ou des données qui ne sont pas à toi ;
- un achat, des CGU à accepter, l'activation de Stripe en mode réel.

Les comptes manquants ne sont **pas** un motif d'arrêt : applique la section 0 ter de `PROMPT.md` (simulations locales et section « À brancher »).

## 7. Règles non négociables (résumé, détail dans PROMPT.md section 8)
- Secrets : jamais lus, affichés, journalisés ni commités. Pas de lecture de `.env*` ni de `.secrets/`.
- Git : push uniquement sur `dev` ; jamais sur `main`, jamais `--force`, jamais `reset --hard`, jamais de merge de PR.
- Rien d'écrit dans `"/home/kyoshiro/Documents/mes apps/raijin-old"` ni dans le dépôt de MyTradingCoach (lecture seule).
- Aucune écriture sur Supabase ni Vercel ; aucune commande sur le VPS (pas de ssh) : `infra/deploy.sh` et `infra/bench-migrate.sh` sont lancés par l'utilisateur.
- Ne jamais toucher à MyTradingCoach, XMR Trader, AdeTech (code, conteneurs, DNS, comptes).
- Produit : lecture seule on-chain, aucune signature ni swap, aucune promesse de gain, mention « pas un conseil en investissement ».
- Charte : tokens uniquement, mobile first, « Raijin Shield » / « Raijin » selon `BRAND.md`.

## 8. Modèle de docs/PROGRESS.md
```
# PROGRESS — Raijin Shield
## ACTION REQUISE (vide si rien)
## Statut : phase X — <nom> — <en cours | terminée>
## À brancher (service · prêt · manque · comment l'activer)
## Journal des phases
### Phase N — <nom>
- Plan (architect) :
- Tâches : [x] … (agent) / [ ] …
- Tests : commandes + résultats
- Sécurité : points + statut
- Commits :
- Décisions :
## Blocages
```
Mets-le à jour **après chaque tâche**, pas seulement en fin de phase : c'est ce qui permet de reprendre après une coupure ou une compaction du contexte.

## 9. Contexte long
Le projet est long. Garde ta propre conversation légère : délègue la lecture de gros fichiers aux agents, demande-leur des rapports courts, et appuie-toi sur `PROGRESS.md` plutôt que sur ta mémoire. Si ta session est interrompue, la prochaine reprend sur « reprends ».
