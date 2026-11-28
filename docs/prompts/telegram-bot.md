Utilise les agents du projet (architect, telegram-bot, nestjs-api, test-e2e, security-reviewer, puis final-reviewer) pour ajouter le **bot Telegram de Raijin Shield** au monorepo. Suis CLAUDE.md et PROMPT.md (charte, sécurité, Nx, Git) : ce prompt ne fait qu'ajouter un module.

## 0. Avant de coder
- Lis docs/PROGRESS.md : la phase 3 (analyse de token) est-elle terminée ? Si oui, le bot s'appuie sur l'API d'analyse existante. Sinon, construis le bot contre le contrat `libs/shared/contracts` avec une implémentation simulée, et note-le dans « À brancher ».
- Vérifie dans la documentation officielle de l'API Bot Telegram et de grammY (versions actuelles) : webhooks et `secret_token`, mode confidentialité dans les groupes, limites d'envoi, format HTML autorisé, deep links `/start <payload>`, `language_code`. Note les sources dans docs/decisions.md.
- Le token du bot n'est jamais lu ni affiché : variable `TELEGRAM_BOT_TOKEN` (et `TELEGRAM_WEBHOOK_SECRET`), ajoutées à `.env.example` et à docs/SECRETS-CHECKLIST.md.

## 1. Ce que fait le bot (et ce qu'il ne fait pas)
Le bot est un **vérificateur de risque** et un **canal d'acquisition**. Il ne vend rien, ne recommande rien, ne connecte aucun wallet et ne propose **aucun bouton d'achat**.

### Commandes (anglais par défaut, français si `language_code` commence par « fr », modifiable avec /lang)
| Commande | Effet |
|---|---|
| `/start` | Message d'accueil court + bouton « Open Raijin Shield ». Avec un payload `/start link_<code>` : liaison au compte Raijin (voir §3). Avec `/start ref_<code>` : attribution du parrainage. |
| `/scan <adresse ou lien>` | Analyse du token (adresse de mint, ou lien DexScreener / pump.fun / Solscan / Birdeye dont on extrait l'adresse). |
| *Adresse collée seule* | En privé : même réponse que /scan. En groupe : voir §2. |
| `/watch <adresse>` · `/unwatch <adresse>` · `/watchlist` | Suivi d'un token (compte lié requis), avec les mêmes quotas que l'app. |
| `/alerts on` · `/alerts off` | Active ou coupe les alertes de risque des tokens suivis dans Telegram. |
| `/pro` | Explique le plan Pro et l'essai 7 jours sans carte, avec un bouton vers la page tarifs (UTM). |
| `/lang en` · `/lang fr` | Langue du bot pour cet utilisateur ou ce groupe. |
| `/help` | Liste des commandes + avertissement. |

### Réponse d'analyse (privé et groupe)
- **Une seule image** : la carte Open Graph déjà générée pour `/t/<mint>` (fond sombre, logo, verdict, petit Rai). Si elle n'est pas disponible, envoie le texte seul.
- **Légende en HTML Telegram** (pas de MarkdownV2), avec **tout contenu externe échappé** (nom et symbole du token = données hostiles, tronqués à 32 caractères) :
  ```
  🛡 SAIN | ⚠️ PRUDENCE | ⛔ DANGER   (verdict en majuscules, toujours icône + mot)
  <Nom> ($SYMBOLE) · 7xKX…9fQp
  • raison 1
  • raison 2
  • raison 3          (3 raisons maximum, une ligne chacune)
  Liquidité 48k$ · Âge 6 h · Top10 41 %
  Analyse de risque, pas un conseil en investissement.
  ```
- **Boutons** (inline keyboard) : « Full analysis » → `https://app.raijinshield.com/t/<mint>?utm_source=telegram&utm_medium=bot&utm_campaign=<private|group>` (+ `ref` si l'utilisateur est lié et a un code de parrainage) · « Watch » (callback, compte lié requis) · « Rescan » (callback, limité à 1 par minute et par token).
- Les seuls emojis autorisés sont 🛡 ⚠️ ⛔ et • ; pas de 🚀 💰 📈 ni de « gem », « moon », « x10 ».
- Temps de réponse visé : < 3 s grâce au cache de 60 s de l'API. Au-delà de 1 s, envoyer d'abord l'action « typing », puis éditer un message « Analyse en cours… ».
- Erreurs : adresse invalide → explication courte avec exemple ; token introuvable → « Aucune donnée pour cette adresse, vérifie qu'il s'agit bien d'un token Solana. » ; panne d'une source → verdict avec mention « source X indisponible », jamais de crash.

## 2. Groupes
- Le bot fonctionne dans les groupes **avec le mode confidentialité activé par défaut** : il répond aux commandes (`/scan@RaijinShieldBot`), aux mentions et aux réponses à ses messages.
- Option pour les admins du groupe : `/autoscan on|off`. Une fois activée, et si le bot a été rendu admin ou si le mode confidentialité a été désactivé pour ce bot, il répond automatiquement à toute adresse Solana collée. Documente clairement dans /help ce qu'il faut faire.
- Seuls les admins du groupe peuvent changer `/autoscan` et `/lang`.
- **Anti-spam** : même token déjà analysé dans ce groupe il y a moins de 10 min → réponse courte « Déjà analysé il y a X min » avec lien vers le message précédent. Maximum 20 analyses par heure et par groupe (configurable). Un utilisateur qui spamme est ignoré 10 min.
- Message d'accueil quand le bot est ajouté à un groupe : 3 lignes, commande /help, avertissement.

## 3. Liaison au compte Raijin
- Dans l'app (écran Compte) : bouton « Connect Telegram » qui génère un code à usage unique (10 min) et ouvre `https://t.me/RaijinShieldBot?start=link_<code>`.
- Le bot valide le code auprès de l'API, associe `telegramUserId` au compte et confirme. `/start` sans code pour un utilisateur non lié : proposer de créer un compte ou de se connecter, avec un lien UTM.
- Délier depuis l'app ou par `/unlink`.
- **Quotas** : un utilisateur non lié a 5 analyses par jour (par `telegramUserId`). Un compte lié utilise les quotas de son plan (Gratuit, Essai, Pro).

## 4. Alertes dans Telegram
- Ce sont les mêmes alertes de risque que l'app (dégradation du verdict, LP retirée, mint réactivé, gros holder qui vend), **uniquement sur les tokens suivis**. Pas d'alertes « opportunités ».
- **Gratuit : envoyées avec 10 min de retard** et la mention « Pro users got this 10 min earlier » + bouton /pro. **Pro et Essai : immédiates.**
- Envoi par une file BullMQ dédiée qui respecte les limites de débit de Telegram (par chat et global), avec reprise sur erreur 429 (`retry_after`) et désactivation propre si l'utilisateur a bloqué le bot (erreur 403).

## 5. Architecture
- Nouveau projet Nx **`apps/bot`** (NestJS + **grammY**), tags `scope:bot`, `type:app`. Logique dans **`libs/bot/*`** (commandes, formatage, i18n, anti-spam). Frontières : `scope:bot` peut dépendre de `scope:shared` uniquement ; jamais de `scope:api` ni de `scope:web`.
- Le bot **n'accède pas directement à la base ni aux sources Solana** : il appelle l'API Raijin via des routes internes `/api/v1/internal/bot/*`, authentifiées par un jeton de service (variable d'environnement) et accessibles uniquement sur le réseau Docker interne, pas via Traefik. Ainsi cache, quotas et scoring restent centralisés.
- **Production** : webhook `https://api.raijinshield.com/telegram/webhook` (routé par Traefik vers `apps/bot`), avec vérification de l'en-tête `X-Telegram-Bot-Api-Secret-Token`. **Dev** : long polling, aucun tunnel nécessaire.
- **i18n** : fichiers `en.json` et `fr.json` dans `libs/bot/i18n`, aucun texte en dur. Toutes les chaînes respectent le ton de la charte (BRAND.md).
- docker-compose : service `raijin-bot`, limite mémoire, healthcheck, rien qui touche à MTC.
- Enregistrement automatique au démarrage : liste des commandes (`setMyCommands`) en anglais et en français, description courte et description du bot (tes textes, en tutoiement en français).

## 6. Mesures (pour l'admin)
Événements dans `ProductEvent` : `bot_start`, `bot_scan` (privé/groupe, verdict), `bot_group_added`, `bot_group_removed`, `bot_link`, `bot_click_full_analysis` (via l'UTM), `bot_pro_click`. Dans l'admin, une carte « Telegram » : utilisateurs actifs, groupes actifs, analyses par jour, part privé/groupe, comptes liés, conversions vers Essai et Pro venues du bot.

## 7. Sécurité
- Webhook vérifié par secret ; mise à jour (update) rejetée si l'en-tête est absent ou faux.
- Validation stricte de chaque entrée (adresse base58 de 32 à 44 caractères, liens sur liste blanche de domaines).
- Échappement HTML systématique de toute donnée externe ; aucun lien construit depuis des métadonnées de token.
- Codes de liaison : aléatoires, à usage unique, expiration 10 min, liés à l'utilisateur qui les a générés.
- Logs sans contenu de messages privés : seulement type de commande, chat id haché, durée, résultat.
- Aucune lecture de `.env`, aucun token dans le code ni dans les logs.

## 8. Tests
- Unitaires : extraction d'adresse depuis texte et liens, formatage HTML (y compris noms de tokens malveillants : `<script>`, `<a href>`, emojis, 500 caractères), i18n, anti-spam, quotas, délai des alertes Gratuit/Pro.
- Intégration : mise à jour Telegram simulée → réponse attendue (privé, groupe avec et sans mention, autoscan), callbacks des boutons, liaison de compte complète, 429 et 403.
- Sécurité : webhook sans secret → 401 ; token des routes internes invalide → 401.
- Toutes les commandes Nx du projet vertes, sans violation de frontières.

## 9. Ce que je fais moi-même (à me demander au bon moment, en tête de docs/PROGRESS.md)
1. Dans Telegram, ouvrir **@BotFather** → `/newbot` → nom « Raijin Shield » → identifiant **RaijinShieldBot**. S'il est pris, essayer `RaijinShield_bot` ou `RaijinShieldAppBot` et me dire lequel est retenu, pour que tu mettes à jour la config et les liens.
2. Copier le token donné par BotFather **dans mon `.env` uniquement** (variable `TELEGRAM_BOT_TOKEN`).
3. BotFather → `/setuserpic` : envoyer `libs/brand/icons/mark-512.png` (tu me rappelles le chemin).
4. Me dire « bot créé », puis tu reprends.

## 10. Livraison
- Mets à jour docs/PROGRESS.md (nouvelle phase « Bot Telegram »), docs/ANALYTICS.md, docs/SECRETS-CHECKLIST.md et la page `/help` de la landing (section « Telegram bot »).
- Landing : bloc « Vérifie un token directement dans Telegram » avec bouton vers le bot (UTM).
- Boucle habituelle : test-e2e → security-reviewer → commits sur `dev`. Puis `final-reviewer` sur ce lot. S'il valide : push sur `dev` et PR vers `main` intitulée « feat(bot): bot Telegram Raijin Shield ». Ne merge jamais.
- Résumé final en 8 lignes : ce qui marche, comment l'essayer en privé et en groupe, ce qui reste « À brancher ».
