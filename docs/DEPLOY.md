# Déploiement — Raijin Shield

Ce guide est écrit pour quelqu'un qui n'a jamais déployé d'application. Suis-le **dans l'ordre**, une commande à la
fois, en lisant ce qu'elle affiche avant de passer à la suivante.

- **Partie A** : mise en ligne sur le VPS (Docker Compose derrière le Traefik déjà en place, DNS, variables, clés
  VAPID, webhook Stripe, sauvegardes, surveillance, mises à jour, retour arrière).
- **Partie B** : espace admin, Google (GA4, Search Console, compte de service) et landing.
- **Partie C** : environnements dev/prod et déploiement continu (push sur `dev` → dev.raijinshield.com automatiquement ;
  fusion dans `main` → archive de production déposée sur le VPS, que tu actives par une commande), à mettre en place
  une fois la partie A comprise.

Rappels :
- les secrets ne vont **que** dans `infra/.env` et `infra/.env.api` sur le serveur (jamais dans Git, jamais dans un
  ticket ou un chat) ;
- c'est toi qui lances les commandes sur le VPS : aucun agent ne s'y connecte ;
- chaque variable est décrite dans `docs/ENV.md` (le bloc « Production (VPS) » pour `infra/.env`) ;
- **MyTradingCoach et XMR Trader tournent sur le même VPS** : aucune commande de ce guide ne les touche. Ne lance
  jamais `docker compose down`, `docker system prune`, `docker volume prune` ou `docker network prune` : ces commandes
  peuvent supprimer des données d'autres projets.

---

# Partie A — Mise en ligne sur le VPS

## A0. Vue d'ensemble

```
Internet ──443──► Traefik (déjà là, MTC) ──► raijin-landing  (nginx)  raijinshield.com   (www → 301)
                                         ├──► raijin-web      (nginx)  app.raijinshield.com
                                         ├──► raijin-api      (Node)   api.raijinshield.com
                                         │                             + app.raijinshield.com/api/*  et  /t/*
                                         └──► raijin-bench-*  (8 bis)  banc.raijinshield.com (mot de passe Traefik)
                     réseau interne « raijin-internal » (sans accès extérieur) :
                     raijin-postgres (bases raijin + raijin_bench) · raijin-redis
```

- Tout est dans `infra/` : `docker-compose.yml` (projet Compose `raijin`), `docker/Dockerfile` (images),
  `nginx/` (serveurs statiques), `postgres/init/` (bases et utilisateurs), `deploy.sh`, `backup.sh`, `restore.sh`,
  `watchdog.sh`, `systemd/` (tâches planifiées).
- Raijin **ne publie aucun port** sur le VPS : seul Traefik reçoit le trafic et le transmet par le réseau Docker.
- Le front appelle l'API en **même origine** (`https://app.raijinshield.com/api/v1`) : pas de CORS ni de cookie
  partagé entre sous-domaines. `api.raijinshield.com` sert au webhook Stripe, aux images Open Graph et à la santé.
- `https://app.raijinshield.com/t/<mint>` (page publique partagée) est servi par l'API, qui y injecte les balises
  Open Graph ; si l'API est indisponible, Traefik affiche la page statique de maintenance.
- En-têtes de sécurité (CSP par application, HSTS, nosniff, Referrer-Policy, Permissions-Policy, COOP), compression
  et limite de débit de l'API : posés par Traefik (labels de `infra/docker-compose.yml`).

Pour raccourcir les commandes, crée cet alias (à mettre dans `~/.bashrc`), puis lance toujours les commandes depuis
le dossier du dépôt :

```bash
alias rj='docker compose --project-name raijin --env-file infra/.env -f infra/docker-compose.yml'
# exemples : rj ps · rj logs --tail 100 raijin-api · rj up -d raijin-api
```

## A1. Prérequis sur le VPS

Connecte-toi au VPS (`ssh ton-utilisateur@ip-du-vps`) puis vérifie :

```bash
free -h                     # colonne « disponible » : au moins 2,6 Go pour le premier build, 1,5 Go ensuite
df -h /                     # au moins 10 Go libres (images, build, sauvegardes)
docker version              # Docker 24 ou plus
docker compose version      # 2.24 ou plus (sinon : mets à jour le paquet docker-compose-plugin) ;
                            # deploy.sh affiche la version et refuse en dessous (env_file « required », up --wait)
git --version && curl --version | head -1
```

- **RAM** : la consommation attendue de chaque conteneur est en A13. Si `free -h` affiche moins de 2,6 Go
  disponibles, le build (≈ 2 à 2,5 Go pendant quelques minutes) peut ralentir MTC : lance-le à une heure creuse, ou
  ajoute un fichier d'échange de 2 Go (commandes `fallocate`, `mkswap`, `swapon` : documentation de ta distribution,
  par exemple <https://help.ubuntu.com/community/SwapFaq>). `infra/deploy.sh` mesure la RAM disponible et te demande
  confirmation si elle est trop basse.
- Ton utilisateur doit pouvoir lancer `docker` sans `sudo` (groupe `docker`) : `groups` doit afficher `docker`.
- Outils des sauvegardes et du mot de passe du banc : `sudo apt install rclone apache2-utils`.

## A2. Repérer le Traefik existant (lecture seule)

Raijin se branche sur le Traefik de MTC **sans le modifier**. Il te faut 3 noms, à reporter dans `infra/.env`.

1. **Le réseau Docker de Traefik** → `TRAEFIK_NETWORK` :
   ```bash
   docker ps --format '{{.Names}}\t{{.Image}}' | grep -i traefik      # nom du conteneur, ex. mtc-traefik
   docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' <conteneur-traefik>
   docker network ls                                                  # le même nom doit apparaître ici
   ```
   Si Traefik est sur plusieurs réseaux, prends celui que les conteneurs de MTC utilisent pour être joints (souvent
   `traefik`, `proxy` ou `web`).
2. **L'entrypoint HTTPS** → `TRAEFIK_ENTRYPOINT` (souvent `websecure`) et **le certresolver Let's Encrypt** →
   `TRAEFIK_CERTRESOLVER` (souvent `letsencrypt` ou `le`). Ils sont dans la configuration de Traefik :
   ```bash
   docker inspect -f '{{json .Args}}' <conteneur-traefik>    # options --entrypoints.XXX et --certificatesresolvers.YYY
   ```
   Si la liste est vide, la configuration est dans un fichier `traefik.yml` / `traefik.toml` monté dans le conteneur
   (`docker inspect -f '{{json .Mounts}}' <conteneur-traefik>`) : ouvre-le **en lecture** (`less`), sans le modifier.
   Cherche `entryPoints:` et `certificatesResolvers:`.
3. Vérifie au passage, dans la même configuration :
   - `exposedByDefault` : Raijin pose `traefik.enable=true` sur chaque service exposé, donc ça marche dans les deux cas ;
   - la **redirection HTTP → HTTPS** sur l'entrypoint `web` (port 80) : elle est en général déjà globale ; sinon
     les adresses `http://` ne redirigeront pas (le reste fonctionne) ;
   - une éventuelle option `constraints` du fournisseur Docker (filtre des conteneurs pris en compte) : si elle
     existe, note-la et demande avant d'ajouter le label correspondant ;
   - la **version** : `docker exec <conteneur-traefik> traefik version` (v2.11 ou v3 : les labels de Raijin
     fonctionnent avec les deux).

## A3. DNS chez OVH

Dans l'espace client OVH : **Web Cloud → Noms de domaine → raijinshield.com → Zone DNS → Ajouter une entrée**.
Adresse IPv4 du VPS : `<IP du VPS>` (variable GitHub `DEPLOY_HOST` ; à lire avec `curl -4 ifconfig.me` sur le VPS ; `curl -6 ifconfig.me`
pour l'IPv6, s'il en a une).

| Type | Sous-domaine | Cible | Environnement | Rôle |
|---|---|---|---|---|
| A | *(vide)* | `<IP du VPS>` | prod | landing `raijinshield.com` |
| A | `www` | `<IP du VPS>` | prod | redirection 301 vers `raijinshield.com` |
| A | `app` | `<IP du VPS>` | prod | application |
| A | `api` | `<IP du VPS>` | prod | API (webhook Stripe, images OG) |
| A | `banc` | `<IP du VPS>` | prod | banc de test (phase 8 bis) |
| A | `dev` | `<IP du VPS>` | dev | application dev `dev.raijinshield.com` (mot de passe, partie C) |
| A | `api-dev` | `<IP du VPS>` | dev | API dev (webhook Stripe **test**, santé, images OG) |
| A | `landing-dev` | `<IP du VPS>` | dev | landing dev (mot de passe) |
| AAAA | les mêmes 8 | IPv6 du VPS | | **seulement** si le VPS a une IPv6 et que Traefik écoute en IPv6 |

Pas de `www` pour le dev, ni d'enregistrement générique (`*`) : chaque nom a son certificat Let's Encrypt, demandé
par Traefik à la première visite. Les noms du dev sont « à plat » (`api-dev`, pas `api.dev`) : ni certificat
générique, ni cookie partagé ; les cookies de l'API sont liés à leur hôte (`COOKIE_DOMAIN` vide) et le front appelle
l'API en même origine (`https://dev.raijinshield.com/api/v1`), donc aucun cookie ni CORS commun entre dev et prod.

- TTL : 3600 (par défaut). Un éventuel enregistrement A « parking » d'OVH sur la racine ou `www` doit être remplacé
  (note sa valeur dans `docs/OPS-LOG.md` avant). **Ne touche pas** aux enregistrements MX, TXT (SPF, DKIM de Resend,
  vérification Google) ni CNAME existants.
- Optionnel, recommandé : un enregistrement **CAA** sur la racine, `0 issue "letsencrypt.org"` (seul Let's Encrypt
  peut alors émettre un certificat pour le domaine).
- Vérifie la propagation (quelques minutes à quelques heures) : `dig +short A app.raijinshield.com` doit afficher
  l'IP du VPS ; fais de même pour `raijinshield.com`, `www`, `api`, `banc`, `dev`, `api-dev` et `landing-dev`.
- Le certificat HTTPS de chaque nom est demandé par Traefik **à la première visite**, une fois le DNS propagé.

## A4. Récupérer le code sur le VPS

```bash
sudo mkdir -p /opt/raijin && sudo chown "$USER": /opt/raijin
git clone https://github.com/<ton-compte>/raijin.git /opt/raijin    # dépôt privé : voir ci-dessous
cd /opt/raijin
git switch main        # la branche fusionnée après validation de la PR (ou dev pour un essai)
```

Pour un dépôt privé, le plus simple : `sudo apt install gh && gh auth login` (choisir HTTPS, ouvrir le lien dans ton
navigateur). Alternative : une **clé de déploiement en lecture seule** (GitHub → dépôt → Settings → Deploy keys).

## A5. Fichiers de variables

Deux fichiers, **jamais commités** (déjà ignorés par `.gitignore`), dans `infra/` :

```bash
cd /opt/raijin
nano infra/.env          # copie le modèle « Production (VPS) » de docs/ENV.md, puis remplace les valeurs
nano infra/.env.api      # copie le bloc principal de docs/ENV.md, puis remplace les valeurs (voir ci-dessous)
chmod 600 infra/.env infra/.env.api
```

**Générer les secrets** (une commande par valeur ; copie le résultat dans le fichier, ne le colle nulle part ailleurs) :

| Variable | Fichier | Commande |
|---|---|---|
| `POSTGRES_SUPERUSER_PASSWORD`, `RAIJIN_DB_PASSWORD`, `BENCH_DB_PASSWORD`, `REDIS_PASSWORD` (utilisateur Redis `raijin-api`) | `infra/.env` | `openssl rand -hex 32` (une valeur différente chacune) |
| `REDIS_BENCH_PASSWORD` (utilisateur Redis `raijin-bench`, banc seulement, A14) | `infra/.env` | `openssl rand -hex 32` (différent de `REDIS_PASSWORD`) |
| `JWT_ACCESS_SECRET`, `IP_HASH_SECRET` | `infra/.env.api` | `openssl rand -base64 48` |
| `COOKIE_SECRET`, `TOTP_ENCRYPTION_KEY` | `infra/.env.api` | `openssl rand -base64 32` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | `infra/.env.api` | section A6 |
| `STRIPE_WEBHOOK_SECRET` | `infra/.env.api` | section A7 |

**Valeurs à prendre dans les tableaux de bord** (détail dans `docs/ENV.md` et `docs/SECRETS-CHECKLIST.md`) :

| Variable (`infra/.env.api`) | Où la trouver |
|---|---|
| `RESEND_API_KEY` (+ `MAIL_PROVIDER=resend`) | <https://resend.com/api-keys> (domaine `raijinshield.com` vérifié sur <https://resend.com/domains>) |
| `HELIUS_API_KEY` | <https://dashboard.helius.dev/api-keys> (clé « raijin-api » ; restreins-la à l'IP du VPS) |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_YEARLY` (+ `BILLING_PROVIDER=stripe`) | <https://dashboard.stripe.com/test/apikeys> et <https://dashboard.stripe.com/test/products> (mode test tant que tu n'as pas activé le mode réel) |
| `GA4_PROPERTY_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `SEARCH_CONSOLE_SITE_URL` | partie B, sections 2 à 4 |
| `SENTRY_DSN_API` (+ `SENTRY_ENVIRONMENT=production`) | <https://sentry.io/settings/projects/> → projet → Client Keys |

**Dans `infra/.env`** : les 3 noms Traefik (A2), les domaines, `GA4_MEASUREMENT_ID` (public, partie B §2),
`WATCHDOG_ALERT_EMAIL` (ton adresse), `BACKUP_RCLONE_REMOTE` (A9).

Ce que tu n'as **pas** à mettre dans `infra/.env.api` : `NODE_ENV`, `API_PORT`, `DATABASE_URL`, `REDIS_URL`, `APP_URL`,
`API_URL`, `LANDING_URL`, `CORS_ORIGINS`, `TRUST_PROXY`, `COOKIE_SECURE`, `WEB_INDEX_HTML_PATH` : ils sont imposés par
`infra/docker-compose.yml` à partir de `infra/.env`.

> L'API **refuse de démarrer** en production si un secret est absent, factice ou trop court, ou si un mode de test est
> activé (`BILLING_PROVIDER=fake`, `ANALYSIS_FIXTURES=1`, `PUSH_PROVIDER=fake`…) : le message cite la variable, jamais
> sa valeur (`rj logs raijin-api`). Liste complète : `docs/ENV.md`, « Validation au démarrage ».

## A6. Clés VAPID (notifications push)

Une paire **propre à la production** (ne réutilise pas celle de ton PC : changer de paire plus tard désabonne tous les
appareils). Sur ton PC, dans le dépôt :

```bash
pnpm exec web-push generate-vapid-keys --json
```

ou sur le VPS après un premier build (`infra/deploy.sh`) :

```bash
docker run --rm --entrypoint node raijin/api:latest -e \
  "console.log(JSON.stringify(require('/app/dist/apps/api/node_modules/web-push').generateVAPIDKeys(),null,1))"
```

Copie `publicKey` → `VAPID_PUBLIC_KEY` et `privateKey` → `VAPID_PRIVATE_KEY` dans `infra/.env.api` (la clé privée
ne va nulle part ailleurs), garde `VAPID_SUBJECT=mailto:support@raijinshield.com`, puis `rj up -d raijin-api`.
Vérification : `curl -s https://api.raijinshield.com/api/v1/push/vapid-public-key` renvoie la clé **publique**.

## A7. Webhook Stripe de production

1. Stripe → **Développeurs → Webhooks → Ajouter un endpoint** (<https://dashboard.stripe.com/test/webhooks> en mode
   test ; la même page sans `/test` en mode réel, avec un endpoint et un secret **distincts**).
2. URL : `https://api.raijinshield.com/api/v1/billing/webhook`.
3. Version d'API : celle de `STRIPE_API_VERSION` dans `libs/api/billing/src/lib/provider/stripe-billing.provider.ts`.
4. Événements : `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_failed`, `invoice.paid`.
5. Ouvre l'endpoint créé → **Clé de signature** (« Signing secret », `whsec_…`) → **Révéler** → copie-la dans
   `STRIPE_WEBHOOK_SECRET` de `infra/.env.api`, puis `rj up -d raijin-api`.
6. Test : sur la page de l'endpoint, **Envoyer un événement test** (`invoice.paid`) → la réponse doit être `200`.
   Puis un paiement de bout en bout avec la carte `4242 4242 4242 4242` (mode test).

> L'activation du **mode réel** (`sk_live_…`) est ta décision : elle demande d'avoir complété le compte Stripe
> (identité, IBAN). Refais alors les étapes 1 à 5 en mode réel et remplace `STRIPE_SECRET_KEY`, les deux
> `STRIPE_PRICE_*` et `STRIPE_WEBHOOK_SECRET`.

## A8. Premier déploiement

```bash
cd /opt/raijin
infra/deploy.sh
```

Le script : vérifie les prérequis (fichiers, variables, réseau Traefik, RAM, disque) → construit les images une par
une (10 à 20 min la première fois) → démarre Postgres et Redis → crée les bases et les utilisateurs → sauvegarde la
base si elle contient déjà des données → applique les migrations Prisma (`migrate deploy`) → démarre l'API, l'app et
la landing en attendant leurs healthchecks → teste les adresses HTTPS depuis l'extérieur. Il ne supprime jamais rien.

Vérifications après le déploiement :

```bash
rj ps                                                     # tous « healthy »
curl -s https://api.raijinshield.com/api/v1/health        # {"status":"ok","service":"raijin-api","database":"up"}
curl -sI https://raijinshield.com | grep -iE 'strict-transport|content-security|x-content-type'
curl -sI https://www.raijinshield.com | head -3           # 301 → https://raijinshield.com/
curl -sI https://raijinshield.com/tarifs.html | head -3   # 301 → /tarifs
curl -sI https://app.raijinshield.com/t/DezXAZ8z7PnrnLZxU5PfJLQ1uXWuqxbUzvsCiAq4Sg8D | grep -i content-type   # text/html
```

Puis, dans le navigateur : la landing, l'inscription sur l'app, l'e-mail de confirmation, une analyse, et
<https://securityheaders.com> sur `raijinshield.com` et `app.raijinshield.com` (note attendue : A ou A+).

**Donner le rôle ADMIN à ton compte** (après avoir confirmé ton e-mail) : partie B, section 1, commande « VPS ».

> HSTS est envoyé avec `preload` : ne soumets le domaine sur <https://hstspreload.org> qu'après quelques semaines
> sans problème (le retrait de la liste prend des mois).

## A9. Sauvegardes (quotidiennes, 7 jours en local, copie hors site sur B2)

1. Dossier local : `sudo mkdir -p /var/backups/raijin && sudo chown "$USER": /var/backups/raijin && chmod 700 /var/backups/raijin`.
2. Bucket **dédié** chez Backblaze B2 (séparé de celui de MTC s'il existe) : <https://secure.backblaze.com/b2_buckets.htm>
   → **Create a Bucket** → nom `raijin-backups-<suffixe>`, **Private**, chiffrement par défaut activé.
   Onglet **Lifecycle Settings** : garder les versions précédentes 30 jours (les copies distantes vivent 30 jours ;
   le script ne supprime jamais rien à distance).
3. Clé limitée à ce bucket : <https://secure.backblaze.com/app_keys.htm> → **Add a New Application Key** → bucket
   `raijin-backups-…` seulement, accès **Read and Write**. Note `keyID` et `applicationKey` (affichée une seule fois).
4. Configure rclone **sur le VPS** (les clés restent dans `~/.config/rclone/rclone.conf`) :
   ```bash
   rclone config
   #  n → nom : raijin-b2 → type : b2 → account : <keyID> → key : <applicationKey> → hard_delete : false → (défauts)
   #  n → nom : raijin-b2-crypt → type : crypt → remote : raijin-b2:raijin-backups-<suffixe>
   #      → filename_encryption : standard → password : g (généré) → password2 : g
   #  IMPORTANT : recopie les deux mots de passe du remote crypt dans ton gestionnaire de mots de passe.
   #  Sans eux, les sauvegardes distantes sont illisibles.
   chmod 600 ~/.config/rclone/rclone.conf
   ```
   Dans `infra/.env` : `BACKUP_RCLONE_REMOTE=raijin-b2-crypt:postgres`.
5. Premier essai à la main : `infra/backup.sh` puis `rclone ls raijin-b2-crypt:postgres` (les fichiers apparaissent).
6. Planification (tous les jours à 04:15) : copie les unités en remplaçant `/opt/raijin` par le chemin du dépôt et
   `User=deploy` par ton utilisateur :
   ```bash
   sed "s#/opt/raijin#$PWD#g; s#User=deploy#User=$USER#" infra/systemd/raijin-backup.service | sudo tee /etc/systemd/system/raijin-backup.service >/dev/null
   sudo cp infra/systemd/raijin-backup.timer /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now raijin-backup.timer
   systemctl list-timers raijin-backup.timer          # prochaine exécution
   journalctl -u raijin-backup.service -n 50          # journal de la dernière sauvegarde
   ```
   Équivalent cron si tu préfères (`crontab -e`) : `15 4 * * * /opt/raijin/infra/backup.sh >> /var/backups/raijin/backup.log 2>&1`.

Ce que fait `infra/backup.sh` : `pg_dump` (format compressé) de `raijin` et de `raijin_bench` (si elle existe),
contrôle de chaque fichier, empreinte sha256, rotation des fichiers locaux de plus de 7 jours, copie sur B2, et
**alerte** (e-mail + push) en cas d'échec. Les fichiers contiennent des données personnelles (e-mails) : le dossier
est en `700` et la copie distante est chiffrée.

## A10. Restauration

**Test mensuel (sans risque)** : restaure la dernière sauvegarde dans une base de test jetable, puis la supprime.

```bash
infra/restore.sh --check "$(ls -t /var/backups/raijin/raijin_2*.dump | head -1)"
# … RESTAURATION DE TEST RÉUSSIE (tables, migrations Prisma, nombre de comptes affichés)
```

Pour un fichier venant de B2 : `rclone copy raijin-b2-crypt:postgres/raijin_AAAAMMJJ-HHMMSS.dump /tmp/` (et le `.sha256`).

**Restauration réelle** (perte de données, erreur de manipulation) :

```bash
infra/restore.sh --into raijin /var/backups/raijin/raijin_AAAAMMJJ-HHMMSS.dump
# demande de taper : RESTAURER raijin
```

Le script arrête l'API, **renomme** la base actuelle en `raijin_avant_restauration_<date>` (rien n'est supprimé),
recrée une base vide, restaure, contrôle, puis redémarre l'API. En cas d'échec, la base d'origine est remise en
place automatiquement. Quand tout est vérifié, supprime l'ancienne base avec la commande affichée à la fin.
Après une restauration, relance `infra/deploy.sh --skip-build` si la sauvegarde est antérieure à une migration.

## A11. Surveillance et alertes

- **Healthchecks Docker** sur chaque conteneur (`rj ps` affiche `healthy`) ; Traefik retire l'API de la rotation si
  `/api/v1/health` échoue.
- **Veille** `infra/watchdog.sh` toutes les 2 minutes : conteneurs arrêtés ou `unhealthy`, adresses HTTPS
  injoignables (DNS, certificat, Traefik), disque à 85 %, RAM disponible < 200 Mo, sauvegarde de plus de 26 h.
  Alerte après 2 échecs de suite, rappel toutes les 6 h, message de retour à la normale. Canaux : **e-mail** par
  l'API HTTP de Resend (fonctionne même si l'API Raijin est tombée ; adresse `WATCHDOG_ALERT_EMAIL`) et **push** sur
  les appareils des comptes ADMIN via la CLI de l'API (commande `notify-admins`, si l'API et la base répondent).
  ```bash
  infra/watchdog.sh --dry-run                       # état actuel, sans alerter
  sed "s#/opt/raijin#$PWD#g; s#User=deploy#User=$USER#" infra/systemd/raijin-watchdog.service | sudo tee /etc/systemd/system/raijin-watchdog.service >/dev/null
  sudo cp infra/systemd/raijin-watchdog.timer /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl enable --now raijin-watchdog.timer
  ```
  Cron équivalent : `*/2 * * * * WATCHDOG_STATE_DIR=$HOME/.local/state/raijin-watchdog /opt/raijin/infra/watchdog.sh >/dev/null 2>&1`.
  **Test d'alerte** : arrête `raijin-landing` (`rj stop raijin-landing`), attends 5 minutes (e-mail reçu), puis
  `rj up -d raijin-landing` (e-mail « Retour à la normale »).
- **Depuis l'extérieur** (phase 8 ter) : UptimeRobot sur `https://api.raijinshield.com/api/v1/health` et
  `https://raijinshield.com` (prévient même si le VPS entier est éteint).
- **Journaux** : `rj logs --tail 200 raijin-api` (3 fichiers de 10 Mo max par conteneur, rotation automatique).
- **Admin** : `https://app.raijinshield.com/admin/sante` (jobs, quotas, services configurés).

Dépannage rapide :

| Symptôme | Piste |
|---|---|
| `404 page not found` (texte brut) | routeur Traefik absent : `TRAEFIK_NETWORK` ou `TRAEFIK_ENTRYPOINT` faux, ou conteneur arrêté (`rj ps`) |
| erreur de certificat | DNS pas encore propagé, port 80 fermé pour le challenge, ou `TRAEFIK_CERTRESOLVER` faux : `docker logs <conteneur-traefik> 2>&1 \| grep -i raijin` |
| `raijin-api` redémarre en boucle | `rj logs raijin-api` : variable refusée au démarrage (le message la nomme) |
| `502 Bad Gateway` | conteneur pas encore `healthy` (attendre 1 min) ou mauvais réseau |
| page blanche sur l'app | CSP : console du navigateur (F12) ; transmets le message pour corriger `infra/docker-compose.yml` |

## A12. Mettre à jour, revenir en arrière

**Mise à jour** (après la fusion d'une PR) :

```bash
cd /opt/raijin && git pull --ff-only && infra/deploy.sh
```

Une fois le déploiement continu en place (partie C), la fusion dans `main` dépose l'archive de production et tu
l'actives par `deploy-gate.sh --approve <commit>` (C6) : ces commandes ne servent plus qu'au dépannage.

Chaque build étiquette les images `:<commit>`. Seul un déploiement **réussi** déplace les étiquettes de secours :
la nouvelle version devient `:deployed` et l'ancienne `:previous` (un déploiement raté ne les touche jamais).

**Retour arrière** (la nouvelle version pose problème) :

```bash
infra/deploy.sh --rollback        # sans build ni migration : après un déploiement raté, revient à `:deployed`
                                  # (dernière version réussie) ; sinon, à `:previous` (celle d'avant)
```

Les **migrations de base ne sont pas annulées** (Prisma ne fait que des migrations vers l'avant). Si une migration a
cassé quelque chose, restaure la sauvegarde faite juste avant (`/var/backups/raijin/raijin_<date du déploiement>.dump`,
section A10), puis `infra/deploy.sh --rollback`. Revenir à un commit précis :
`git switch --detach <commit> && infra/deploy.sh` (puis `git switch main` plus tard).

**Maintenance programmée** : `MAINTENANCE_MODE=1` dans `infra/.env.api` puis `rj up -d raijin-api` (l'API répond 503
`MAINTENANCE`, l'app affiche sa page de maintenance) ; remets `0` ensuite.

**Anciennes images** (seulement celles de Raijin) : `docker images 'raijin/*'`, puis retire une ancienne étiquette
avec `docker image rm raijin/api:<ancien-commit>` (garde `latest` et `previous`). N'utilise pas `docker system prune`.

## A13. Consommation mémoire attendue

Chaque conteneur a une limite (`mem_limit`, sans swap) et un plafond CPU, pour qu'un problème de Raijin ne puisse pas
priver MTC de mémoire. Vérifie en conditions réelles avec `docker stats --no-stream $(docker ps -q --filter name=raijin-)`.

| Conteneur | Limite mémoire | Habituel | CPU max |
|---|---|---|---|
| `raijin-postgres` | 512 Mo | 80 à 200 Mo | 1 |
| `raijin-redis` | 256 Mo (données ≤ 200 Mo, `noeviction`) | 10 à 60 Mo | 0,5 |
| `raijin-api` | 512 Mo (tas Node 384 Mo) | 180 à 320 Mo | 1 |
| `raijin-web` | 48 Mo | 5 à 10 Mo | 0,25 |
| `raijin-landing` | 48 Mo | 5 à 10 Mo | 0,25 |
| **Total Raijin** | **≈ 1,4 Go** | **≈ 300 à 600 Mo** | |
| `raijin-bench-api` (8 bis) | 384 Mo | 150 à 250 Mo | 0,75 |
| `raijin-bench-web` (8 bis) | 48 Mo | 5 à 10 Mo | 0,25 |
| **Total avec le banc** | **≈ 1,8 Go** | **≈ 450 à 850 Mo** | |
| build (`deploy.sh`, temporaire) | — | 2 à 2,5 Go pendant 10 à 20 min | |

Disque : ≈ 3 Go pour les images et le cache de build, plus les sauvegardes (7 jours) et la base.

## A14. Banc de test (`banc.raijinshield.com`, phase 8 bis)

Profil Compose `bench` : `raijin-bench-api` (API du banc), `raijin-bench-web` (front), et `raijin-bench-migrate`
(profil `tools`, migrations de `raijin_bench` avec l'utilisateur `raijin_bench`, sans droit sur `raijin`). Double
verrou : mot de passe Traefik (basicAuth) devant tout le domaine, puis compte unique du banc (mot de passe + TOTP).
Jamais indexé (`X-Robots-Tag: noindex, nofollow`, `robots.txt` `Disallow: /`). Procédure de bascule et de retour
arrière : `docs/BENCH.md`.

1. **DNS** : enregistrement `A` `banc` → IPv4 du VPS (A3).
2. **Mot de passe Traefik** (sur le VPS, paquet `apache2-utils`, A1) :
   ```bash
   htpasswd -nBC 12 kyoshiro      # tape le mot de passe deux fois ; bcrypt de coût 12
   ```
   Copie la ligne `kyoshiro:$2y$12$…` **entre apostrophes** dans `infra/.env` : `BENCH_BASIC_AUTH_USERS='kyoshiro:$2y$12$…'`.
3. **Utilisateur Redis du banc** : `openssl rand -hex 32` → `REDIS_BENCH_PASSWORD` dans `infra/.env` (différent de
   `REDIS_PASSWORD`). Redis applique une ACL par application : l'API Raijin (`raijin-api`) ne voit que `raijin:*`, le
   banc (`raijin-bench`) que `raijin-bench:*`, l'utilisateur `default` est désactivé.
4. **Variables de l'API du banc** :
   ```bash
   cd /opt/raijin
   nano infra/.env.bench-api      # copie le bloc « Banc » de docs/ENV.md (socle, Helius, collecte T7), puis remplace les valeurs
   chmod 600 infra/.env.bench-api
   ```
   | Variable (`infra/.env.bench-api`) | Où la trouver / commande |
   |---|---|
   | `BENCH_MODE` | `shadow` jusqu'à la bascule (`docs/BENCH.md`), puis `primary` |
   | `BENCH_OWNER_EMAIL` | ton adresse (compte unique du banc) |
   | `BENCH_SESSION_SECRET` | `openssl rand -base64 48` |
   | `BENCH_TOTP_ENCRYPTION_KEY` | `openssl rand -base64 32` |
   | `BENCH_VAPID_PUBLIC_KEY`, `BENCH_VAPID_PRIVATE_KEY` | `pnpm exec web-push generate-vapid-keys --json` (paire **propre au banc**, A6) |
   | `BENCH_HELIUS_API_KEY` | <https://dashboard.helius.dev/api-keys> (clé « raijin-banc-de-test », distincte de celle de Raijin) |
   | `BENCH_JUP_API_KEY` (+ `BENCH_JUP_API_BASE`) | <https://portal.jup.ag> (clé propre au banc) ; vide = `lite-api.jup.ag` sans clé |
   | `BENCH_MIN_MARKET_CAP`, `BENCH_MIN_LIQUIDITY` | filtres du scan en USD (défauts de l'ancien banc : 50000 et 10000) |
   | `BENCH_SCAN_KEYWORDS` | mots-clés DexScreener séparés par des virgules (<https://docs.dexscreener.com/api/reference>) ; vide = aucun |
   | `BENCH_VERDICTS_PER_RUN` | verdicts mesurés par passage (défaut 6, max 20 ; ≈ 14 crédits Helius chacun) |
   | `BENCH_MAIL_TRANSPORT` | `none` (défaut), `resend` ou `smtp` ; aucun e-mail en mode `shadow` |
   | `BENCH_RESEND_API_KEY` (si `resend`) | <https://resend.com/api-keys> (clé propre au banc, « Sending access » seul) |
   | `BENCH_SMTP_URL` (si `smtp`) | `smtps://utilisateur:motdepasse@hôte:465` de ton fournisseur SMTP |
   | `BENCH_MAIL_FROM`, `BENCH_ALERT_EMAIL` | expéditeur sur un domaine vérifié (<https://resend.com/domains>) ; destinataire (vide = `BENCH_OWNER_EMAIL`) |

   Imposées par le compose (inutile de les écrire) : `BENCH_DATABASE_URL`, `BENCH_REDIS_URL`, `BENCH_ALLOWED_ORIGINS`,
   `BULLMQ_PREFIX`, `TRUST_PROXY`, `COOKIE_SECURE`, `NODE_ENV`, `API_PORT`.
5. **Déploiement** :
   ```bash
   infra/deploy.sh --bench
   ```
   En plus du déploiement habituel : vérifie `infra/.env.bench-api`, `BENCH_BASIC_AUTH_USERS` et `REDIS_BENCH_PASSWORD`,
   construit `raijin-bench-api`, `raijin-bench-web` et `raijin-bench-migrate`, sauvegarde les deux bases si elles
   contiennent déjà des migrations, applique les migrations de `raijin_bench`, démarre le banc puis contrôle que
   `https://banc.raijinshield.com/` et `/api/health` répondent **401 sans mot de passe**. Les déploiements suivants
   (mises à jour, `--rollback`) se font aussi avec `--bench`, sinon le banc garde ses anciennes images.
6. **Vérifications** :
   ```bash
   rj ps                                                            # raijin-bench-api et raijin-bench-web « healthy »
   curl -sI https://banc.raijinshield.com/ | head -1                # 401 (basicAuth)
   curl -s -u kyoshiro https://banc.raijinshield.com/api/health     # {"status":"ok"} (mot de passe Traefik demandé)
   curl -s -u kyoshiro https://banc.raijinshield.com/robots.txt     # Disallow: /
   ```
   Puis le compte du banc, par la CLI de l'image (`create-owner` la première fois ; ensuite `set-password` pour changer
   le mot de passe, `reset-2fa` pour un nouveau TOTP ; détails dans `docs/BENCH.md`) :
   ```bash
   docker exec -it raijin-bench-api node dist/apps/raijin-banc-de-test-api/cli.js create-owner
   ```

Sauvegardes : `infra/backup.sh` sauvegarde `raijin_bench` avec `raijin` (A9) ; restauration :
`infra/restore.sh --into raijin_bench FICHIER.dump` (A10). Migration de l'historique Supabase : `infra/bench-migrate.sh`
(`docs/BENCH.md`).

## A15. Limites connues (audit de la phase 8, à traiter plus tard)

- **Pas de CDN ni de proxy devant Traefik** (Cloudflare en mode « proxy », etc.). L'API fait confiance à **un seul**
  saut (`TRUST_PROXY=1`) : avec un proxy de plus, toutes les requêtes auraient l'IP du proxy (quotas et verrouillages
  communs à tout le monde). Si un jour un CDN est ajouté : `TRUST_PROXY=2` et `forwardedHeaders.trustedIPs` de
  Traefik limités aux plages du CDN, sinon l'en-tête `X-Forwarded-For` devient falsifiable.
- **Réseau Traefik partagé** : tout conteneur de ce réseau (MTC compris) peut joindre `raijin-api:3000` sans passer
  par Traefik et forger `X-Forwarded-For` (contournement des limites par IP, pas d'accès aux comptes). Piste : limiter
  la confiance de l'API au sous-réseau de Traefik (`trust proxy` sur une liste d'adresses au lieu d'un nombre), ou un
  réseau dédié Traefik ↔ Raijin si la configuration de Traefik le permet. Décision à prendre avant l'ouverture publique.
- **Redis partagé par l'API et le banc** : traité en phase 8 bis par des **ACL Redis** par application (`raijin-api`
  limité à `raijin:*`, `raijin-bench` à `raijin-bench:*`, `default` désactivé, commandes d'administration refusées ;
  A14). Contrôlé à chaque run du job CI `images` (`infra/ci/check-stack.sh`).
- **Trivy** n'est qu'un rapport dans la CI : il deviendra **bloquant sur les vulnérabilités CRITICAL corrigeables**
  après la v1.

---

# Partie B — Admin, Google et landing

## 1. Donner le rôle ADMIN à ton compte

Le rôle ADMIN ne s'attribue **jamais** depuis l'interface : uniquement par une commande, sur la machine où tourne l'API.

1. Crée ton compte normalement sur l'app (`https://app.raijinshield.com/inscription`) et **confirme ton e-mail**
   (la commande refuse un compte non vérifié).
2. Lance la commande :
   - en local (développement) :
     ```bash
     pnpm nx run api:make-admin --email=ton@email.fr
     ```
   - en production, sur le VPS (conteneur `raijin-api`) :
     ```bash
     docker exec -it raijin-api node dist/apps/api/cli.js make-admin --email=ton@email.fr
     ```
3. Ouvre `https://app.raijinshield.com/admin` : l'app te demande d'activer la **double authentification** (QR code à
   scanner avec Google Authenticator, 1Password, Aegis…), puis te montre **10 codes de secours**. Garde-les hors de ton
   téléphone (gestionnaire de mots de passe, papier) : ils servent si tu perds l'application.

Pour retirer le rôle : même commande avec `--revoke`. Les sessions admin ouvertes tombent immédiatement.

**Téléphone et codes de secours perdus** : réinitialise la 2FA par la commande (journalisée), puis réactive-la :
```bash
# local
pnpm nx run api:admin-reset-2fa --email=ton@email.fr
# VPS
docker exec -it raijin-api node dist/apps/api/cli.js admin-reset-2fa --email=ton@email.fr
```

Variable obligatoire en production : `TOTP_ENCRYPTION_KEY` (32 octets en base64, `openssl rand -base64 32`). Sans elle,
l'API refuse de démarrer. **Ne la change pas** une fois des comptes enrôlés : les secrets 2FA ne se déchiffreraient plus
(il faudrait réinitialiser la 2FA de chaque admin).

---

## 2. Google Analytics 4 (landing)

La landing mesure son audience avec GA4, **seulement après consentement** (bannière « Tout accepter / Tout refuser »).
L'app ne contient pas GA4.

1. Va sur <https://analytics.google.com/> → **Administration** (roue dentée en bas à gauche) → **Créer** → **Propriété**.
   - Nom : `Raijin` ; fuseau horaire : `France` ; devise : `Euro`.
   - Catégorie : « Finance » (ou « Technologie ») ; taille : « Petite ».
2. Choisis la plateforme **Web** et crée un **flux de données** :
   - URL : `https://raijinshield.com` ; nom : `Landing`.
   - Dans « Mesure améliorée », laisse les pages vues ; tu peux désactiver « Interactions avec les formulaires ».
3. Copie l'**ID de mesure** (`G-XXXXXXXXXX`) → variable `GA4_MEASUREMENT_ID` (valeur publique, lue au build de la landing).
4. **Administration → Paramètres de la propriété** : copie l'**ID de propriété** (nombre, ex. `412345678`) →
   variable `GA4_PROPERTY_ID` (lue par l'API pour les écrans Trafic et Vue d'ensemble de l'admin).
5. **Administration → Collecte et conservation des données** :
   - « Signaux Google » : **désactivés** (la landing envoie aussi `allow_google_signals: false`) ;
   - « Conservation des données » : 14 mois.
6. **Administration → Événements** : une fois les premiers événements reçus, marque comme **événements clés**
   `inscription_debut` et `cta_essai_clic` (liste complète dans `docs/ANALYTICS.md`).

---

## 3. Compte de service Google (lecture seule, pour l'admin)

L'admin lit GA4 et Search Console avec un **compte de service** : un robot Google sans mot de passe, qui n'a que des
droits de **lecture**. Raijin n'utilise aucun SDK Google : il signe lui-même ses demandes d'accès avec la clé.

1. Ouvre <https://console.cloud.google.com/> et crée un projet : menu du haut → **Nouveau projet** → nom `raijin-admin`.
2. Active les deux API (bouton **Activer** sur chaque page, projet `raijin-admin` sélectionné) :
   - <https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com> (Google Analytics Data API) ;
   - <https://console.cloud.google.com/apis/library/searchconsole.googleapis.com> (Google Search Console API).
3. Crée le compte de service : <https://console.cloud.google.com/iam-admin/serviceaccounts> → **Créer un compte de
   service** → nom `raijin-admin-reader` → **Créer et continuer**.
   - « Accorder à ce compte l'accès au projet » : **ne donne aucun rôle** (laisse vide) → **Continuer** → **OK**.
   - Note son adresse e-mail, du type `raijin-admin-reader@raijin-admin.iam.gserviceaccount.com`.
4. Crée la clé : clique sur le compte → onglet **Clés** → **Ajouter une clé** → **Créer une clé** → **JSON** → **Créer**.
   Un fichier `.json` se télécharge : **c'est un secret**. Ne l'envoie à personne, ne le mets pas dans le dépôt.
5. Mets la clé dans la variable `GOOGLE_SERVICE_ACCOUNT_JSON` du `.env` du serveur, au choix :
   - le JSON sur une seule ligne (tel quel), ou
   - encodé en base64, plus simple à coller : `base64 -w0 raijin-admin-xxxx.json` (macOS : `base64 -i fichier.json`).
   Puis supprime le fichier téléchargé de ton ordinateur (`shred -u fichier.json` sous Linux).

> Si Google bloque la création de clés (« La création de clés de compte de service est désactivée »), c'est une
> règle d'organisation : dans **IAM → Règles d'administration**, la contrainte
> `iam.disableServiceAccountKeyCreation` doit être désactivée pour ce projet seulement.

### 3.1 Accès lecteur à GA4

1. <https://analytics.google.com/> → **Administration** → **Gestion des accès à la propriété** (colonne Propriété).
2. **+** → **Ajouter des utilisateurs** → colle l'e-mail du compte de service.
3. Rôle : **Lecteur**. Décoche « Avertir les nouveaux utilisateurs par e-mail ». → **Ajouter**.

### 3.2 Accès restreint à Search Console

1. Ajoute d'abord la propriété (section 4 ci-dessous) si ce n'est pas fait.
2. <https://search.google.com/search-console> → propriété `raijinshield.com` → **Paramètres** →
   **Utilisateurs et autorisations** → **Ajouter un utilisateur**.
3. E-mail du compte de service, autorisation **Restreint** (lecture seule) → **Ajouter**.

### 3.3 Variables à renseigner

| Variable | Exemple | Où la trouver |
|---|---|---|
| `GA4_PROPERTY_ID` | `412345678` | GA4 → Administration → Paramètres de la propriété |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | (JSON ou base64) | clé du compte de service (étape 4) |
| `SEARCH_CONSOLE_SITE_URL` | `sc-domain:raijinshield.com` | nom exact de la propriété Search Console |
| `ANALYTICS_PROVIDER` | vide | vide = lecture réelle si la clé est présente ; `fake` est **refusé en production** |
| `ANALYTICS_CACHE_TTL_S` | `3600` | durée du cache des réponses Google (1 h) |

Redémarre l'API (`rj up -d raijin-api`, alias de la partie A0), puis ouvre `/admin/sante` : les lignes
« Google Analytics Data API » et « Google Search Console » passent à **Configuré**. Les écrans Trafic et SEO
affichent les données (mises en cache 1 h ; l'heure de lecture est indiquée).

Si un écran affiche une erreur :
- **« La clé du compte de service est refusée »** : JSON mal collé ou clé supprimée dans Google Cloud → recrée une clé ;
- **« Le compte de service n'a pas accès »** : l'e-mail n'est pas ajouté en Lecteur (GA4) ou Restreint (Search
  Console), ou `GA4_PROPERTY_ID` / `SEARCH_CONSOLE_SITE_URL` ne correspond pas à la propriété ;
- **« Quota atteint »** : attends ; le cache d'une heure limite déjà fortement les appels.

Sans ces variables, l'admin affiche **« Non connecté »** sur ces écrans, sans erreur ; le reste fonctionne.

---

## 4. Google Search Console

1. <https://search.google.com/search-console> → **Ajouter une propriété**.
2. Recommandé : **Domaine** → `raijinshield.com` → Google donne un enregistrement **TXT** à ajouter dans la zone DNS
   OVH (Web Cloud → Domaines → `raijinshield.com` → Zone DNS → Ajouter une entrée → TXT, sous-domaine vide). La
   vérification peut prendre jusqu'à quelques heures. Valeur de `SEARCH_CONSOLE_SITE_URL` : `sc-domain:raijinshield.com`.
3. Alternative : **Préfixe d'URL** `https://raijinshield.com/` → méthode **Balise HTML** → copie seulement la valeur de
   `content="…"` dans `GOOGLE_SITE_VERIFICATION` (lue au build de la landing), redéploie la landing, puis clique sur
   **Valider**. Valeur de `SEARCH_CONSOLE_SITE_URL` : `https://raijinshield.com/`.
4. **Sitemaps** (menu de gauche) → ajoute `https://raijinshield.com/sitemap.xml` (celui déclaré dans `robots.txt` de la landing) → **Envoyer**.
5. Donne l'accès Restreint au compte de service (section 3.2).

Search Console publie ses chiffres avec **2 à 3 jours de décalage** : l'écran SEO l'indique (« données arrêtées
au … ») et ses fenêtres de 28 et 90 jours se terminent au dernier jour disponible.

---

## 5. Agrégats et alertes de l'admin

Rien à installer : les jobs tournent dans l'API (file BullMQ `maintenance`, Redis existant).

- **Agrégats nocturnes** `metrics-aggregate` à 02:15 UTC (`METRICS_CRON`) : calcule la veille et recalcule les deux
  jours d'avant dans `DailyMetric` (au premier passage, tout l'historique encore présent). La purge de 03:30 ne supprime
  les analyses et événements d'un jour qu'une fois ce jour agrégé.
- **Alertes admin** `admin-alerts` toutes les 10 min (`ADMIN_ALERTS_CRON`) : e-mail à chaque compte ADMIN et push sur
  ses appareils si un job échoue 3 fois de suite (`ADMIN_ALERT_JOB_FAILURES`) ou si un quota d'API externe dépasse
  80 % (`ADMIN_ALERT_QUOTA_RATIO`). Une seule alerte par incident ; pour recevoir le push, active les notifications
  dans l'app (Compte → Notifications) sur ton téléphone.
- Plafonds journaliers des API publiques (ratio et alertes) : `JUPITER_DAILY_CALL_BUDGET`, `RUGCHECK_DAILY_CALL_BUDGET`
  (vide = appels comptés sans alerte).

---

## 6. Landing Astro (raijinshield.com)

La landing est un site **statique** : `pnpm nx run landing:build` produit `dist/apps/landing/` (HTML, CSS, JS, images
Open Graph, `sitemap.xml`, `robots.txt`, icônes). Aucun appel à l'API pendant le build ni à l'exécution : les prix et
quotas affichés viennent de `PUBLIC_PLAN_CATALOG` (contrats), le verdict de la démonstration du moteur d'analyse.

### 6.1 Variables lues au build

Ce sont des valeurs **publiques** (rien de secret), lues dans l'environnement du processus `astro build`. Sur le VPS,
elles sont dans `infra/.env` (sauf `APP_URL`, calculée depuis `APP_DOMAIN`) et `infra/deploy.sh` les **exporte avant
le build** de la landing (arguments de build de l'image `raijin/landing`) ; les changer impose de redéployer.

| Variable | Valeur de production | Vide |
|---|---|---|
| `APP_URL` | `https://app.raijinshield.com` | valeur par défaut ci-contre |
| `GA4_MEASUREMENT_ID` | `G-XXXXXXXXXX` (section 2) | ni GA4, ni bannière de consentement |
| `GOOGLE_SITE_VERIFICATION` | valeur `content` de la balise HTML (section 4, méthode « préfixe d'URL ») | pas de meta (propriété de domaine DNS) |

```bash
export APP_URL=https://app.raijinshield.com
export GA4_MEASUREMENT_ID=G-XXXXXXXXXX
export GOOGLE_SITE_VERIFICATION=   # vide si la propriété Search Console est vérifiée par DNS
pnpm nx run landing:build
```

### 6.2 Servir les URL sans `.html`

Le build garde `build.format: 'file'` : `/tarifs` est le fichier `tarifs.html`, `/guides/mint-authority` le fichier
`guides/mint-authority.html`, `/` le fichier `index.html`. Les URL canoniques, le sitemap et les liens internes
n'utilisent **jamais** `.html`. Le serveur statique (`infra/nginx/landing.conf`, derrière Traefik) applique donc :

1. servir `/x` avec le fichier `x.html` s'il existe (sinon `x/index.html`) ;
2. répondre `404` avec `404.html` pour toute autre URL ;
3. rediriger en `301` `/x.html` vers `/x` et `/x/` vers `/x` (une seule URL par page) ;
4. envoyer `Cache-Control: public, max-age=31536000, immutable` pour `/_astro/*` (fichiers hachés) et un cache court
   pour le HTML, `sitemap.xml`, `robots.txt` et `/og/*.png`.

Exemple nginx : `try_files $uri $uri.html $uri/index.html =404; error_page 404 /404.html;`. En local, le serveur des
tests (`apps/web-e2e/scripts/serve-landing.mjs`) applique la même règle.

### 6.3 Search Console et partage

- Sitemap à déclarer dans Search Console (section 4, étape 4) : `https://raijinshield.com/sitemap.xml`. Il liste les
  pages indexables et les guides avec leur date de mise à jour ; la 404 est en `noindex`.
- Images de partage : `https://raijinshield.com/og/<page>.png` (1200 × 630, générées au build). Pour vérifier un
  aperçu après déploiement : l'outil d'inspection d'URL de Search Console, ou le débogueur de partage du réseau visé.

### 6.4 Avant la mise en ligne

- Les pages légales affichent **« À compléter »** pour l'éditeur, le SIRET, l'adresse, le contact, le directeur de la
  publication et le médiateur de la consommation : à renseigner dans `apps/landing/src/pages/mentions-legales.astro`,
  `cgu.astro` et `confidentialite.astro` (composant `LegalTodo`), puis reconstruire.
- CSP cible de la landing (phase 8) : `script-src 'self' https://www.googletagmanager.com` ; aucun script inline
  exécutable (le JSON-LD est de type `application/ld+json`, non exécuté) ; `style-src 'self'` suffit si Astro ne met
  pas de CSS en ligne (vérifier `inlineStylesheets` au moment de poser la CSP) ; `font-src 'self'` ; `img-src 'self'
  data:` + domaines GA4 ; `connect-src 'self'` + domaines GA4.

---

# Partie C — Environnements dev/prod et déploiement continu

## Méthode la plus simple : `bash infra/vps-install.sh`

Sur **ton PC**, depuis la racine du dépôt (à jour sur `main`, scripts relus), une seule commande :

```bash
bash infra/vps-install.sh --check   # aperçu seulement : rien n'est modifié sur le VPS, aucune clé générée
bash infra/vps-install.sh           # aperçu, « Continuer ? (o/N) », puis installation (un seul mot de passe sudo)
```

Le lanceur te demande l'adresse du VPS (ou la lit dans la variable d'environnement `DEPLOY_HOST` ; elle n'est écrite
dans aucun fichier du dépôt) et l'utilisateur SSH (défaut `greg`), puis :
1. génère au besoin dans `~/.ssh` (droits 600) les clés `raijin-deploy-dev`, `raijin-depot-prod` et
   `raijin-github-readonly` (C5 étape 1) ;
2. copie par `scp` une archive (scripts figés de `infra/`, clés publiques, clé de lecture du dépôt) dans un dossier
   temporaire du VPS, supprimé à la fin ;
3. lance sur le VPS `sudo bash infra/vps-setup.sh --preview-apply` : aperçu complet, « Continuer ? (o/N) », puis
   application sans question des blocs non destructifs ; le retrait d'un groupe et les unités systemd restent
   **toujours demandés**. Réseau d'entrée du dev : option B par défaut (C2), **aucune** modification du conteneur
   Traefik ; `docker network connect` n'est proposé (et toujours demandé) qu'avec `--dev-edge dedicated` (option A) ;
4. enregistre l'empreinte du VPS (`~/.ssh/raijin-known-hosts`) après l'avoir comparée à celle lue sur le VPS ;
5. affiche la liste numérotée des secrets et variables GitHub avec les commandes `gh secret set … < ~/.ssh/raijin-…`
   et `gh variable set DEPLOY_HOST` prêtes à copier (aucune clé affichée), et propose de les lancer. Il rappelle
   l'interrupteur `DEPLOY_DEV_AUTO` (C5), qu'il n'active **jamais** lui-même.

Ce que fait `infra/vps-setup.sh` (relançable sans casse, ne supprime rien : une version remplacée est gardée dans
`/var/lib/raijin-deploy/sauvegardes/`) : paquets (`python3-yaml`, `apache2-utils`…), utilisateurs `deploy-dev` /
`deploy-prod` (mot de passe verrouillé, hors `docker` et `sudo`), dossiers, verrou, scripts figés (C4), règles sudo
validées par `visudo -cf`, modèles `/srv/raijin/<env>/env/.env*` en 600 (repris de la partie A s'ils existent),
**secrets générés sur le VPS** (Postgres, Redis, JWT, cookies, TOTP, empreinte IP, paires VAPID dev et prod) sans
jamais les afficher, mot de passe basicAuth du dev demandé au clavier, `authorized_keys` à commande forcée, clé de
lecture GitHub, réseau d'entrée du dev (`RAIJIN_DEV_EDGE`, C2), détection du Traefik (réseau, entrypoint, certresolver, en lecture seule),
vérifications `passwd -S`, `sshd -T`, isolement de `deploy-dev` et `git ls-remote`. Il termine par un résumé « fait /
déjà en place / reste à faire » et la liste des variables à remplir toi-même (noms seulement : Helius, Resend,
Stripe, Google…).

Ce qu'il ne fait **pas** : modifier la configuration de Traefik, de sshd ou des autres projets (il signale seulement
`AcceptEnv` / `AllowUsers` à corriger), lancer `docker compose down`, `prune` ou `volume rm`, saisir tes clés Helius,
Stripe, Resend ou Google (elles viennent de tes tableaux de bord), déployer quoi que ce soit (C6).

Sans le lanceur (archive copiée à la main, mode `--check` par défaut) : commandes en tête de `infra/vps-setup.sh`,
puis `sudo bash infra/vps-setup.sh --apply …`. Testé en CI dans un conteneur jetable (`infra/ci/test-vps-setup.sh`).
La procédure manuelle ci-dessous (C0 à C10) reste la référence.

## C0. Vue d'ensemble

| | dev | prod |
|---|---|---|
| Déclencheur | push sur `dev`, **après CI verte** : déploiement **automatique** si la variable GitHub `DEPLOY_DEV_AUTO` vaut `1` (absente = désactivé, C5) | push sur `main` (fusion de la PR `dev → main`, faite par toi), **après CI verte** : archive **déposée** sur le VPS, puis **activée par toi** (une commande, C6) |
| Noms | `dev.raijinshield.com` (app), `api-dev.raijinshield.com`, `landing-dev.raijinshield.com` | `app.`, `api.`, `raijinshield.com` + `www`, `banc.` |
| Projet Compose | `raijin-dev` (conteneurs, images, routeurs, réseaux, volumes `raijin-dev-…`) | `raijin` (inchangé) |
| Réseau d'entrée | `RAIJIN_DEV_EDGE` (C2) : option B `traefik-shared` (défaut) = celui de Traefik, comme la prod ; option A `dedicated` = `raijin-dev-edge` rejoint par Traefik | celui de Traefik (A2) |
| Postgres / Redis | propres au dev (`raijin-dev-postgres`, `raijin-dev-redis`, volumes `raijin-dev-pgdata` / `-redisdata`) | ceux de la partie A |
| Accès | mot de passe Traefik (basicAuth) partout, sauf `robots.txt`, la santé, le webhook Stripe et les images OG d'`api-dev` | public |
| Indexation | `X-Robots-Tag: noindex, nofollow` et `robots.txt` `Disallow: /` partout | normale |
| Stripe | **mode test** obligatoire (clé live refusée) | test puis réel (A7) |
| E-mails | jamais envoyés : capturés par Mailpit (réseau interne du dev seul, mot de passe du dev), lus par tunnel SSH (C3) | Resend |
| GA4 / Search Console | désactivés | activés |
| Mémoire max | ≈ 0,9 Go (Postgres 256 Mo, Redis 96 Mo, API 384 Mo, statiques 2 × 48 Mo, Mailpit 64 Mo) | ≈ 1,4 Go (A13) |
| Sauvegarde avant migration | non (données de test) | oui (`backup.sh --no-offsite`) |

Chaîne (`.github/workflows/deploy.yml`, scripts figés `/opt/raijin-deploy/infra/`) :

```
dev  : push dev ─► CI verte ─► GitHub Actions : build des images, archive (docker save + infra/ du commit)
         ─► ssh deploy-dev@<VPS> « deploy dev <commit> » (clé dev, commande forcée deploy-gate.sh dev)
         ─► contrôles ─► configuration résolue ─► release.sh : migrations, démarrage, santé, routage
         ─► succès : en service │ échec : retour automatique à la dernière version réussie
prod : fusion dans main ─► CI verte ─► GitHub Actions : build, archive, jeton OIDC signé par GitHub
         ─► ssh deploy-prod@<VPS> « depose prod <commit> » (clé prod-depot : DÉPÔT seulement, rien n'est démarré)
         ─► toi, sur le VPS : deploy-gate.sh --approve <commit>
              (commit = tête de main par git ls-remote, puis mêmes contrôles et même mise en service que le dev)
```

Choix et raisons :
- **Build dans GitHub Actions, pas sur le VPS** : un build prend 2 à 2,5 Go de RAM pendant 10 à 20 min (A13) ; à chaque
  push sur `dev`, il ralentirait MTC et XMR Trader. Les images voyagent par la connexion SSH : **aucun registre**, aucun
  identifiant GitHub capable d'écrire sur le VPS (seulement une clé de **lecture** du dépôt pour `git ls-remote`).
- **Aucune clé capable de déployer la production dans GitHub** : sur GitHub Free (dépôt privé), un workflow poussé
  sur n'importe quelle branche peut lire tous les secrets du dépôt. La clé « prod-depot » ne fait que déposer une
  archive, et seulement si un jeton OIDC signé par GitHub prouve qu'elle a été produite par `deploy.yml` **sur `main`**,
  au commit annoncé, avec cette empreinte exacte (un workflow de `dev` obtient un jeton `…@refs/heads/dev`, refusé).
  La mise en service reste ta décision, sur le VPS.
- **Commande forcée et scripts figés** : chaque clé de GitHub ne peut lancer que sa commande (`deploy dev …`,
  `depose prod …`, `status …`). Les scripts qui contrôlent et déploient (`deploy-gate.sh`, `release.sh`, `lib/`) sont
  les copies installées par toi dans `/opt/raijin-deploy` (propriété de root), jamais ceux de la livraison.
- **Un utilisateur Unix par environnement, sans accès direct à Docker** : `deploy-dev` (clé du dev) n'a aucun droit
  de lecture sur `/srv/raijin/prod` ni `/srv/raijin/incoming/prod` ; `deploy-prod` (clé de dépôt, activation) n'a rien
  à faire du dev. Aucun des deux n'est dans le groupe `docker` : leur seul accès à Docker est
  `/opt/raijin-deploy/infra/docker-priv.sh` (root, par sudo, environnement fixé par sudoers), qui ne sait que charger
  des images vérifiées, démarrer la configuration résolue du projet de l'environnement, étiqueter / retirer ses images
  et lancer l'init de son Postgres. Ni `docker inspect` ni `docker exec` sur la prod depuis `deploy-dev`.
  `docker compose config` lit les fichiers avec les droits de l'utilisateur qui le lance : une livraison du dev ne
  peut donc pas faire lire un secret de la prod (la porte vérifie cet isolement avant chaque déploiement du dev, et
  refuse en plus `include`, `extends`, `label_file` et tout `env_file` autre que les deux modèles du dépôt, avant
  tout rendu).
- **Une seule configuration, résolue et contrôlée** : la porte produit `compose.resolved.json` sous un environnement
  vidé (`env -i`, liste blanche : `RAIJIN_NAME`, `RAIJIN_TAG`, chemins des fichiers de variables) avec le fichier de
  l'environnement, la contrôle, et `release.sh` ne démarre **que** ce fichier (aucune réinterpolation, `--pull never`,
  `--no-build`), en rejouant le contrôle avant chaque `up` / `run`. Les variables `RAIJIN_*` sont ignorées dans une
  session SSH (valeurs figées). Le contrôle (`infra/lib/deploy_policy.py`, testé
  en CI) refuse notamment : privilège, port publié, montage du VPS ou du socket Docker, réseau ou volume d'un autre
  projet, `extra_hosts` / `dns`, image d'un autre projet ou d'une autre étiquette que le commit livré, `build`,
  `pull_policy` autre que `never`, absence de `mem_limit` (≤ 1 Go), `cpus` (≤ 1), `pids_limit` (≤ 500) ou de journaux plafonnés, `shm_size` > 256 Mo ;
  routeurs Traefik hors de la forme stricte `Host(`nom`) [&& Path|PathPrefix(`/…`)]` (sans `||` ni `!`), pour un
  autre nom de domaine, avec `priority` > 1000 ou une option non listée ; images contenant un label `traefik.*`, un
  `VOLUME` ou sans utilisateur non root.
- **Retour automatique** : si les conteneurs ne deviennent pas `healthy` ou si le contrôle de routage échoue, la
  version précédente (son fichier résolu et ses images `:<commit>`) est remise en service. Les migrations déjà
  appliquées **ne sont pas annulées** (Prisma ne migre que vers l'avant) : en prod, la sauvegarde faite juste avant
  est dans `/var/backups/raijin` (A10). Règle pour les migrations : d'abord ajouter, supprimer dans une version suivante.
- **Rien de destructif** : ni `docker compose down`, ni suppression de volume ou de réseau, ni `prisma migrate reset`.
  Seules sont retirées les étiquettes `raijin(-dev)/<image>:<commit>` des versions de plus de 5 livraisons.

> Limite à connaître : l'accès à Docker équivaut à un accès root sur le VPS. Les contrôles réduisent ce qu'une
> livraison du dev peut faire (elle reste confinée à ses noms, ses réseaux et ses ressources), mais **quiconque peut
> pousser sur `dev` fait tourner son code sur le VPS** (y compris les agents Claude, qui poussent sur `dev`) : garde
> les droits d'écriture du dépôt pour toi seul, et n'active `DEPLOY_DEV_AUTO=1` qu'en connaissance de cause (C5,
> `docs/SECURITY.md` §17). Les images de production, elles, ne viennent que de `deploy.yml` sur `main` (jeton OIDC) et
> ne démarrent qu'après ton activation.

## C1. Prérequis sur le VPS

En plus de A1 (Docker 24+, Compose 2.24+ avec `docker compose run --pull`) :

```bash
python3 --version     # 3.8 ou plus (contrôles de la porte) ; sinon : sudo apt install python3
python3 -c 'import yaml'   # PyYAML obligatoire (lecture exacte des fichiers Compose livrés) : sudo apt install python3-yaml
flock --version       # paquet util-linux (présent par défaut)
git --version         # activation de la prod (git ls-remote)
free -h               # le dev ajoute ≈ 0,9 Go au maximum (≈ 300 Mo habituels)
```

## C2. Utilisateurs `deploy-dev` et `deploy-prod`, accès à Docker, réseau d'entrée du dev

Deux utilisateurs sans mot de passe, **hors du groupe `docker`**, un par environnement :

```bash
sudo adduser --disabled-password --gecos "Raijin deploy dev" deploy-dev
sudo adduser --disabled-password --gecos "Raijin deploy prod" deploy-prod
groups deploy-dev deploy-prod                  # ni « docker » ni « sudo » ne doivent apparaître
sudo install -d -o root -g root -m 755 /srv/raijin /srv/raijin/incoming
sudo install -d -o root -g root -m 755 /srv/raijin/lock                          # dossier du verrou (traversable, non inscriptible)
sudo install -o root -g root -m 0644 /dev/null /srv/raijin/lock/deploy.lock       # verrou dev + prod, lu par les deux
sudo install -d -o root -g root -m 711 /var/lib/raijin-deploy                     # zone racine (versions importées)
sudo install -d -o deploy-dev  -g deploy-dev  -m 750 /srv/raijin/dev
sudo install -d -o deploy-dev  -g deploy-dev  -m 700 /srv/raijin/dev/env ~deploy-dev/.ssh
sudo install -d -o deploy-prod -g deploy-prod -m 750 /srv/raijin/prod
sudo install -d -o deploy-prod -g deploy-prod -m 700 /srv/raijin/prod/env /srv/raijin/incoming/prod ~deploy-prod/.ssh
sudo -u deploy-dev ls /srv/raijin/prod        # doit afficher « Permission denied » (sinon la porte refuse le dev)
```

Accès à Docker par sudo, **uniquement** ce script et avec l'environnement imposé (`sudo visudo -f /etc/sudoers.d/raijin-deploy`) :

```
Defaults!/opt/raijin-deploy/infra/docker-priv.sh env_reset, !requiretty
deploy-dev  ALL=(root) NOPASSWD: /opt/raijin-deploy/infra/docker-priv.sh dev *
deploy-prod ALL=(root) NOPASSWD: /opt/raijin-deploy/infra/docker-priv.sh prod *
```

`docker-priv.sh` vérifie en plus que l'appelant est bien `deploy-<env>`, n'accepte que ses sous-commandes
(`sync-init`, `import`, `deploy`, `recover`, `status`), ne lit dans la zone de l'utilisateur que des fichiers
ordinaires sans lien et à son propriétaire (copiés dans `/var/lib/raijin-deploy/<env>/`), contrôle à nouveau les
images (structure de l'archive, étiquettes, configuration) puis compare la sortie de `docker load` à la liste attendue.
Contrôle : `sudo -u deploy-dev docker ps` doit être refusé (« permission denied … docker.sock »).

Vérifications SSH (à faire une fois) :

```bash
sudo passwd -S deploy-dev; sudo passwd -S deploy-prod   # 2e colonne « L » : aucun mot de passe, clé seulement
sudo sshd -T | grep -iE '^(acceptenv|permituserenvironment|allowusers|allowgroups)'
#   acceptenv : seulement LANG LC_* (jamais RAIJIN_* ni *) ; permituserenvironment no ;
#   si allowusers / allowgroups existe : y ajouter deploy-dev et deploy-prod, puis sudo sshd -t && sudo systemctl reload ssh
```

**Réseau d'entrée du dev** (`RAIJIN_DEV_EDGE` dans `/srv/raijin/dev/env/.env`) : **option B retenue** (choix du
relecteur final, consigné dans `docs/PROGRESS.md`). Le conteneur Traefik a été créé par MyTradingCoach, et PROMPT §7
interdit de toucher à MTC. Condition de l'option B : Traefik pose vers `raijin-api` et `raijin-bench-api` de la
**prod** l'en-tête `X-Raijin-Edge` = `EDGE_SHARED_SECRET` (64 hex, généré par `infra/vps-setup.sh` dans
`/srv/raijin/prod/env/.env`, droits 600, jamais affiché ni dans le dépôt) ; l'API et le banc répondent **403** à toute
requête sans cet en-tête valide (sauf la santé) et ignorent alors `X-Forwarded-*` : un conteneur du dev (ou de MTC)
qui les appelle en direct, sans Traefik, est refusé. Dans le dev, la valeur reste vide (Traefik retire l'en-tête) ;
la porte refuse le secret côté dev, et refuse la prod si un routeur vers l'API ou le banc n'a pas l'en-tête ou si
le secret manque (`deploy_policy.py`, `infra/deploy.sh`) :

| | Option B : `RAIJIN_DEV_EDGE=traefik-shared` (**défaut**) | Option A : `RAIJIN_DEV_EDGE=dedicated` |
|---|---|---|
| Principe | les conteneurs exposés du dev (`raijin-dev-api`, `-web`, `-landing` ; jamais Mailpit, Postgres ni Redis) rejoignent le **même réseau Traefik externe que la prod** (`TRAEFIK_NETWORK` = valeur de A2) | réseau `raijin-dev-edge` propre au dev, que Traefik rejoint en plus des siens |
| Conteneur Traefik de MTC | **jamais modifié** (aucune commande sur lui) | modifié à chaud : `docker network connect raijin-dev-edge <traefik>` (sans toucher à ses fichiers) |
| Ce que le dev peut joindre directement | l'API, l'app, la landing et le banc de la prod **et** les conteneurs de MTC / XMR Trader présents sur ce réseau (sans passer par Traefik) | rien d'autre que Traefik |
| Ce qui reste isolé | Postgres et Redis de la prod (réseau interne `raijin-internal`, jamais sur le réseau d'entrée : refusé par la porte), secrets de la prod (`deploy-dev` ne lit rien de `/srv/raijin/prod`), volumes, noms, routeurs Traefik (`Host(`…-dev…`)` seulement) | idem |
| Fragilité | aucune : rien à refaire si Traefik est recréé | si Traefik est **recréé** (mise à jour de MTC), la connexion disparaît : le dev répond 404/502 jusqu'à ce que tu relances `docker network connect` |
| Risque | appel direct de l'API ou du banc de la prod **sans Traefik** : **403** (en-tête `X-Raijin-Edge` absent, `X-Forwarded-For` ignoré). Reste : le dev peut joindre en direct les conteneurs de MTC / XMR Trader présents sur ce réseau, et l'app / la landing de la prod (fichiers statiques publics) ; risque **déjà accepté pour la prod**, qui partage ce réseau avec MTC | toucher un conteneur qui n'est pas à Raijin (décision de l'utilisateur à consigner dans `docs/PROGRESS.md`) |

Option B (défaut, rien à faire sur Traefik) : dans `/srv/raijin/dev/env/.env`,

```dotenv
RAIJIN_DEV_EDGE=traefik-shared
TRAEFIK_NETWORK=<réseau de Traefik trouvé en A2, le même que la prod>
```

`infra/vps-setup.sh` les remplit ainsi par défaut, et écrit en root le **réseau de référence**
`/var/lib/raijin-deploy/traefik-network` (644, = `TRAEFIK_NETWORK` de la prod). Les contrôles
(`infra/lib/deploy_policy.py`, par la porte puis par `release.sh` avant chaque `up`) exigent en option B que
`TRAEFIK_NETWORK` du dev soit **exactement** ce réseau de référence (jamais un autre réseau existant ni un réseau
`raijin-…`), refusent tout réseau externe autre que `TRAEFIK_NETWORK`, tout réseau du projet portant le nom du
réseau d'entrée ou de `raijin-dev-edge`, et Postgres, Redis ou Mailpit sur un tel réseau (selon son nom, pas
seulement le drapeau `external`). `infra/deploy.sh` et `release.sh` vérifient qu'un conteneur Traefik est relié au
réseau d'entrée.

Option A (écartée ; seulement si tu reviens sur ce choix, après avoir consigné ta décision dans `docs/PROGRESS.md`) :
`sudo bash infra/vps-setup.sh --apply --dev-edge dedicated`, puis taper « option A » quand le script le demande. Sans
ce drapeau **et** cette phrase dans le même lancement, aucun script n'applique l'option A, même si le `.env` du dev
contient `RAIJIN_DEV_EDGE=dedicated` (avertissement, option B conservée). À la main :

```bash
docker network create raijin-dev-edge
docker network connect raijin-dev-edge <conteneur-traefik>     # nom trouvé en A2 ; modifie le conteneur de MTC
docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' <conteneur-traefik>   # raijin-dev-edge listé
# puis dans /srv/raijin/dev/env/.env : RAIJIN_DEV_EDGE=dedicated et TRAEFIK_NETWORK=raijin-dev-edge
```

En option A, le déploiement du dev échoue proprement (contrôle de routage) tant que Traefik n'a pas rejoint le réseau.
Revenir de A à B : remets `RAIJIN_DEV_EDGE=traefik-shared` et `TRAEFIK_NETWORK=<réseau de A2>`, redéploie le dev ;
`docker network disconnect raijin-dev-edge <traefik>` reste à faire par toi (aucun script ne le fait). Tests : option B
en CI de bout en bout (`infra/ci/test-dev-env.sh`, `check-stack-dev.sh` : Traefik inchangé, Postgres / Redis de la
prod injoignables, appel direct du dev vers `raijin-api` et `raijin-bench-api` de la prod → 403, même chemin via
Traefik accepté), options A et B, l'en-tête `X-Raijin-Edge` et leurs refus dans `infra/ci/test-deploy-policy.sh`,
garde de l'option A dans `infra/ci/test-vps-setup.sh`.

## C3. Fichiers de variables

Un dossier par environnement, lisible par son seul utilisateur (`deploy-dev` ou `deploy-prod`). Les **secrets d'application ne quittent jamais le VPS** :

```bash
# Production : reprends les fichiers de la partie A s'ils existent déjà
sudo install -o deploy-prod -g deploy-prod -m 600 /opt/raijin/infra/.env          /srv/raijin/prod/env/.env
sudo install -o deploy-prod -g deploy-prod -m 600 /opt/raijin/infra/.env.api      /srv/raijin/prod/env/.env.api
sudo install -o deploy-prod -g deploy-prod -m 600 /opt/raijin/infra/.env.bench-api /srv/raijin/prod/env/.env.bench-api   # si le banc tourne
# (sinon : crée-les avec « sudo -u deploy-prod nano /srv/raijin/prod/env/.env », modèle docs/ENV.md « Production (VPS) »)

# Dev : nouveaux fichiers, valeurs propres au dev (modèle docs/ENV.md « Dev (VPS) » ; RAIJIN_DEV_EDGE et
# TRAEFIK_NETWORK selon l'option choisie en C2 : par défaut traefik-shared et le réseau de Traefik de la prod)
# .env du dev : root:deploy-dev 640 (deploy-dev le lit, ne peut pas le modifier ; la porte refuse sinon)
sudo nano /srv/raijin/dev/env/.env
sudo chown root:deploy-dev /srv/raijin/dev/env/.env && sudo chmod 640 /srv/raijin/dev/env/.env
sudo -u deploy-dev nano /srv/raijin/dev/env/.env.api
sudo chmod 600 /srv/raijin/dev/env/.env.api /srv/raijin/prod/env/.env*
```

Pourquoi : le `.env` du dev fixe son réseau d'entrée, ses domaines et son mot de passe ; la clé du dev (GitHub) ou
une livraison compromise ne doit pas pouvoir les changer. La porte et `release.sh` refusent un `.env` du dev qui
n'appartient pas à root avec les droits 640.

Ajoute à `/srv/raijin/prod/env/.env` (activation de la prod, C5) :

```dotenv
DEPLOY_GITHUB_REPOSITORY=<ton-compte>/raijin
DEPLOY_GIT_REMOTE=git@github.com:<ton-compte>/raijin.git
```

- Le banc n'est déployé que si `/srv/raijin/prod/env/.env.bench-api` existe.
- Sauvegardes en prod : elles tournent en **root** (accès à Docker), `BACKUP_DIR` reste à root
  (`sudo chown root: /var/backups/raijin`). Si les unités systemd de A9 et A11 tournent, fais-les pointer vers les
  copies figées et les nouveaux fichiers :
  ```bash
  sudo systemctl edit raijin-backup.service      # puis colle :
  # [Service]
  # User=root
  # WorkingDirectory=/opt/raijin-deploy
  # Environment=RAIJIN_ENV_FILE=/srv/raijin/prod/env/.env RAIJIN_API_ENV_FILE=/srv/raijin/prod/env/.env.api
  # ExecStart=
  # ExecStart=/opt/raijin-deploy/infra/backup.sh
  ```
  Même chose pour `raijin-watchdog.service` (avec `ExecStart=/opt/raijin-deploy/infra/watchdog.sh`). La configuration
  rclone (A9) doit alors être celle de root : `sudo rclone config`.
- Restauration (A10) : depuis le dépôt cloné (`/opt/raijin`, à jour sur `main`), en root et avec les fichiers de C3 :
  `sudo env RAIJIN_ENV_FILE=/srv/raijin/prod/env/.env RAIJIN_API_ENV_FILE=/srv/raijin/prod/env/.env.api infra/restore.sh …`.

### Mot de passe du dev (basicAuth)

```bash
htpasswd -nBC 12 kyoshiro        # paquet apache2-utils ; tape un mot de passe DIFFÉRENT de celui du banc
```

Copie la ligne **entre apostrophes** dans `DEV_BASIC_AUTH_USERS` de `/srv/raijin/dev/env/.env` (**un seul**
utilisateur : la même valeur protège aussi l'interface de Mailpit, `MP_UI_AUTH`).

### Lire les e-mails du dev (Mailpit)

Mailpit n'est que sur le réseau interne du dev (ni Traefik, ni réseau partagé) et demande lui-même le mot de passe
du dev. Pour l'ouvrir, un relais temporaire sur le VPS, puis un tunnel SSH depuis ton PC :

```bash
# sur le VPS (ton compte) : relais local 127.0.0.1:18025 → Mailpit, arrêté à la fin
ip="$(sudo docker inspect -f '{{(index .NetworkSettings.Networks "raijin-dev-internal").IPAddress}}' raijin-dev-mailpit)"
sudo docker run -d --rm --name raijin-dev-mailpit-tunnel -p 127.0.0.1:18025:8025 alpine/socat \
  TCP-LISTEN:8025,fork,reuseaddr "TCP:$ip:8025"
sudo docker network connect raijin-dev-internal raijin-dev-mailpit-tunnel
# sur ton PC
ssh -N -L 8025:127.0.0.1:18025 greg@<IP du VPS>        # puis http://localhost:8025/_mailpit/ (mot de passe du dev)
# sur le VPS, après lecture
sudo docker stop raijin-dev-mailpit-tunnel
```

### Stripe en mode test pour le dev

Stripe → mode **test** → Développeurs → Webhooks → **Ajouter un endpoint** :
`https://api-dev.raijinshield.com/api/v1/billing/webhook`, mêmes événements que A7. Son secret `whsec_…` va dans
`STRIPE_WEBHOOK_SECRET` de `/srv/raijin/dev/env/.env.api` (distinct de celui de la prod).

## C4. Installer les scripts figés

Depuis le dépôt cloné de la partie A (à jour sur `main`, après avoir relu les changements) :

```bash
cd /opt/raijin && git pull --ff-only
sudo install -d -o root -g root -m 755 /opt/raijin-deploy/infra/lib
for f in deploy-gate.sh docker-priv.sh release.sh backup.sh watchdog.sh; do
  sudo install -o root -g root -m 755 "infra/$f" "/opt/raijin-deploy/infra/$f"
done
sudo install -o root -g root -m 644 infra/lib/common.sh infra/lib/deploy_policy.py /opt/raijin-deploy/infra/lib/
ls -l /opt/raijin-deploy/infra /opt/raijin-deploy/infra/lib     # tout appartient à root, rien d'inscriptible par deploy-dev / deploy-prod
```

## C5. Clés SSH, GitHub et activation de la prod

1. **Sur ton PC**, deux clés pour GitHub Actions et une clé de lecture du dépôt pour le VPS, sans phrase de passe :
   ```bash
   ssh-keygen -t ed25519 -N '' -C github-raijin-deploy-dev  -f ~/raijin-deploy-dev
   ssh-keygen -t ed25519 -N '' -C github-raijin-depot-prod  -f ~/raijin-depot-prod
   ssh-keygen -t ed25519 -N '' -C vps-raijin-lecture        -f ~/raijin-github-readonly
   ```
2. **Sur le VPS**, une ligne par utilisateur (contenu des fichiers `.pub`) :
   ```
   # sudo -u deploy-dev nano ~deploy-dev/.ssh/authorized_keys
   restrict,command="/opt/raijin-deploy/infra/deploy-gate.sh dev" ssh-ed25519 AAAA…(raijin-deploy-dev.pub) github-raijin-deploy-dev
   # sudo -u deploy-prod nano ~deploy-prod/.ssh/authorized_keys
   restrict,command="/opt/raijin-deploy/infra/deploy-gate.sh prod-depot" ssh-ed25519 AAAA…(raijin-depot-prod.pub) github-raijin-depot-prod
   ```
   puis `sudo chmod 600 ~deploy-dev/.ssh/authorized_keys ~deploy-prod/.ssh/authorized_keys`. `restrict` coupe terminal, redirections et agent ; `command=`
   impose la porte, quelle que soit la commande demandée. La clé `prod-depot` ne peut **que déposer**.
3. **Clé de lecture du dépôt** (activation de la prod) : GitHub → dépôt → **Settings → Deploy keys → Add deploy key**,
   titre `vps-raijin-lecture`, contenu de `~/raijin-github-readonly.pub`, **sans** « Allow write access ». Puis :
   ```bash
   sudo install -o deploy-prod -g deploy-prod -m 600 raijin-github-readonly ~deploy-prod/.ssh/github_readonly   # fichier copié depuis ton PC
   ssh-keyscan -t ed25519 github.com | sudo -u deploy-prod tee ~deploy-prod/.ssh/known_hosts_github >/dev/null
   sudo -u deploy-prod ssh-keygen -lf ~deploy-prod/.ssh/known_hosts_github   # compare avec https://docs.github.com/fr/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
   ```
4. **Empreinte du VPS** (épinglée : GitHub refusera un autre serveur) :
   ```bash
   ssh-keyscan -t ed25519 <IP du VPS> > ~/raijin-known-hosts       # sur ton PC
   ssh-keygen -lf ~/raijin-known-hosts                              # compare avec, sur le VPS :
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub                 # les deux empreintes SHA256 doivent être identiques
   ```
5. **GitHub** → dépôt `raijin` → **Settings → Secrets and variables → Actions** :

   | Onglet | Nom | Valeur |
   |---|---|---|
   | Secrets | `DEPLOY_SSH_KEY_DEV` | contenu de `~/raijin-deploy-dev` (clé **privée**) |
   | Secrets | `DEPOT_SSH_KEY_PROD` | contenu de `~/raijin-depot-prod` (clé privée, dépôt seulement) |
   | Secrets | `DEPLOY_KNOWN_HOSTS` | contenu de `~/raijin-known-hosts` |
   | Variables | `DEPLOY_HOST` | **obligatoire** : IPv4 du VPS |
   | Variables | `DEPLOY_DEV_AUTO` | interrupteur du déploiement du dev : **absente = désactivé** (défaut, par prudence) ; `1` = chaque push sur `dev` (CI verte) est déployé ; `0` = suspendu. À mettre à `1` par toi **après** l'installation du VPS (C6 étape 4) : `gh variable set DEPLOY_DEV_AUTO --body 1` |
   | Variables | `GA4_MEASUREMENT_ID`, `GOOGLE_SITE_VERIFICATION` | facultatives, valeurs publiques de la landing de prod |
   | Variables | `DEPLOY_USER_DEV`, `DEPLOY_USER_PROD`, `DEPLOY_PORT` | seulement si différents de `deploy-dev`, `deploy-prod` et `22` |

   Supprime l'ancien secret `DEPLOY_SSH_KEY_PROD` s'il existe (plus aucune clé de déploiement de prod dans GitHub).
6. **Settings → Actions → General → Workflow permissions** : choisis **« Read repository contents and packages
   permissions »** et décoche « Allow GitHub Actions to create and approve pull requests ». Les workflows déclarent en
   plus `permissions: contents: read` (et `id-token: write` pour le seul job de dépôt de la prod).
7. Supprime les clés privées de ton PC (`shred -u ~/raijin-deploy-dev ~/raijin-depot-prod ~/raijin-github-readonly`).

Ce qui est où :

| Élément | Emplacement |
|---|---|
| Secrets d'application (Postgres, Redis, JWT, Stripe, Resend, Helius, VAPID, Google, basicAuth) | VPS seulement : `/srv/raijin/<env>/env/` (600, `deploy-dev` ou `deploy-prod`) |
| Clé de déploiement du dev, clé de **dépôt** de la prod, empreinte du VPS | GitHub : secrets `DEPLOY_SSH_KEY_DEV`, `DEPOT_SSH_KEY_PROD`, `DEPLOY_KNOWN_HOSTS` |
| Clés publiques correspondantes | VPS : `~deploy-dev/.ssh/authorized_keys` et `~deploy-prod/.ssh/authorized_keys` (commandes forcées) |
| Clé de lecture du dépôt (activation de la prod) | VPS : `~deploy-prod/.ssh/github_readonly` ; GitHub : Deploy key sans écriture |
| IP du VPS, GA4, Search Console | GitHub : variables |
| Scripts de déploiement | VPS : `/opt/raijin-deploy` (root, copie figée, C4) |

## C6. Premier déploiement et activation de la prod

Le workflow `Déploiement` est déclenché par `workflow_run` : GitHub exécute la version de `deploy.yml` présente sur
`main`. Il devient donc actif après la fusion de la PR qui l'apporte. « Run workflow » exécute, lui, la version de la
branche choisie : une version modifiée sur `dev` peut déployer le dev, mais ne peut **rien** faire en production (pas de
clé de production dans GitHub, jeton OIDC d'une autre branche refusé).

1. DNS du dev créés (A3) et propagés : `dig +short A dev.raijinshield.com api-dev.raijinshield.com landing-dev.raijinshield.com`.
2. Fusionne la PR `dev → main` (toi) : la CI de `main` puis le **dépôt** de la production s'exécutent. Le résumé du run
   affiche la commande d'activation.
3. **Activation de la prod**, sur le VPS (connecté avec ton compte habituel) :
   ```bash
   sudo -u deploy-prod ls /srv/raijin/incoming/prod          # l'archive <commit>.tar et sa preuve <commit>.json sont là
   sudo -u deploy-prod /opt/raijin-deploy/infra/deploy-gate.sh --approve <commit affiché par GitHub>
   ```
   Le script refuse si le commit n'est pas la tête actuelle de `main` (`git ls-remote` avec la clé de lecture), si
   l'archive a changé depuis sa vérification OIDC, ou si un contrôle échoue. Sinon : sauvegarde, migrations, démarrage,
   santé, et retour automatique en cas d'échec. Alias pratique dans ton `~/.bashrc` :
   `alias raijin-approve='sudo -u deploy-prod /opt/raijin-deploy/infra/deploy-gate.sh --approve'`.
   (Pour l'utiliser sans droits sudo complets, une seule règle suffit, via `sudo visudo -f /etc/sudoers.d/raijin` :
   `<ton-utilisateur> ALL=(deploy-prod) NOPASSWD: /opt/raijin-deploy/infra/deploy-gate.sh --approve *`.)
4. Dev : active l'interrupteur (`gh variable set DEPLOY_DEV_AUTO --repo <compte>/raijin --body 1`, ou Settings →
   Secrets and variables → Actions → Variables), puis GitHub → **Actions → Déploiement → Run workflow** → branche
   `dev`, environnement `dev`. Ensuite, chaque push sur `dev` déploie le dev automatiquement. Pour **suspendre** :
   `gh variable set DEPLOY_DEV_AUTO --body 0` (ou supprime la variable). Cet interrupteur arrête le flux normal ; il
   ne protège pas d'un workflow modifié et poussé sur `dev` (qui peut lire `DEPLOY_SSH_KEY_DEV`) : l'arrêt **sûr** se
   fait sur le VPS, en commentant la ligne de `~deploy-dev/.ssh/authorized_keys` (`docs/SECURITY.md` §17).
5. Suivi sur le VPS :
   ```bash
   sudo -u deploy-dev ls -t /srv/raijin/dev/logs | head -3       # journaux des derniers déploiements
   sudo readlink /var/lib/raijin-deploy/dev/current                          # version en service
   sudo -u deploy-prod ls /srv/raijin/incoming/prod                              # archives de prod en attente d'activation (2 au plus)
   ```
6. Vérifications du dev : `https://dev.raijinshield.com` demande le mot de passe, puis inscription → e-mail visible
   dans Mailpit par le tunnel de C3 (« Lire les e-mails du dev ») ; `curl -s https://api-dev.raijinshield.com/api/v1/health` répond
   sans mot de passe ; `curl -s https://dev.raijinshield.com/robots.txt` affiche `Disallow: /`.

Déploiement manuel sans GitHub (dépannage) : depuis le dépôt cloné, `infra/deploy.sh --env dev` (fichiers
`infra/.env.dev` et `infra/.env.dev.api`, build sur le VPS : voir la RAM en A1).

## C7. Échecs et retour arrière

- **Échec pendant le déploiement** : le run GitHub (dev) ou ta commande `--approve` (prod) se termine en erreur ; le
  VPS a déjà remis en service la dernière version réussie (« dernière version réussie remise en service »).
- **Le retour automatique a échoué** (rare : base indisponible…) : remets en service une version précise (son dossier
  contient sa configuration résolue) :
  ```bash
  sudo ls /var/lib/raijin-deploy/dev/releases                     # versions importées (5 dernières)
  sudo -u deploy-dev sudo -n /opt/raijin-deploy/infra/docker-priv.sh dev recover <commit>-<date>
  sudo -u deploy-prod sudo -n /opt/raijin-deploy/infra/docker-priv.sh prod recover <commit>-<date>
  ```
  (`current` est alors déplacé sur cette version.)
- **Le run GitHub a expiré** (60 min) : le déploiement du dev continue sur le VPS jusqu'au bout ;
  `sudo -u deploy-dev tail -n 50 /srv/raijin/dev/logs/<dernier>.log`.
- **Migration à défaire** (prod) : restaure la sauvegarde prise juste avant (A10), puis `release.sh recover`.

## C8. Mettre à jour les scripts figés

Quand une livraison contient un `deploy-gate.sh`, `docker-priv.sh`, `release.sh`, `backup.sh`, `watchdog.sh`, `lib/common.sh` ou
`lib/deploy_policy.py` différent de la copie du VPS, le déploiement affiche « Scripts de déploiement à mettre à jour ».
Après avoir relu le changement sur GitHub, refais C4 (le déploiement en cours a utilisé les anciens scripts).

## C9. Ressources du VPS

`docker stats --no-stream $(docker ps -q --filter name=raijin-)` : prod et dev. Si la mémoire manque, arrête le dev sans
rien supprimer : `docker stop raijin-dev-api raijin-dev-web raijin-dev-landing raijin-dev-mailpit` (il redémarre au
prochain déploiement ou avec `docker start …`). Ne lance jamais `docker compose down`, `docker system prune` ni
`docker volume prune`.

## C10. Cookies et sous-domaine dev

Les trois cookies de l'API (accès, CSRF et rafraîchissement `__Host-rj_rt`, `Path=/`) portent le préfixe `__Host-` :
aucun attribut `Domain` possible, donc un autre sous-domaine (le dev, par exemple) ne peut pas en déposer pour `app.`.
En plus, `POST /auth/refresh` refuse un en-tête `Cookie` qui répète le nom du refresh et exige que la session du refresh
corresponde au `sid` du cookie d'accès (docs/SECURITY.md, menace 3). L'ancien `__Secure-rj_rt` n'est accepté qu'une
dernière fois, avec un cookie d'accès de la même session, puis effacé. La basicAuth et le cloisonnement du dev restent.
