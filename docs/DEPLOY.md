# Déploiement — Raijin Shield

Ce document est complété phase après phase. La procédure complète du VPS (Docker Compose, Traefik, sauvegardes,
`infra/deploy.sh`) arrive en phase 8. Ici : **l'espace admin** et **l'accès Google** (phase 6 bis).

Rappels :
- les secrets ne vont **que** dans le fichier `.env` du serveur (jamais dans Git, jamais dans un ticket ou un chat) ;
- c'est toi qui lances les commandes sur le VPS : aucun agent ne s'y connecte ;
- chaque variable est décrite dans `docs/ENV.md` (blocs « Google » et « Espace admin »).

---

## 1. Donner le rôle ADMIN à ton compte

Le rôle ADMIN ne s'attribue **jamais** depuis l'interface : uniquement par une commande, sur la machine où tourne l'API.

1. Crée ton compte normalement sur l'app (`https://app.raijinshield.com/inscription`) et **confirme ton e-mail**
   (la commande refuse un compte non vérifié).
2. Lance la commande :
   - en local (développement) :
     ```bash
     pnpm nx run api:make-admin --email=ton@email.fr
     ```
   - en production, sur le VPS, dans le dossier du projet Compose `raijin` :
     ```bash
     docker compose -p raijin exec raijin-api node dist/apps/api/cli.js make-admin --email=ton@email.fr
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
docker compose -p raijin exec raijin-api node dist/apps/api/cli.js admin-reset-2fa --email=ton@email.fr
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

Redémarre l'API (`docker compose -p raijin up -d raijin-api`), puis ouvre `/admin/sante` : les lignes
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
