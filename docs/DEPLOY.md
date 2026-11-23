# Déploiement — Raijin Shield

Ce guide est écrit pour quelqu'un qui n'a jamais déployé d'application. Suis-le **dans l'ordre**, une commande à la
fois, en lisant ce qu'elle affiche avant de passer à la suivante.

- **Partie A** : mise en ligne sur le VPS (Docker Compose derrière le Traefik déjà en place, DNS, variables, clés
  VAPID, webhook Stripe, sauvegardes, surveillance, mises à jour, retour arrière).
- **Partie B** : espace admin, Google (GA4, Search Console, compte de service) et landing.

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
docker compose version      # 2.24 ou plus (sinon : mets à jour le paquet docker-compose-plugin)
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
Adresse IPv4 du VPS : `curl -4 ifconfig.me` sur le VPS (et `curl -6 ifconfig.me` pour l'IPv6, s'il en a une).

| Type | Sous-domaine | Cible | Rôle |
|---|---|---|---|
| A | *(vide)* | IPv4 du VPS | landing `raijinshield.com` |
| A | `www` | IPv4 du VPS | redirection 301 vers `raijinshield.com` |
| A | `app` | IPv4 du VPS | application |
| A | `api` | IPv4 du VPS | API (webhook Stripe, images OG) |
| A | `banc` | IPv4 du VPS | banc de test (phase 8 bis) |
| AAAA | les mêmes 5 | IPv6 du VPS | **seulement** si le VPS a une IPv6 et que Traefik écoute en IPv6 |

- TTL : 3600 (par défaut). Un éventuel enregistrement A « parking » d'OVH sur la racine ou `www` doit être remplacé
  (note sa valeur dans `docs/OPS-LOG.md` avant). **Ne touche pas** aux enregistrements MX, TXT (SPF, DKIM de Resend,
  vérification Google) ni CNAME existants.
- Optionnel, recommandé : un enregistrement **CAA** sur la racine, `0 issue "letsencrypt.org"` (seul Let's Encrypt
  peut alors émettre un certificat pour le domaine).
- Vérifie la propagation (quelques minutes à quelques heures) : `dig +short A app.raijinshield.com` doit afficher
  l'IP du VPS ; fais de même pour `raijinshield.com`, `www`, `api` (et `banc`).
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
| `POSTGRES_SUPERUSER_PASSWORD`, `RAIJIN_DB_PASSWORD`, `BENCH_DB_PASSWORD`, `REDIS_PASSWORD` | `infra/.env` | `openssl rand -hex 32` (une valeur différente chacune) |
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

## A14. Banc de test (phase 8 bis, pas encore)

Les services `raijin-bench-api` et `raijin-bench-web` sont prêts dans le compose (profil `bench`) mais ne démarrent
pas tant que l'API du banc n'existe pas. Au moment venu : hash du mot de passe Traefik (`htpasswd -nBC 12 kyoshiro`, bcrypt de coût 12 ;
résultat **entre apostrophes** dans `BENCH_BASIC_AUTH_USERS`), fichier `infra/.env.bench-api`, puis
`infra/deploy.sh --bench` ; procédure de bascule dans `docs/BENCH.md`.

## A15. Limites connues (audit de la phase 8, à traiter plus tard)

- **Pas de CDN ni de proxy devant Traefik** (Cloudflare en mode « proxy », etc.). L'API fait confiance à **un seul**
  saut (`TRUST_PROXY=1`) : avec un proxy de plus, toutes les requêtes auraient l'IP du proxy (quotas et verrouillages
  communs à tout le monde). Si un jour un CDN est ajouté : `TRUST_PROXY=2` et `forwardedHeaders.trustedIPs` de
  Traefik limités aux plages du CDN, sinon l'en-tête `X-Forwarded-For` devient falsifiable.
- **Réseau Traefik partagé** : tout conteneur de ce réseau (MTC compris) peut joindre `raijin-api:3000` sans passer
  par Traefik et forger `X-Forwarded-For` (contournement des limites par IP, pas d'accès aux comptes). Piste : limiter
  la confiance de l'API au sous-réseau de Traefik (`trust proxy` sur une liste d'adresses au lieu d'un nombre), ou un
  réseau dédié Traefik ↔ Raijin si la configuration de Traefik le permet. Décision à prendre avant l'ouverture publique.
- **Redis partagé par l'API et le banc** (même mot de passe, préfixes de clés différents) : des **ACL Redis** par
  application (un utilisateur `raijin`, un utilisateur `raijin-bench`, chacun limité à son préfixe) sont prévues avec
  le banc en phase 8 bis.
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
