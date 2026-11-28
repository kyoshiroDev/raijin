# PROMPT CLAUDE CODE — Raijin Shield

> Exécuté par Claude Code selon `CLAUDE.md` (amorçage automatique : Git, GitHub, branche `dev`), à la racine de `/home/kyoshiro/Documents/mes apps/raijin`, qui contient déjà `CLAUDE.md`, `.claude/` (12 agents + permissions), `libs/brand/` et `docs/`.
> Le monorepo contient **deux applications** : **Raijin** (le SaaS public décrit ici) et **Raijin-banc-de-test** (l'ancien scanner perso, intégré au monorepo, accessible **uniquement** par l'utilisateur ; section 4.8).
> **Domaine : raijinshield.com.** **Tout est hébergé sur le VPS de l'utilisateur** : plus de Vercel ni de Supabase à terme. Le banc, aujourd'hui sur Supabase + Vercel, est migré sur le VPS (section 4.8).

---

## 0. Mission

Tu construis **Raijin Shield** (nom court : **Raijin**), un SaaS de **sécurité anti-rug pour les memecoins Solana**. L'utilisateur colle l'adresse d'un token et obtient en quelques secondes un **verdict clair et sourcé** : Sain, Prudence ou Danger. Il peut suivre des tokens et recevoir une alerte si le risque change (LP retirée, mint réactivé, gros holder qui vend). La monétisation se fait par **abonnement en euros via Stripe**.

Tu travailles **en autonomie totale, en orchestrateur d'agents** (section 0 bis), phase par phase. À la fin de chaque phase, tu lances les vérifications de la section 9 et tu écris un rapport court dans `docs/PROGRESS.md`. Tu ne passes à la phase suivante que si tout est vert.

**Les trois exigences non négociables :**
1. **Mobile first.** On conçoit pour un écran de 360 px, puis on enrichit vers le desktop. L'app doit être parfaitement responsive de 320 px à 1920 px.
2. **Élégance constante.** À chaque taille d'écran, l'interface doit avoir l'air d'un produit premium. Aucune vue « desktop rétrécie », aucun tableau qui déborde, aucun texte collé au bord.
3. **Sécurité.** Voir la section 8.

## 0 bis. Orchestration par agents (OBLIGATOIRE)

Tu es le **chef d'orchestre** : tu ne codes pas toi-même les fonctionnalités, tu les **délègues** aux agents de `.claude/agents/` et tu intègres leur travail. Lis tous les fichiers d'agents avant de commencer.

| Agent | Rôle |
| --- | --- |
| `architect` | Plan de chaque phase, contrats `libs/shared/contracts`, cohérence |
| `ui-mobile-first` | Toute l'interface Angular, mobile first, charte, mascotte, captures relues |
| `nestjs-api` | API, auth, Prisma, quotas, jobs, Resend, push |
| `solana-data` | Intégrations Helius, DexScreener, GeckoTerminal, Jupiter quote, RugCheck, scoring |
| `stripe-billing` | Abonnement, Checkout, Portal, webhooks |
| `seo-astro` | Landing Astro, guides, SEO, Lighthouse |
| `test-e2e` | Tous les tests, responsive, accessibilité, Lighthouse, captures |
| `security-reviewer` | Audit sécurité en fin de phase (lecture seule) |
| `admin-analytics` | Espace admin, GA4 et consentement, Search Console, attribution, métriques |
| `bench-quant` | Raijin-banc-de-test : intégration, migration Supabase → VPS, accès privé, mesure des verdicts, variantes du moteur |
| `ops-chrome` | Paramétrage de tous les services en ligne via Chrome (GitHub, OVH DNS, Stripe, Resend, Helius, Google, Zoho, B2, UptimeRobot, Sentry), sans jamais manipuler de clé secrète |
| `final-reviewer` | Relecture finale indépendante, valide ou refuse la livraison (lecture seule) |

**Boucle de chaque phase :**
1. `architect` écrit le plan de la phase et répartit les tâches.
2. Les agents de construction travaillent. Lance en parallèle ceux dont les tâches sont indépendantes (ex. `nestjs-api` et `ui-mobile-first` une fois le contrat `libs/shared/contracts` posé).
3. `test-e2e` teste tout et renvoie chaque échec à l'agent responsable, jusqu'à ce que tout soit vert.
4. `security-reviewer` audite. Tout point critique ou important est corrigé par l'agent concerné, puis réaudité.
5. Tu commits sur `dev` (section 11) et tu mets à jour `docs/PROGRESS.md` : ce qui est fait, résultats des tests, captures, décisions.

Tu ne t'arrêtes pas pour demander une validation entre les phases : tu enchaînes jusqu'à la fin, puis tu lances la relecture finale. Tu ne t'arrêtes que pour un vrai blocage (clé d'API indispensable absente, décision irréversible) : dans ce cas, tu notes la question en haut de `PROGRESS.md`, tu contournes avec un mock si possible et tu continues le reste.

---

## 0 ter. Démarrage sans les comptes externes (OBLIGATOIRE)

L'utilisateur n'a peut-être pas encore acheté le domaine ni créé tous les comptes de `docs/COMPTES.md`. **Ce n'est jamais une raison de s'arrêter.** Au début de chaque phase, demande-lui (une seule question groupée) quels comptes existent déjà, puis :
- **E-mails** : conteneur **Mailpit** dans le `docker-compose.dev.yml` (SMTP local + interface web) ; l'API passe par une interface `Mailer` avec deux implémentations (Resend en prod, SMTP Mailpit en dev).
- **Données Solana** : sans clé Helius, RPC public Solana avec limite de débit très basse et cache agressif, ou réponses enregistrées (fixtures) pour les tests ; DexScreener, GeckoTerminal, Jupiter lite-api et RugCheck n'ont pas besoin de compte.
- **Stripe** : interface `BillingProvider` ; sans compte, une implémentation simulée (faux Checkout qui redirige vers une page de succès locale, webhooks simulés par des fixtures signées localement). Dès qu'un compte Stripe existe (le mode test est gratuit et immédiat), on branche le vrai.
- **Google (GA4, Search Console)** : composants et services écrits et testés avec des données simulées, désactivés tant que les variables sont absentes. L'admin affiche « Non connecté » proprement.
- **Domaine** : tout fonctionne en local (`localhost` et sous-domaines `*.localhost`). Les configurations Traefik et DNS sont écrites avec `raijinshield.com` mais ne sont utilisées qu'au déploiement.
- **Push** : clés VAPID générées localement pour le dev.
- Les étapes Chrome (section 12) des services absents sont **reportées**, sans bloquer.
- Tiens à jour dans `docs/PROGRESS.md` une section **« À brancher »** : service, ce qui est prêt, ce qu'il manque (compte, clé), et l'étape exacte pour l'activer.

## 1. Stack et structure : monorepo Nx (OBLIGATOIRE)

Tout est géré proprement dans un **monorepo Nx** (dernière version stable) avec **pnpm**, **sans Nx Cloud**. On utilise les générateurs officiels (`@nx/angular`, `@nx/nest`, `@nx/js`, `@nx/playwright`, `@nx/vite`) plutôt que des configurations faites à la main.

**Création** : le dépôt existe déjà (avec `.git`, `.claude/`, `libs/brand/`, `PROMPT.md`). Génère le workspace dans un dossier temporaire (`npx create-nx-workspace@latest raijin-tmp --preset=ts --pm=pnpm --nxCloud=skip --interactive=false`), puis déplace son contenu à la racine **sans écraser** ces fichiers et en fusionnant `.gitignore`. Supprime ensuite le dossier temporaire vide avec `rmdir` (pas `rm -rf`).

```
raijin/
├─ apps/
│  ├─ api/            @nx/nest — NestJS 11, Prisma, PostgreSQL 17
│  ├─ api-e2e/        tests e2e de l'API
│  ├─ web/            @nx/angular — standalone, zoneless, signals, PWA
│  ├─ web-e2e/        @nx/playwright — e2e, responsive, axe, captures
│  ├─ landing/        Astro 5 (projet Nx via project.json + nx:run-commands, ou tâches inférées des scripts package.json)
│  ├─ raijin-banc-de-test/       front Angular du banc (privé), section 4.8
│  └─ raijin-banc-de-test-api/   NestJS : API + jobs du banc (remplace les Edge Functions et pg_cron de Supabase)
├─ libs/
│  ├─ brand/                    tokens.css, logos, icônes, mascotte, BRAND.md (fourni, ne pas modifier sans raison)
│  ├─ shared/contracts/         schémas Zod + types partagés (contrat API) — utilisé par api, web, landing
│  ├─ shared/util/              formatage (montants compacts, adresses tronquées), validation base58
│  ├─ web/ui/                   composants de base (Button, VerdictBadge, Card, BottomSheet, TabBar…)
│  ├─ web/data-access/          services HTTP, stores signals
│  ├─ web/feature-analyse/      écran d'analyse et page publique /t/<mint>
│  ├─ web/feature-suivis/       suivis et alertes
│  ├─ web/feature-wallet/       scan de wallet
│  ├─ web/feature-compte/       auth, compte, abonnement
│  ├─ api/auth/ · api/users/ · api/billing/ · api/alerts/ · api/notifications/
│  ├─ api/solana/               intégrations Helius, DexScreener, GeckoTerminal, Jupiter, RugCheck
│  ├─ shared/risk-engine/       moteur de verdict pur (TypeScript sans dépendance Node ni Deno) : utilisé par l'API Raijin ET par le banc de test
│  └─ bench/                    code propre au banc (util, ui, data-access), scope:bench
├─ infra/            docker-compose.yml (labels Traefik), backups, deploy.sh, bench-migrate.sh
├─ legacy/supabase/  ancien dossier supabase du banc, conservé en lecture pour référence pendant la migration, supprimé après bascule validée
├─ docs/             ARCHITECTURE.md, SECURITY.md, SCORING.md, PROGRESS.md, REVIEW.md, API.md
├─ nx.json · tsconfig.base.json · pnpm-workspace.yaml
└─ CLAUDE.md
```

**Règles Nx :**
- **Tags et frontières** sur chaque projet : `scope:web|api|landing|shared|bench` et `type:app|feature|ui|data-access|util|contracts|brand`. La règle ESLint `@nx/enforce-module-boundaries` est active et bloquante : une `feature` peut dépendre de `ui`, `data-access`, `util`, `contracts` ; une `ui` seulement de `util` et `brand` ; `scope:web` ne dépend jamais de `scope:api` (et inversement) ; tout le monde peut dépendre de `scope:shared`. **Aucun projet Raijin ne dépend jamais de `scope:bench`** : le banc peut lire le code partagé, l'inverse est interdit. Ce qui marche dans le banc remonte dans Raijin en passant par `libs/shared/risk-engine`, jamais par import direct.
- Imports uniquement par les alias `@raijin/...` définis dans `tsconfig.base.json`, jamais par chemins relatifs entre projets.
- Les apps restent **fines** : la logique vit dans les libs.
- Cibles standard sur chaque projet : `lint`, `test`, `typecheck`, `build` (et `e2e` pour les projets e2e). Le cache Nx est activé pour ces cibles.
- Commandes de vérification : `pnpm nx affected -t lint typecheck test build` pendant le travail, `pnpm nx run-many -t lint typecheck test build` en fin de phase, `pnpm nx graph --file=docs/graph.html` pour garder le graphe à jour dans les docs.
- Une GitHub Action `ci.yml` lance `nx affected -t lint typecheck test build` (avec `nx-set-shas`) sur chaque PR vers `main` et sur les pushs de `dev`. Le dépôt est **privé sur GitHub Free** (2 000 minutes d'Actions par mois) : cache pnpm et cache Nx activés, `concurrency` qui annule les exécutions obsolètes, e2e Playwright et Lighthouse seulement sur les PR vers `main`, captures d'écran non envoyées en artefacts sauf en cas d'échec.

- **Styles** : Tailwind CSS 4 (CSS-first). `apps/web` et `apps/landing` importent tous les deux `libs/brand/tokens.css` (via l'alias ou un chemin depuis la racine du workspace). **Aucune couleur, taille ou rayon en dur** dans les composants : uniquement les tokens (`bg-surface`, `text-ink-muted`, `rounded-lg`, `font-display`…).
- **Paiement** : Stripe (Checkout + Customer Portal + webhooks signés).
- **E-mails** : Resend, templates HTML responsive aux couleurs de la charte, en thème clair (`[data-theme="light"]`), avec version texte.
- **Hébergement** : **tout sur le VPS de l'utilisateur** (section 7), Raijin comme le banc, derrière le **Traefik déjà en place** sur ce VPS. **Aucun service payant obligatoire** en dehors de Stripe, qui se rémunère sur les transactions.
- **Tests** : Jest pour l'API, Vitest pour Angular, Playwright pour l'e2e et les captures responsive.

---

## 2. Charte graphique (OBLIGATOIRE)

Lis `libs/brand/BRAND.md` **avant d'écrire le moindre composant**. Résumé :

- **Nom** : **Raijin Shield** est le nom officiel (titre et SEO de la landing, Open Graph, logotype, mentions légales, CGV, Stripe, reçus, domaine). **Raijin** est le nom court (interface de l'app, e-mails, notifications, `short_name` du manifest PWA, sous l'icône). Première mention d'un texte : « Raijin Shield », puis « Raijin ». Jamais « RaijinShield » ni « Raijin-Shield ». Le header de la landing et de l'app utilise le logotype complet `raijin-wordmark-color.svg` (« Raijin SHIELD ») ; sur mobile très étroit (< 360 px), le symbole seul.

- **Thème sombre par défaut** : fond `base` #07090d, cartes `surface`, éléments surélevés `surface-raised`. On crée la profondeur en empilant ces surfaces, pas en ajoutant des ombres partout.
- **Une seule couleur de marque, le jaune `thunder` #facc15**. Il est réservé au logo, au **bouton principal (un seul par écran)** et à l'anneau de focus. Texte sur jaune : `on-thunder` (jamais de blanc).
- **Verdicts** : `safe`, `warn` et `danger` s'affichent **toujours avec une icône ET un mot** (« Sain », « Prudence », « Danger »). La couleur ne porte jamais seule le sens.
- **Typographies** : Space Grotesk pour les titres, Inter pour le texte, JetBrains Mono avec chiffres tabulaires pour les chiffres, montants, pourcentages et adresses.
- **Adresses de token** : en mono, tronquées au milieu (`7xKX…9fQp`), avec un bouton copier et un retour visuel « Copié ».
- **Formes** : cartes `rounded-lg` (16 px), boutons et champs `rounded-md` (10 px), badges `rounded-sm` (6 px). Grille de 4 px.
- **Halo `shadow-glow`** : uniquement sur le bouton principal au survol et au focus. C'est la signature « éclair » de l'interface.
- **Icônes** : Lucide, trait de 1,75 px, `currentColor`.
- **Logos** : `libs/brand/logos/`. Favicon `icons/favicon.svg` ; icônes PWA et Apple `icons/icon-180|192|512.png`.
- **Mascotte Rai, le gardien** (`libs/brand/mascot/`, lis son README) : petit super-héros au bouclier, en 3 poses. `rai-hero` pour le hero de la landing, l'onboarding et l'avatar social ; `rai-alerte` (bouclier levé qui bloque un éclair rouge) pour l'écran et l'e-mail d'alerte et la page d'erreur ; `rai-bravo` pour les succès, les états vides et la 404. Une apparition par écran maximum, jamais à la place d'un verdict. Sur la landing : légère respiration (3 s) et, au survol, un petit éclat jaune sur le bouclier. Respecte reduced-motion.
- **Ton** : tutoiement, direct, factuel. **Interdits** : « x10 », « moon », « gem », « achète », « opportunité », « signal d'achat », emojis 🚀💰, messages d'urgence. Raijin **informe** sur le risque ; il ne recommande jamais d'investir.

Crée dans `apps/web` une page `/_design` (accessible seulement en dev) qui montre tous les composants de base dans tous leurs états. Elle sert de référence visuelle et de support aux captures Playwright.

---

## 3. Règles mobile first et responsive (OBLIGATOIRES)

### Méthode
- On écrit d'abord les styles **sans préfixe** pour le mobile, puis on ajoute `sm:` (640), `md:` (768), `lg:` (1024) et `xl:` (1280). Jamais l'inverse.
- **Largeurs testées** : 320, 360, 390, 430, 768, 1024, 1280, 1440 et 1920 px, en portrait. Sur mobile, on teste aussi le paysage.
- **Zéro scroll horizontal** à 320 px. Un test Playwright le vérifie sur chaque page : `document.documentElement.scrollWidth <= innerWidth`.

### Navigation
- **Mobile (< 1024 px)** : une barre d'onglets fixe en bas, avec 4 entrées maximum (Analyser, Suivis, Alertes, Compte). Icône et libellé, cible tactile de 48 px, `padding-bottom: env(safe-area-inset-bottom)`. En haut : un header compact avec le logo et l'accès aux notifications.
- **Desktop (≥ 1024 px)** : une barre latérale gauche de 240 px, repliable à 72 px. La barre du bas disparaît.
- Le contenu est centré, avec une largeur de lecture max de 1200 px. Marges latérales : 16 px sur mobile, 24 px sur tablette, 32 px sur desktop.

### Ergonomie tactile
- Cibles tactiles d'au moins **44×44 px**, et 8 px minimum entre deux cibles.
- L'action principale est à portée de pouce : sur mobile, le bouton « Analyser » est collé en bas, au-dessus de la barre d'onglets.
- Champs de saisie en **16 px minimum**, sinon iOS zoome automatiquement. `inputmode` et `autocomplete` adaptés. L'adresse se colle en un tap grâce à un bouton « Coller » (Clipboard API, avec repli si refusée).
- Les **bottom sheets** (panneaux qui montent du bas) remplacent les modales sur mobile, et deviennent des modales centrées ou des panneaux latéraux sur desktop.
- Pas d'information accessible uniquement au survol : tout ce qui est en tooltip doit aussi être accessible au tap.

### Données et listes
- **Aucun tableau large sur mobile.** Les listes de tokens sont des **cartes empilées** sur mobile. Elles passent en grille de 2 colonnes à partir de `md`, puis en tableau dense optionnel à partir de `xl`.
- Toutes les cartes d'une même grille ont **la même hauteur** (grid + `h-full`, contenu en flex column avec le pied de carte poussé en bas).
- Chiffres longs : formatage compact (`1,2 M$`, `340 k$`) avec la valeur exacte en `title` et dans le détail.
- Textes longs : `truncate` ou `line-clamp`. Jamais de débordement.

### Finitions
- Hauteur d'écran avec `100dvh` (pas `100vh`). Safe areas iOS gérées en haut et en bas.
- **PWA installable** : manifest, icônes, `theme-color` #07090d, mode `standalone` et splash. L'app doit être belle **depuis l'écran d'accueil d'un iPhone**.
- **États** : chaque écran a un skeleton de chargement (pas de spinner seul), un état vide illustré par Rai (pose bravo) avec un message utile, et un état d'erreur illustré par Rai (pose alerte) avec un bouton « Réessayer ».
- **Animations** : courtes (150 à 250 ms), avec la courbe `cubic-bezier(.2,.8,.2,1)`. Elles respectent `prefers-reduced-motion`. L'analyse en cours affiche une animation sobre « éclair qui parcourt le bouclier », qui ne doit jamais bloquer.
- **Performance mobile** : Lighthouse mobile ≥ 95 en Performance, Accessibilité, Best Practices et SEO, sur la landing comme sur l'app. Polices en `display=swap` avec préconnexion. Images en AVIF/WebP. Routes Angular en lazy loading.

---

## 4. Fonctionnalités

### 4.1 Analyse d'un token (le cœur)
Entrée : une adresse de mint Solana, validée en base58 sur 32 à 44 caractères. On peut aussi coller un lien DexScreener, pump.fun ou Solscan : l'adresse est extraite automatiquement.

Contrôles, chacun avec un statut (ok / attention / danger / indisponible) et **la source affichée** :
1. **Autorité de mint** active ou révoquée (RPC Helius).
2. **Autorité de freeze** active ou révoquée.
3. **Liquidité** : montant (médiane DexScreener / GeckoTerminal), part de la LP **brûlée ou verrouillée**.
4. **Concentration** : part du top 10 des holders, en excluant la LP et les programmes connus. Signale si un seul wallet détient plus de 10 %.
5. **Revente possible (anti-honeypot)** : simulation d'un **devis de vente** via l'API Jupiter quote. On ne signe ni n'exécute aucune transaction. On mesure seulement l'impact prix et la taxe implicite.
6. **Métadonnées modifiables** (update authority).
7. **Âge** du pool et du token.
8. **Historique du créateur** : nombre de tokens lancés par le wallet créateur et combien sont morts ou ont subi un rug (Helius), si les données sont disponibles.
9. **Rapport RugCheck** comme source complémentaire, affiché comme tel.

**Verdict** : règles déterministes et documentées dans `docs/SCORING.md`, sans « IA magique ». Un seul contrôle critique (mint actif, freeze actif, honeypot ou LP retirée) donne **Danger**. Des signaux modérés donnent **Prudence**. Sinon le verdict est **Sain**, avec le rappel « aucun signal détecté ≠ sans risque ».

**Affichage mobile** : le verdict en grand en haut (badge + phrase d'explication), puis la liste des contrôles en accordéons. Chaque contrôle donne une explication en une phrase simple, et un « En savoir plus » ouvre une bottom sheet pédagogique. Boutons : Copier l'adresse, Suivre ce token, Partager (une URL publique `/t/<mint>` avec image Open Graph générée (1200×630, fond base, logo, verdict, petit Rai) qui montre le verdict).

**Cache** : un résultat est mis en cache 60 s par mint côté API. Les appels externes passent par une file avec limite de débit (le plan gratuit Helius est à 10 requêtes/s).

### 4.2 Suivis et alertes
- L'utilisateur suit des tokens. Un job programmé (BullMQ + Redis dans le compose, ou `@nestjs/schedule` en v1) réanalyse les tokens suivis.
- **Alerte** quand le verdict se dégrade ou qu'un événement critique survient (LP retirée de plus de 30 %, mint réactivé, holder de plus de 5 % qui vend). Elle est envoyée par **notification push web** (VAPID ; sur iOS la PWA doit être installée) et/ou par **e-mail Resend**, selon les préférences de l'utilisateur.
- Un écran « Alertes » affiche l'historique, avec filtres et marquage lu/non lu. Les e-mails d'alerte affichent Rai en pose alerte (PNG 2x hébergé, avec texte alternatif) au-dessus du verdict.
- Page 404 et page de maintenance avec Rai en pose bravo et un lien de retour.

### 4.3 Scan de wallet (lecture seule)
- L'utilisateur colle une **adresse publique** de wallet. **Aucune connexion de wallet, aucune signature**.
- Raijin liste les tokens détenus et donne un verdict pour chacun. Il signale aussi les **délégations actives** (comptes de tokens avec un `delegate`) et explique comment les révoquer dans son propre wallet (Phantom, Solflare), avec des liens vers leur documentation.

### 4.4 Comptes et abonnement
- **Auth** : e-mail + mot de passe (argon2id), vérification d'e-mail, mot de passe oublié, et **lien magique** en option, tout ça via Resend. Sessions en **cookies httpOnly, Secure, SameSite=Lax** : access token court + refresh token avec rotation et révocation. Pas de token dans le localStorage.
- **Plans** (prix modifiables dans la config, pas en dur) :
  - **Gratuit** : 5 analyses/jour, 3 tokens suivis, alertes par e-mail seulement.
  - **Pro** (14,90 € TTC/mois ou 149 € TTC/an) : analyses illimitées, 50 suivis, push + e-mail, scan de wallet, historique 90 jours.
- **Essai Pro de 7 jours sans carte bancaire (« reverse trial »)** :
  - À la **vérification de l'e-mail**, l'utilisateur passe automatiquement en Pro pendant 7 jours (`trialStartedAt`, `trialEndsAt` dans `User`). Aucune carte demandée, et **Stripe n'est pas utilisé pour l'essai** : tout se gère dans notre base.
  - **Quotas pendant l'essai** : toutes les fonctions Pro, mais analyses plafonnées à 50/jour (au lieu d'illimitées) pour protéger le quota Helius. Valeurs en configuration.
  - **Fin d'essai** : un job horaire repasse en Gratuit les comptes dont `trialEndsAt` est dépassé et sans abonnement actif. Les suivis au-delà de 3 sont mis en pause (pas supprimés) : l'utilisateur choisit les 3 à garder actifs ou s'abonne pour tout réactiver. L'historique reste visible.
  - **S'abonner pendant l'essai** met fin à l'essai et active Pro immédiatement (pas de double période).
  - **Anti-abus** : un seul essai par e-mail vérifié, blocage des domaines d'e-mails jetables (liste maintenue dans `libs/api/auth`), un seul essai par empreinte (hash IP + user-agent, stocké haché et purgé à 90 jours), normalisation des e-mails (casse, alias `+`, points Gmail). Un compte qui ne passe pas ces contrôles est créé directement en Gratuit, avec un message neutre.
  - **Interface** : un bandeau discret et élégant « Essai Pro : plus que 3 jours » (couleur `thunder-soft`, jamais agressif, refermable une fois par jour). Le jour J, Rai en pose bravo résume : nombre d'analyses faites, alertes reçues, tokens Danger évités. Bouton « Garder Pro », bouton secondaire « Continuer en Gratuit ». Aucune urgence artificielle, aucun compte à rebours clignotant.
  - **Landing et tarifs** : « Essaie Pro gratuitement pendant 7 jours. Sans carte bancaire. » sur le hero et la page tarifs.
  - **E-mails Resend** (désactivables, sauf celui de fin d'essai) :
    - J+1, « Voilà ce que Raijin a vérifié pour toi » ;
    - J-2, « Ton essai se termine dans 2 jours », avec le récapitulatif ;
    - J0, « Tu repasses en Gratuit », avec ce qui change et le bouton pour s'abonner.
  - **Mesures** : événements `trial_started`, `trial_converted`, `trial_expired` enregistrés en base, et un petit tableau admin (réservé au compte de l'utilisateur) avec le taux de conversion des essais.
- **Stripe** : Checkout hébergé, Customer Portal pour gérer ou résilier, webhooks (`checkout.session.completed`, `customer.subscription.updated/deleted`, `invoice.payment_failed`) vérifiés par signature et **idempotents** (table des events traités). Les quotas sont lus depuis la base, jamais depuis le front.
- **E-mails transactionnels** (logo en en-tête, Rai seulement sur les e-mails d'accueil, de fin d'essai et d'alerte) : bienvenue (qui annonce l'essai Pro), les 3 e-mails d'essai, vérification, reset, reçu ou échec de paiement, alerte token, résumé hebdo (optionnel, désactivable).
- **RGPD** : export et suppression du compte depuis les paramètres. Google Analytics étant utilisé sur la landing, une **bannière de consentement conforme CNIL** est obligatoire (section 4.6).

### 4.5 Landing Astro (SEO)
- Pages : accueil, tarifs, « Comment ça marche », FAQ, blog/guides (contenu Markdown : « Comment repérer un rug pull sur Solana », « Mint authority : c'est quoi ? », « Honeypot : comment le détecter »…), mentions légales, CGU/CGV, confidentialité.
- **Accueil mobile first** :
  - hero avec titre Space Grotesk (« Vérifie avant de signer. ») et balise title « Raijin Shield — le bouclier anti-rug des memecoins Solana », Rai en pose héros à côté du titre (au-dessus du titre sur mobile, en 160 px), champ d'analyse qui fonctionne directement (une analyse gratuite sans compte, limitée par IP) et visuel du verdict ;
  - les 3 verdicts expliqués ;
  - la liste des contrôles ;
  - preuve par l'exemple (une analyse de démonstration) ;
  - tarifs ;
  - FAQ ;
  - CTA final.
- **SEO** : balises title/description uniques, Open Graph et Twitter Card (images générées aux couleurs de la charte), JSON-LD (`SoftwareApplication`, `FAQPage`, `Organization`, `BreadcrumbList`, `Article`), sitemap.xml, robots.txt, URL canoniques, `lang="fr"`, HTML sémantique, liens internes entre les guides. Zéro JS par défaut ; des îlots seulement si nécessaire.
- **Mention légale visible** (footer + page tarifs) : « Raijin Shield fournit des analyses de sécurité à titre informatif. Ce n'est pas un conseil en investissement. Les memecoins sont extrêmement risqués : ne mise que ce que tu peux perdre. »

### 4.6 Suivi Google de la landing
- **Google Analytics 4** sur la landing Astro, avec **Consent Mode v2** : rien n'est déposé avant le choix de l'utilisateur. Bannière de consentement maison, élégante et mobile first, aux couleurs de la charte (bottom sheet sur mobile, encart en bas à gauche sur desktop), avec « Tout accepter », « Tout refuser » au même niveau visuel, et « Personnaliser ». Le choix est mémorisé 6 mois. Lien « Gérer les cookies » dans le footer.
- L'app (`apps/web`) n'embarque **pas** GA4 : ses mesures restent internes (table `ProductEvent`), sans cookie tiers.
- **Événements GA4** (noms en snake_case, documentés dans `docs/ANALYTICS.md`) : `analyse_demo_lancee`, `analyse_demo_resultat` (avec le verdict), `cta_essai_clic`, `inscription_debut`, `voir_tarifs`, `guide_lu` (avec le slug), `faq_ouverte`. L'inscription et l'abonnement sont des conversions.
- **UTM et attribution** : la landing conserve les paramètres UTM et le référent de la première visite (cookie de premier niveau, seulement après consentement, sinon en mémoire de session) et les transmet à l'inscription. L'API les stocke sur `User` (`utmSource`, `utmMedium`, `utmCampaign`, `referrer`, `landingPath`) pour relier les visites aux inscrits et aux payants.
- **Google Search Console** : balise de vérification par variable d'environnement, sitemap déclaré dans `docs/DEPLOY.md`.

### 4.8 Raijin-banc-de-test (privé)

**Ce que c'est** : l'ancien scanner perso (aujourd'hui front sur Vercel `raijin.vercel.app` + backend Supabase réf. `jntknbxdpetvcmoejncm` : Postgres, Edge Functions Deno, pg_cron, Auth, Realtime) devient **Raijin-banc-de-test**, le laboratoire de l'utilisateur pour tester des idées, collecter des données et trouver ce qui améliore Raijin. Il n'est **jamais** proposé aux clients. **Cible : 100 % sur le VPS**, sans Supabase ni Vercel.

**Étape 1 : import (phase 1 bis), sans rien casser**
- Le dépôt actuel est sur la machine de l'utilisateur : `"/home/kyoshiro/Documents/mes apps/raijin-old"` (aussi dans `docs/REFERENCES.md`). **Le chemin contient un espace : toujours entre guillemets.** Ce dossier est en lecture seule pour toi (permissions). Copie le front Angular dans `apps/raijin-banc-de-test/` et le dossier `supabase/` dans `legacy/supabase/` (sans `.git`, `node_modules`, `.env*`, `.secrets/`, `dist`). Ne modifie pas le dépôt d'origine.
- Renomme l'app en « Raijin-banc-de-test » (titre, manifest PWA, meta) avec un **badge « BANC DE TEST »** permanent dans le header (couleur `warn`). Elle garde la charte mais n'utilise pas la mascotte.
- Pendant cette étape, le banc en production continue de tourner sur Supabase sans changement : tu ne déploies rien sur Supabase.

**Étape 2 : portage sur le VPS (phase 8 bis)**
- **Inventaire d'abord** : liste dans `docs/BENCH.md` chaque Edge Function, tâche pg_cron, table, vue, fonction SQL, policy RLS, usage de Realtime, d'Auth et de Vault, avec son équivalent cible. Signale ce qui est mort et ne sera pas porté.
- **Backend** : `apps/raijin-banc-de-test-api` (NestJS). Chaque Edge Function devient un module dans `libs/bench/*` ; les intégrations Helius / DexScreener / GeckoTerminal / Jupiter réutilisent `libs/api/solana` ; le scoring utilise `libs/shared/risk-engine`. Les tâches pg_cron deviennent des jobs BullMQ (Redis déjà présent pour Raijin) avec les mêmes fréquences, verrou anti-chevauchement, et journal dans une table `job_runs`. Realtime est remplacé par du SSE. Les notifications push du banc passent par la lib push partagée (VAPID). Le front du banc remplace `supabase-js` par un service `data-access` qui appelle cette API (cookies httpOnly), puis la dépendance Supabase est retirée.
- **Base** : une **base `raijin_bench` séparée**, avec son propre utilisateur Postgres, dans le même conteneur Postgres que Raijin (base `raijin`) pour économiser la RAM. Aucun droit croisé entre les deux utilisateurs. Schéma en Prisma (client et migrations séparés de ceux de Raijin), reprenant les tables utiles de Supabase.
- **Script de migration des données** `infra/bench-migrate.sh` : `pg_dump` des tables du schéma `public` de Supabase (pas `auth`, `storage`, `realtime`), transformation (remplacer les références `auth.users` par le compte unique du banc), restauration dans `raijin_bench`, puis contrôle (nombre de lignes par table, min/max des dates, sommes de contrôle sur quelques colonnes). Il lit les connexions dans des variables d'environnement. **Tu le testes sur un dump factice local, mais c'est l'utilisateur qui l'exécute sur les vraies données.**
- **Bascule sans trou de données** (procédure dans `docs/BENCH.md`, exécutée par l'utilisateur) : (1) déployer l'API du banc sur le VPS en **mode ombre** (elle collecte en parallèle de Supabase, sans notifier), (2) comparer pendant 24 à 48 h les données collectées des deux côtés (écran de comparaison dans le banc), (3) migrer l'historique, (4) basculer le front, activer les notifications sur le VPS et désactiver les crons Supabase, (5) garder le projet Supabase **en pause, pas supprimé**, pendant 30 jours comme retour arrière. La limite de 500 Mo de Supabase disparaît avec la bascule.
- La rétention reste configurable sur le VPS (snapshots détaillés N jours, agrégats conservés) avec alerte à 80 % de l'espace disque alloué.

**Accès réservé à l'utilisateur (double verrou)**
1. **Côté application** : l'API du banc a sa propre authentification (séparée de Raijin) : un seul compte, inscriptions inexistantes, mot de passe argon2id + **2FA TOTP**, e-mail autorisé en variable d'environnement. Chaque route vérifie ce compte ; tout autre jeton reçoit 401.
2. **Côté hébergement** : sous-domaine dédié non annoncé (`banc.raijinshield.com`) protégé en amont par un **middleware Traefik `basicAuth`** (hash en variable) avant même d'atteindre l'app. `X-Robots-Tag: noindex, nofollow`, `robots.txt` en `Disallow: /`, aucun lien depuis Raijin ni la landing, absent du sitemap.
- Un compte Raijin, même admin, n'ouvre pas le banc.

**Ce que le banc doit permettre (pour améliorer Raijin)**
- **Mesurer la justesse des verdicts de Raijin** : pour chaque token analysé, enregistrer le verdict du moteur, puis vérifier 24 h, 72 h et 7 jours plus tard ce qui s'est réellement passé (LP retirée, chute de plus de 90 %, mint utilisé, token mort). Tableau : précision et rappel du verdict Danger, taux de faux « Sain », contrôles qui prédisent le mieux un rug. C'est la preuve chiffrée qui servira aussi au marketing (« X % des rugs signalés à l'avance »), **uniquement si les chiffres le justifient**.
- **Tester une variante du moteur** (`risk-engine` avec des seuils ou règles modifiés, derrière un drapeau) sur l'historique avant de la passer dans Raijin. Comparaison côte à côte : ancien moteur vs variante.
- Garder les outils existants utiles : scanner, labellisation OHLCV, backtests, paper trading. Retirer ce qui est mort, en listant ce qui est retiré dans `PROGRESS.md`.

### 4.7 Espace admin
Même inspiration que l'admin de MyTradingCoach : un back-office sombre et premium, avec cartes de KPI en chiffres mono, graphiques sobres, tableaux denses sur desktop et cartes sur mobile. Si l'utilisateur indique le chemin local du dépôt MyTradingCoach dans `docs/REFERENCES.md`, lis son module admin **en lecture seule**, reprends sa structure de navigation et ses patterns d'écran, et adapte-les à Raijin et à sa charte (jaune `thunder` au lieu du vert de MTC). Sans ce chemin, suis la structure ci-dessous.

**Accès et sécurité**
- Route `/admin` dans `apps/web`, chargée en lazy (lib `libs/web/feature-admin`), invisible pour les autres comptes. API sous `/api/v1/admin` (lib `libs/api/admin`).
- Rôle `ADMIN` en base, attribué uniquement par une commande CLI (`pnpm nx run api:make-admin --email=...`), jamais depuis l'interface. Garde serveur sur chaque route admin.
- **2FA TOTP obligatoire** pour le compte admin (QR code, codes de secours), session admin courte (30 min d'inactivité).
- Chaque action admin est écrite dans `AuditLog` (qui, quoi, quand, avant/après).

**Écrans**
1. **Vue d'ensemble** : KPI du jour, de 7 jours et de 30 jours avec variation par rapport à la période précédente : visiteurs de la landing, inscriptions, comptes vérifiés, essais en cours, conversions essai → Pro, MRR, abonnés actifs, churn, analyses faites, alertes envoyées. Un graphique de tendance et l'**entonnoir complet** : visites (GA4) → analyse démo → inscription → e-mail vérifié → essai → Pro.
2. **Trafic (Google)** via l'**API Google Analytics Data (GA4)** : visiteurs, sessions, taux d'engagement, pages les plus vues, sources et canaux, appareils (part mobile), pays, événements clés et conversions, sur une période au choix.
3. **SEO (Search Console)** via l'**API Search Console** : clics, impressions, CTR, position moyenne, requêtes et pages principales, évolution sur 28 et 90 jours. Mise en avant des requêtes en position 5 à 20 (les plus faciles à faire progresser).
4. **Acquisition** : inscrits et payants par source UTM, campagne et page d'arrivée. C'est la jointure entre Google et nos données internes.
5. **Revenus** (Stripe) : MRR et son évolution, nouveaux abonnés, résiliations, paiements échoués, répartition mensuel/annuel, revenu par source d'acquisition.
6. **Essais** : essais en cours, taux de conversion par cohorte de semaine, raisons de non-conversion si renseignées, comptes bloqués par l'anti-abus.
7. **Utilisateurs** : recherche par e-mail, liste filtrable (plan, statut d'essai, date d'inscription, source). Fiche utilisateur : plan, essai, abonnement Stripe (lien vers le dashboard Stripe), usage, suivis, alertes, historique d'audit. **Actions** (avec confirmation et audit) : prolonger l'essai, offrir un mois de Pro, suspendre ou réactiver, renvoyer l'e-mail de vérification, supprimer (RGPD). Pas d'usurpation de compte.
8. **Produit** : analyses par jour, répartition des verdicts (Sain / Prudence / Danger), tokens les plus analysés, temps de réponse moyen de l'analyse, taux de contrôles « indisponibles » par source.
9. **Santé technique** : état des jobs (dernière exécution, durée, erreurs), consommation et limites des API externes (crédits Helius, appels Jupiter, RugCheck), taux d'erreur de l'API, e-mails Resend envoyés et en échec, abonnements push actifs, taille de la base. Alertes à l'admin (e-mail + push) si un job échoue 3 fois de suite ou si un quota dépasse 80 %.

**Technique**
- Une lib `libs/api/analytics` encapsule les appels GA4 Data API et Search Console API avec un **compte de service Google** (JSON fourni par variable d'environnement, jamais commité). Les résultats sont mis en cache 1 h (Search Console a 2 à 3 jours de décalage : l'afficher clairement).
- Les agrégats internes (KPI quotidiens) sont calculés par un job nocturne dans une table `DailyMetric` pour que l'admin reste instantané.
- **Graphiques** : une seule librairie légère, choisie par `architect` et documentée, thémée avec les tokens (jaune pour la série principale, `info` pour la comparaison, verdicts pour les répartitions). Courbes lisibles sur 360 px.
- **Mobile first là aussi** : sur téléphone, KPI en grille de 2, graphiques pleine largeur, tableaux convertis en cartes, filtres dans un bottom sheet. Tu dois pouvoir consulter ton admin confortablement depuis ton iPhone.
- `docs/DEPLOY.md` explique pas à pas : créer la propriété GA4, le compte de service, lui donner l'accès lecteur à GA4 et à Search Console, et renseigner les variables.

---

## 5. Modèle de données (Prisma, base de départ)
`User` (email unique, emailNormalized unique, hash, emailVerifiedAt, plan, trialStartedAt, trialEndsAt, stripeCustomerId), `TrialFingerprint` (hash, createdAt), `ProductEvent` (userId, type, createdAt), champs d'attribution sur `User` (utmSource, utmMedium, utmCampaign, referrer, landingPath) et `role` (USER | ADMIN), `TotpSecret` (chiffré), `DailyMetric` (date, clé, valeur), `JobRun` (job, début, fin, statut, erreur), `Session/RefreshToken`, `Subscription`, `StripeEvent` (id unique, pour l'idempotence), `TokenAnalysis` (mint, verdict, checks JSON, sources, createdAt), `Watch` (userId, mint, lastVerdict), `Alert` (userId, mint, type, payload, readAt), `PushSubscription`, `UsageCounter` (userId ou ipHash, jour, count), `AuditLog`. Index sur mint et sur userId. Rétention : les analyses de plus de 90 jours sont purgées par un job.

## 6. API
REST versionnée `/api/v1`, documentée par OpenAPI (Swagger désactivé en prod). DTO validés avec class-validator ou Zod (schémas de `libs/shared/contracts`). Erreurs au format standard `{code, message}`, sans stack trace en prod. Rate limiting (`@nestjs/throttler`) global et renforcé sur l'auth et l'analyse anonyme. Helmet, CORS limité aux domaines web et landing.

## 7. Déploiement (VPS)
**Contexte important** : le VPS de l'utilisateur héberge **déjà MyTradingCoach (et XMR Trader) en production derrière Traefik**. Règle absolue : **ne rien perturber**. Raijin ne prend pas les ports 80/443, ne lance pas de second reverse proxy et ne touche ni aux conteneurs, ni aux volumes, ni aux réseaux de MTC.
- `infra/docker-compose.yml` (projet Compose `raijin`) : `raijin-api`, `raijin-bench-api`, `raijin-web` et `raijin-landing` et `raijin-bench-web` (fichiers statiques servis par un petit conteneur nginx:alpine chacun), `raijin-postgres` (bases `raijin` et `raijin_bench`, volume dédié), `raijin-redis`. Chaque service exposé rejoint le **réseau externe de Traefik existant** (nom en variable, à vérifier avec `docker network ls` par l'utilisateur) et se déclare **par labels** (routers, TLS Let's Encrypt avec le resolver existant, middlewares de sécurité). Postgres et Redis restent sur un réseau interne non exposé.
- **Domaine : `raijinshield.com`** (OVH). `raijinshield.com` et `www.raijinshield.com` (landing, `www` redirigé en 301 vers la racine), `app.raijinshield.com` (web), `api.raijinshield.com` (API), `banc.raijinshield.com` (front + API du banc, avec middleware basicAuth). Le nom de la marque reste **Raijin** partout ; « Raijin Shield » n'apparaît que dans le domaine. E-mails : `noreply@raijinshield.com` (Resend), `contact@` et `support@` (Zoho).
- Middlewares Traefik : en-têtes de sécurité (CSP stricte par app, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy), compression, rate limit sur l'API.
- **Ressources** : limites mémoire et CPU sur chaque conteneur (`mem_limit`) pour protéger MTC. `docs/DEPLOY.md` indique de vérifier la RAM libre (`free -h`) avant le premier déploiement et donne la consommation attendue.
- **Sauvegardes** : `pg_dump` quotidien des deux bases, rotation 7 jours en local + copie hors site (même mécanisme que celui déjà utilisé pour MTC si l'utilisateur le précise, sinon un bucket dédié et séparé). Script de restauration testé sur une base de test.
- **Surveillance** : healthchecks Docker, et un script de veille qui alerte l'utilisateur (e-mail Resend + push) si un service Raijin tombe.
- `infra/deploy.sh` et `infra/bench-migrate.sh` sont fournis **mais tu ne les exécutes pas** : l'utilisateur les lance lui-même sur le VPS.

## 8. Sécurité (règles absolues)
- **Jamais** de lecture, d'affichage ou de log de secrets. Pas de lecture de `.env`, `.env.*` ou `.secrets/`. Tu crées seulement un `.env.example` avec des valeurs factices. Les secrets (Stripe, Resend, Helius, JWT, VAPID) passent uniquement par des variables d'environnement côté API.
- Le front ne contient **aucune clé secrète**. Seule la clé publique Stripe est autorisée côté client si nécessaire.
- **Aucune** fonctionnalité de signature de transaction, de swap, de garde de clé privée ou de commission sur les trades. Raijin est un **outil d'information en lecture seule**.
- **Aucune** promesse de gain ni recommandation d'investissement, dans le code, les textes et les e-mails.
- Toutes les données externes (noms et symboles de tokens, URLs de métadonnées) sont considérées comme **hostiles** : échappées, URLs filtrées en `https` uniquement avec liste de domaines autorisés, images proxifiées ou non affichées.
- **Git** : le seul push autorisé est `git push origin dev`, et uniquement après la validation du `final-reviewer` (section 11). **Jamais** de push sur `main`, de `--force`, de `reset --hard` ni de merge de PR : c'est l'utilisateur qui merge. Jamais de `.env` commité (vérifie `.gitignore` dès la phase 1).
- Pas de commande destructive (`rm -rf`, `prisma migrate reset` sur une base distante, `docker volume rm`) ni d'exécution de `infra/deploy.sh`.
- **Supabase (projet réf. `jntknbxdpetvcmoejncm`) et Vercel : aucune écriture.** Tu ne déploies rien dessus, tu ne modifies ni schéma ni données ni crons ; ils sont arrêtés par l'utilisateur au moment de la bascule. **Aucune commande ne touche aux conteneurs, volumes ou réseaux de MyTradingCoach / XMR Trader.** **Ne jamais toucher au projet « AdeTech »**. Les clés (Helius, etc.) du banc sont des variables d'environnement de `raijin-bench-api` ; le front du banc n'a aucune clé.
- `docs/SECURITY.md` liste les menaces (OWASP Top 10, abus des quotas, webhooks forgés, XSS via métadonnées) et les parades mises en place.

## 9. Vérifications à chaque phase (Definition of Done)
1. `pnpm nx run-many -t lint typecheck test build` est vert, frontières de modules comprises. Couverture ≥ 80 % sur le scoring et l'auth.
2. **Playwright responsive** : captures de chaque page aux largeurs 320, 390, 768, 1024 et 1440, en sombre (et en clair pour les pages d'e-mail), enregistrées dans `docs/screenshots/<phase>/`. Les tests vérifient : pas de scroll horizontal, cibles ≥ 44 px sur mobile, barre du bas visible < 1024 et sidebar ≥ 1024, pas de texte tronqué sans `title`.
3. **Relecture visuelle** : ouvre les captures et corrige tout ce qui n'est pas élégant (alignements, espacements irréguliers, hauteurs de cartes inégales, contrastes). Note les corrections dans `PROGRESS.md`.
4. **Accessibilité** : axe-core sans erreur, navigation complète au clavier, focus visible, contrastes ≥ 4,5:1.
5. **Lighthouse mobile** ≥ 95 sur la landing et sur l'écran d'analyse (dès la phase 3).
6. **Revue de sécurité** de la phase par `security-reviewer`, sans point critique ou important ouvert.
7. **Commit** de la phase sur `dev`.

## 10. Phases
1. **Socle** : vérification de l'environnement (Git, branche `dev`, remote GitHub, `gh auth status`), `.gitignore`, workspace Nx avec tous les projets générés, tags et frontières, CI GitHub, CLAUDE.md (qui résume ce prompt et la boucle d'agents), `libs/brand` branché, page `/_design` avec les composants de base (Button, Badge de verdict, Card, Input + bouton Coller, AddressChip, BottomSheet, TabBar, Sidebar, Skeleton, EmptyState, Toast).
1 bis. **Banc de test, import** : front copié dans `apps/raijin-banc-de-test`, dossier supabase dans `legacy/`, cibles Nx, renommage et badge, build vert (le banc en production reste intact sur Supabase).
1 ter. **Services en mode test via Chrome** (section 12, agent `ops-chrome`).
2. **API et auth** : Prisma, auth complète, e-mails Resend, rate limiting, tests.
3. **Analyse de token** : intégrations Helius, DexScreener, GeckoTerminal, Jupiter quote et RugCheck, scoring, cache, écran d'analyse mobile, page publique `/t/<mint>` avec image OG.
4. **Suivis, alertes et push** : jobs, push VAPID, e-mails d'alerte, écran Alertes.
5. **Scan de wallet** (lecture seule).
6. **Stripe et essai** : plans, essai Pro 7 jours sans carte avec anti-abus, job de fin d'essai et e-mails d'essai, quotas, Checkout, Portal, webhooks idempotents, écran Compte et Abonnement, tableau de conversion admin.
6 bis. **Admin et analytics** : rôle admin et 2FA, GA4 + consentement sur la landing, attribution UTM, intégrations GA4 Data API et Search Console, les 9 écrans admin, agrégats nocturnes, santé technique et alertes admin.
7. **Landing Astro** : pages, guides, SEO complet, Lighthouse.
7 bis. **Banc : mesure des verdicts** (préparée dans `libs/bench`, active après le portage) : `libs/shared/risk-engine`, suivi des verdicts à 24 h / 72 h / 7 j, tableau de justesse, comparaison de variantes, rétention et alerte de taille de base.
8. **Infra** : docker-compose avec labels Traefik, limites de ressources, backups, surveillance, `deploy.sh`, `docs/DEPLOY.md` pas à pas pour un débutant (DNS, variables, webhooks Stripe en prod, clés VAPID).
8 bis. **Banc de test sur le VPS** : inventaire Supabase, `raijin-banc-de-test-api` (modules, jobs BullMQ, SSE, push), base `raijin_bench`, auth privée + 2FA, `bench-migrate.sh` testé sur dump factice, mode ombre et écran de comparaison, procédure de bascule et de retour arrière dans `docs/BENCH.md`.
8 ter. **Services de production via Chrome** (section 12) : DNS, Search Console, webhooks, Zoho, B2, UptimeRobot, Sentry, profils sociaux.
9. **Polish final** : passe complète de relecture visuelle sur toutes les captures, micro-interactions, états vides et erreurs, textes relus selon le ton de la charte.

10. **Relecture finale et livraison** : section 11.

## 11. Workflow Git et livraison

- Tout le travail se fait sur la branche **`dev`**. Un commit par tâche significative, au format Conventional Commits (`feat(api): auth par lien magique`, `fix(web): hauteur des cartes`…), avec un commit de clôture par phase (`chore: phase 3 terminée`). Ne commite jamais `.env`, captures lourdes inutiles, `node_modules` ou `dist`.
- Pendant le développement, tu peux pousser `dev` pour sauvegarder (`git push origin dev`), mais **la PR n'est ouverte qu'après validation finale**.
- **Relecture finale** : quand les 9 phases sont terminées, lance l'agent `final-reviewer`. Il écrit `docs/REVIEW.md`.
  - **« VERDICT : REFUSÉ »** : tu fais corriger chaque point par l'agent concerné, `test-e2e` revalide, puis tu relances `final-reviewer` (un nouvel appel, sans lui donner tes conclusions). Jusqu'à 3 tours ; si c'est encore refusé au 3e, tu t'arrêtes et tu résumes les points bloquants dans `PROGRESS.md`, sans ouvrir de PR.
  - **« VERDICT : VALIDÉ »** : tu commits `docs/REVIEW.md`, tu pousses (`git push origin dev`), puis tu ouvres la PR :
    `gh pr create --base main --head dev --title "Raijin Shield v1.0" --body-file docs/PR_BODY.md`
    `docs/PR_BODY.md` contient : le résumé des fonctionnalités, la liste des phases, les résultats des tests et de Lighthouse, quelques captures mobiles (liens vers `docs/screenshots/`), le verdict du relecteur, les variables d'environnement à configurer et les étapes manuelles restantes (DNS, clés Stripe live, webhooks, VAPID, déploiement).
- **Tu ne merges jamais la PR.** Tu termines en affichant le lien de la PR et un résumé de 10 lignes.

## 12. Configuration des services en ligne via Chrome

L'utilisateur a créé les comptes listés dans `docs/COMPTES.md` et s'y est connecté dans son Chrome. **Toi, tu fais tout le paramétrage dans ces tableaux de bord avec l'intégration Chrome de Claude Code** (extension Claude in Chrome), par l'intermédiaire de l'agent `ops-chrome`.

**Règles**
- Commence chaque session Chrome par lister les onglets ouverts, puis travaille dans un **nouvel onglet**. Ne touche jamais aux onglets existants de l'utilisateur ni à des sites hors de la liste de `docs/COMPTES.md`.
- **Ne jamais copier, lire à voix haute, journaliser ou commiter une clé secrète.** Quand un service génère une clé (Stripe, Resend, Helius, Google, B2, Sentry, webhook secret), tu t'arrêtes sur la page et tu demandes à l'utilisateur de la copier lui-même dans son `.env` local. Tu tiens à jour `docs/SECRETS-CHECKLIST.md` : nom de la variable, service, page exacte où la trouver, coché ou non par l'utilisateur. Tu ne lis jamais `.env` pour vérifier : tu demandes à l'utilisateur de confirmer, ou tu testes via un endpoint de santé qui répond seulement « configuré / non configuré ».
- **Jamais** : payer, saisir un moyen de paiement, accepter des CGU au nom de l'utilisateur, activer le mode live de Stripe, supprimer un compte, un projet ou une ressource existante, modifier MyTradingCoach, XMR Trader ou AdeTech, publier sur un réseau social sans validation explicite du texte.
- Si une page demande une connexion, un code 2FA ou un captcha : tu t'arrêtes et tu demandes à l'utilisateur de le faire, puis tu reprends.
- Avant toute modification d'un réglage existant, tu notes l'ancienne valeur dans `docs/OPS-LOG.md`. Tu y journalises chaque action (date, service, page, réglage, valeur non secrète).
- Si l'interface d'un service a changé, ne devine pas : vérifie dans sa documentation officielle, puis agis.
- Si un même réglage échoue 3 fois, arrête-toi et décris le blocage dans `PROGRESS.md`.

**Quand**
- **Phase 1 ter (mode test, dès le début)** :
    - Stripe en mode test : produit, prix, Customer Portal, branding, endpoint webhook vers un tunnel de dev ou à compléter plus tard ;
  - Resend : domaine et DNS chez OVH ;
  - Helius : projets et clés ;
  - Google : propriété GA4, flux web, projet Cloud, API activées, compte de service.
- **Phase 8 ter (mise en ligne)** :
  - OVH DNS : enregistrements vers le VPS pour `raijin`, `app`, `api` et `banc` ;
  - Search Console : vérification et envoi du sitemap ;
  - GA4 : conversions ;
  - webhook Stripe de production en mode test ;
  - Zoho Mail ;
  - bucket B2 dédié ;
  - UptimeRobot ;
  - Sentry ;
  - profils X et Telegram (textes à faire valider).
- Après chaque phase de configuration, un test vérifie que tout répond : envoi d'un e-mail de test via Resend, paiement test Stripe de bout en bout avec la carte 4242, événement GA4 visible en temps réel, DNS résolus.

Commence par la phase 1. Avant d'écrire du code, résume en 10 lignes ta compréhension du projet et ton plan dans `docs/PROGRESS.md`, puis enchaîne.
