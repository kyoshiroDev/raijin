# SECRETS-CHECKLIST — Raijin Shield

Claude Code ne copie jamais une clé secrète. **C'est toi qui copies chaque valeur** dans ton `.env` local
(à partir du modèle de `docs/ENV.md`), puis dans le `.env` du VPS au déploiement. Coche la case quand c'est fait.
Les noms de variables suivent `docs/ENV.md`.

## Services en ligne

| Variable | Service | Page exacte où la trouver | Utilisé par | Copié par l'utilisateur |
|---|---|---|---|---|
| `HELIUS_API_KEY` | Helius | https://dashboard.helius.dev → API Keys → ligne **« raijin-api »** → bouton copier de la colonne « API Key » | apps/api (serveur uniquement) | [x] |
| `BENCH_HELIUS_API_KEY` (nom proposé, à ajouter à `docs/ENV.md`) | Helius | https://dashboard.helius.dev → API Keys → ligne **« raijin-banc-de-test »** → bouton copier de la colonne « API Key » | apps/raijin-banc-de-test-api (serveur uniquement) | [x] |
| `RESEND_API_KEY` | Resend | https://resend.com/api-keys — service pas encore créé | apps/api | [ ] |
| `STRIPE_SECRET_KEY` | Stripe (test) | Compte « Raijin Shield » (`acct_1UgBFZ2YwXqnyasm`), mode test : **Développeurs → Clés API** (https://dashboard.stripe.com/test/apikeys) → « Clé secrète » `sk_test_…` → Révéler → copier. Même valeur pour `.env` local, `infra/.env.api` (prod en mode test) et `/srv/raijin/dev/env/.env.api` (dev). Avec `BILLING_PROVIDER=stripe`, `STRIPE_PRICE_PRO_MONTHLY=price_1UgBZn2YwXqnyasmXAyAAFMi`, `STRIPE_PRICE_PRO_YEARLY=price_1UgBZm2YwXqnyasm2VcbmJSo` (identifiants publics) | apps/api | [ ] |
| `STRIPE_WEBHOOK_SECRET` (prod, mode test) | Stripe (test) | https://dashboard.stripe.com/test/workbench/webhooks → destination **« raijin-prod »** (`we_1UgBqL2YwXqnyasmipMpIZPq`) → « Clé secrète de signature » `whsec_…` → icône œil (Révéler) → copier dans `infra/.env.api` | apps/api (prod) | [ ] |
| `STRIPE_WEBHOOK_SECRET` (dev) | Stripe (test) | même page → destination **« raijin-dev »** (`we_1UgBt62YwXqnyasmWx3bdCuc`) → « Clé secrète de signature » → Révéler → copier dans `/srv/raijin/dev/env/.env.api` (distinct de la prod). En local : `stripe listen --forward-to localhost:3100/api/v1/billing/webhook` affiche un secret propre au poste | apps/api (dev) | [ ] |
| `STRIPE_SECRET_KEY` (prod, **mode réel**) | Stripe (live) | Compte « Raijin Shield » (`acct_1UgBFZ2YwXqnyasm`) **en mode réel** (pas d'« Environnement de test » dans le menu du compte) : **Développeurs → Clés API** (https://dashboard.stripe.com/apikeys) → « Clé secrète » `sk_live_…` → Révéler → copier dans **`.env.prod`** / `infra/.env.api` du VPS uniquement (jamais en local ni en dev). Avec `BILLING_PROVIDER=stripe`, `STRIPE_PRICE_PRO_MONTHLY=price_1UgWcs2YwXqnyasmSKwpoJjc`, `STRIPE_PRICE_PRO_YEARLY=price_1UgWcs2YwXqnyasmNuGGq49M` (identifiants publics, mode réel) | apps/api (prod) | [ ] |
| `STRIPE_WEBHOOK_SECRET` (prod, **mode réel**) | Stripe (live) | https://dashboard.stripe.com/workbench/webhooks (mode réel) → destination **« raijin-prod-live »** (`we_1UgWt72YwXqnyasmx8K9qxCQ`) → « Clé secrète de signature » `whsec_…` → icône œil (Révéler) → copier dans **`.env.prod`** / `infra/.env.api` (remplace le secret de « raijin-prod » test) | apps/api (prod) | [ ] |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google Cloud | https://console.cloud.google.com/iam-admin/serviceaccounts?authuser=4&project=raijin-admin → `raijin-admin-reader@raijin-admin.iam.gserviceaccount.com` → onglet Clés → Ajouter une clé → Créer une clé → JSON → Créer (clé créée et collée en base64 par l'utilisateur le 2026-11-26) | apps/api (admin-analytics) | [x] |
| `SENTRY_DSN_API` / `SENTRY_DSN_WEB` | Sentry | https://sentry.io/settings/projects/ → projet → Client Keys (DSN) — service pas encore créé | apps/api / apps/web | [ ] |

## Secrets générés localement (aucun service)

| Variable | Comment la générer | Utilisé par | Fait |
|---|---|---|---|
| `POSTGRES_PASSWORD` (et `DATABASE_URL`) | `openssl rand -base64 32` | apps/api | [ ] |
| `JWT_ACCESS_SECRET` | `openssl rand -base64 48` | apps/api | [ ] |
| `COOKIE_SECRET` | `openssl rand -base64 32` | apps/api | [ ] |
| `TOTP_ENCRYPTION_KEY` | `openssl rand -base64 32` | apps/api | [ ] |
| `VAPID_PRIVATE_KEY` (+ `VAPID_PUBLIC_KEY`) | `npx web-push generate-vapid-keys` | apps/api | [ ] |
| `IP_HASH_SECRET` | `openssl rand -base64 48` | apps/api (empreintes d'IP HMAC) | [ ] |

## Déploiement continu : secrets GitHub (docs/DEPLOY.md C5)

Page exacte : dépôt `raijin` sur GitHub → **Settings → Secrets and variables → Actions → onglet « Secrets » →
New repository secret** (`https://github.com/<compte>/raijin/settings/secrets/actions`). `bash infra/vps-install.sh`
génère les clés dans `~/.ssh` (600) et propose les commandes `gh secret set` (la clé n'est jamais affichée :
`gh` lit le fichier). Rappel GitHub Free : tout workflow de n'importe quelle branche lit ces secrets
(`docs/SECURITY.md` §17) ; aucun ne permet de démarrer la production.

| Secret | Où le trouver / le générer | Utilisé par | Créé par l'utilisateur |
|---|---|---|---|
| `DEPLOY_SSH_KEY_DEV` | clé **privée** `~/.ssh/raijin-deploy-dev` (générée par `bash infra/vps-install.sh`, sinon `ssh-keygen -t ed25519 -N '' -C github-raijin-deploy-dev -f ~/.ssh/raijin-deploy-dev`) ; `gh secret set DEPLOY_SSH_KEY_DEV --repo <compte>/raijin < ~/.ssh/raijin-deploy-dev`. Clé publique dans `~deploy-dev/.ssh/authorized_keys` (commande forcée `deploy-gate.sh dev`, posée par `infra/vps-setup.sh`) | `.github/workflows/deploy.yml`, job « dev » → `deploy-dev@VPS` | [ ] |
| `DEPOT_SSH_KEY_PROD` | clé **privée** `~/.ssh/raijin-depot-prod` (même générateur, `-C github-raijin-depot-prod`) ; `gh secret set DEPOT_SSH_KEY_PROD --repo <compte>/raijin < ~/.ssh/raijin-depot-prod`. Clé publique dans `~deploy-prod/.ssh/authorized_keys` (commande forcée `deploy-gate.sh prod-depot` : **dépôt seulement**) | `deploy.yml`, job « prod » → `deploy-prod@VPS` | [ ] |
| `DEPLOY_KNOWN_HOSTS` | `~/.ssh/raijin-known-hosts` : `ssh-keyscan -t ed25519 <IP du VPS>`, empreinte comparée à `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` sur le VPS (fait par `vps-install.sh`) ; `gh secret set DEPLOY_KNOWN_HOSTS --repo <compte>/raijin < ~/.ssh/raijin-known-hosts` (pas vraiment secret, mais épinglé) | `deploy.yml`, jobs « dev » et « prod » (`StrictHostKeyChecking=yes`) | [ ] |
| ancien `DEPLOY_SSH_KEY_PROD` | à **supprimer** s'il existe : `gh secret delete DEPLOY_SSH_KEY_PROD --repo <compte>/raijin` | plus rien (aucune clé de déploiement de prod dans GitHub) | [ ] supprimé |

Variables GitHub associées (onglet **« Variables »**, non secrètes) : `DEPLOY_HOST` (IPv4 du VPS, obligatoire),
`DEPLOY_DEV_AUTO` (interrupteur du déploiement automatique du dev : absente = désactivé ; `1` après l'installation
du VPS, `0` pour suspendre), `DEPLOY_USER_DEV` / `DEPLOY_USER_PROD` / `DEPLOY_PORT` si différents des défauts.
Après création : supprime les clés privées du PC (`shred -u ~/.ssh/raijin-deploy-dev ~/.ssh/raijin-depot-prod
~/.ssh/raijin-github-readonly`), C5 étape 7.

## Déploiement continu : secrets sur le VPS (docs/DEPLOY.md C2, C3, C5)

Fichiers `/srv/raijin/<env>/env/` en 600, lisibles par `deploy-dev` ou `deploy-prod` seul (sauf le `.env` du dev :
`root:deploy-dev` 640, lu par `deploy-dev` sans pouvoir le modifier) ; valeurs **distinctes**
entre dev et prod. Édition : `sudo -u deploy-prod nano /srv/raijin/prod/env/.env` (ou `deploy-dev` pour `dev/env/.env.api`),
`sudo nano /srv/raijin/dev/env/.env`.

| Variable / fichier | Où la trouver / la générer | Utilisé par | Fait |
|---|---|---|---|
| Clé de lecture du dépôt `~deploy-prod/.ssh/github_readonly` | clé **privée** `~/.ssh/raijin-github-readonly` (générée par `vps-install.sh`, copiée sur le VPS par `vps-setup.sh --readonly-key`) ; la clé publique va dans GitHub → **Settings → Deploy keys → Add deploy key**, titre `vps-raijin-lecture`, **sans** « Allow write access » | `deploy-gate.sh --approve` (`git ls-remote` : le commit doit être la tête de `main`) | [ ] |
| `DEV_BASIC_AUTH_USERS` (`/srv/raijin/dev/env/.env`) | demandé au clavier par `sudo bash infra/vps-setup.sh --apply` (haché bcrypt, jamais affiché), ou `htpasswd -nBC 12 <utilisateur>` (paquet `apache2-utils`), collé **entre apostrophes** (le hash contient des `$`). Mot de passe distinct de celui du banc | Traefik, middleware `raijin-dev-auth` devant app, landing et API du dev, et Mailpit (`MP_UI_AUTH`, un seul utilisateur) (`infra/docker-compose.env-dev.yml`) ; exigé par `infra/deploy.sh --env dev`. Fichier `root:deploy-dev` 640 : `sudo nano` | [ ] |
| `BENCH_BASIC_AUTH_USERS` (`/srv/raijin/prod/env/.env`) | `htpasswd -nBC 12 <utilisateur>`, **entre apostrophes** ; mot de passe distinct de celui du dev | Traefik devant `banc.raijinshield.com` (`infra/docker-compose.yml`, profil `bench`) ; exigé par `infra/deploy.sh --bench` (docs/DEPLOY.md A14) | [ ] |
| `POSTGRES_SUPERUSER_PASSWORD`, `RAIJIN_DB_PASSWORD`, `BENCH_DB_PASSWORD`, `REDIS_PASSWORD` (prod et dev), `REDIS_BENCH_PASSWORD` (prod) | **générés sur le VPS** par `infra/vps-setup.sh` (`openssl rand -hex 32`, jamais affichés) ; à la main : `openssl rand -hex 32`, une valeur par variable | Postgres, Redis, `raijin-api`, `raijin-bench-api`, `infra/deploy.sh` (contrôle ≥ 24 caractères) | [ ] vérifié |
| `JWT_ACCESS_SECRET`, `COOKIE_SECRET`, `IP_HASH_SECRET`, `TOTP_ENCRYPTION_KEY`, `VAPID_PRIVATE_KEY` (`.env.api` prod et dev) | **générés sur le VPS** par `infra/vps-setup.sh` (une paire VAPID par environnement) | `raijin-api` prod et dev | [ ] vérifié |
| `BENCH_SESSION_SECRET` (`/srv/raijin/prod/env/.env.bench-api`) | `openssl rand -base64 48` | `raijin-bench-api` (sessions, CSRF) | [ ] |
| `BENCH_TOTP_ENCRYPTION_KEY` (idem) | `openssl rand -base64 32` | `raijin-bench-api` (TOTP) | [ ] |
| `BENCH_VAPID_PRIVATE_KEY` (+ `BENCH_VAPID_PUBLIC_KEY`) (idem) | `pnpm exec web-push generate-vapid-keys --json` (paire propre au banc) | `raijin-bench-api` (push) | [ ] |
| `BENCH_JUP_API_KEY` (idem, facultatif) | https://portal.jup.ag → clé propre au banc (vide = débit public) | `raijin-bench-api` (scan porté) | [ ] |
| `BENCH_RESEND_API_KEY` (idem, si `BENCH_MAIL_TRANSPORT=resend`) | https://resend.com/api-keys → clé propre au banc, droit « Sending access » seul — service pas encore créé | `raijin-bench-api` (alertes e-mail) | [ ] |
| Clés B2 et mots de passe du remote rclone chiffré (`~/.config/rclone/rclone.conf` de root) | https://secure.backblaze.com/app_keys.htm → clé limitée au bucket `raijin-backups-…` ; `sudo rclone config` (docs/DEPLOY.md A9) ; recopier les deux mots de passe `crypt` dans ton gestionnaire — service pas encore créé | `infra/backup.sh` (copie hors site, `BACKUP_RCLONE_REMOTE`) | [ ] |

Bot Telegram : pas encore développé (aucune variable dans `docs/ENV.md`) ; ses secrets seront ajoutés ici avec lui.

> **2026-11-26** : `HELIUS_API_KEY` copiée par l'utilisateur ; `BENCH_HELIUS_API_KEY` copiée (clé « raijin-banc-de-test »).

## Notes Helius (non secrètes)
- Plan **Free** : 1 M crédits/mois, RPC 10 req/s, DAS 2 req/s, `getProgramAccounts` 5 req/s, `sendTransaction` 1 req/s (inutile : lecture seule). Pas de crédits additionnels sur ce plan.
- Les deux clés partagent le même projet, donc **le même quota** (1 M crédits, 10 req/s au total) : prévoir le rate limiting en conséquence.
- URL RPC : `https://mainnet.helius-rpc.com/?api-key=<clé>` (la clé passe en paramètre : ne jamais journaliser l'URL complète).
- Clés sans restriction pour l'instant. **Phase 8 ter** : restreindre `raijin-api` et `raijin-banc-de-test` par IP (ou CIDR) du VPS dans API Keys → Access control. Pas de restriction par domaine (clés serveur).
