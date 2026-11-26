# Comptes à créer pour Raijin

Tu crées les comptes (identité, e-mail, mot de passe, 2FA, paiement). Claude Code se connecte ensuite via Chrome pour tout paramétrer.
Coche au fur et à mesure. Active la **double authentification** partout où c'est proposé.

## Ordre de création (important)
1. **Domaine** `raijinshield.com` chez OVH (ton compte OVH existant).
2. [x] **Zoho Mail** (fait le 2026-11-26 : `contact@` boîte, `support@` et `admin@` alias, DNS MX/SPF/DKIM/DMARC posés ; détail dans `docs/OPS-LOG.md`) (nouveau compte, inscription avec ton e-mail perso), puis lance `docs/prompts/zoho-mail.md` : il crée `contact@`, `support@` et `admin@raijinshield.com`.
3. **Tous les autres comptes** avec **`admin@raijinshield.com`** comme e-mail d'inscription (alias gratuit qui arrive dans la même boîte, filtré dans un dossier « Comptes ») : Google (option « utiliser mon adresse e-mail actuelle », pas besoin de Gmail), Stripe, Resend, Helius, Backblaze, UptimeRobot, Sentry, X, Telegram.
   Exceptions : **GitHub** et **OVH** restent sur tes comptes perso existants.

**Sécurité de ce choix** : si le domaine expire ou si la boîte Zoho est bloquée, tu perds l'accès à tous ces comptes. Donc : **renouvellement automatique** du domaine chez OVH, **2FA par application** (pas par SMS ni par e-mail) sur chaque compte, **codes de secours** rangés dans ton gestionnaire de mots de passe, et ton e-mail perso en **adresse de récupération** partout où c'est proposé.


## A. Obligatoires avant de lancer Claude Code

| # | Service | À quoi ça sert | Coût | Ce que TU fais | Ce que Claude fait ensuite (Chrome) |
|---|---|---|---|---|---|
| 1 | **GitHub** (tu l'as) | Dépôt `raijin`, PR, CI | 0 € | Si ton ancien Raijin a déjà un dépôt nommé `raijin`, renomme-le `raijin-old` (Settings → Rename). `gh auth login` sur ton PC. | Dépôt **privé** (gratuit), secrets de CI (noms seulement, tu colles les valeurs). Pas de protection de branche (payante en privé) : `main` est protégée par les permissions de Claude Code |
| 2 | **Nom de domaine `raijinshield.com`** chez **OVH** (même compte que ton VPS) | Site, app, API, e-mails | 8,49 € HT la 1re année, puis 14,29 € HT/an | **Acheter** le domaine (Claude ne paie jamais) | Zone DNS : enregistrements A/AAAA vers le VPS pour la racine, `www`, `app`, `api`, `banc` ; enregistrements Resend (SPF, DKIM, DMARC) ; vérification Google |
| 3 | [x] **Stripe** (mode test configuré le 2026-11-27 : produit, 2 prix, portail, branding, e-mails, 2 webhooks ; restent les secrets à copier et ce qui exige l'activation ; détail dans `docs/OPS-LOG.md`) | Abonnements | 0 € fixe, ~1,5 % + 0,25 € par paiement UE | Créer un **compte Stripe séparé de celui de MyTradingCoach** (même identifiant, « Nouveau compte »), au nom de ta micro-entreprise, nom public « Raijin Shield », libellé bancaire `RAIJINSHIELD`. Versements vers le **compte Qonto de MyTradingCoach** (pas de sous-compte payant) : chaque virement Stripe arrive avec un libellé distinct ; ajoute l’étiquette « Raijin » dans Qonto. **Activation du mode live = toi** (identité, SIRET, IBAN). | En mode test : produit « Raijin Pro », prix 14,90 €/mois et 149 €/an, Customer Portal (résiliation, changement de plan, factures), branding (logo, couleur #facc15), e-mails clients, endpoint webhook `https://api.raijinshield.com/api/v1/billing/webhook` avec les 4 événements. Plus tard, la même chose en live. |
| 4 | **Resend** | E-mails transactionnels | 0 € (3 000/mois) | Créer le compte | Ajouter le domaine, poser les DNS chez OVH, vérifier, créer l'expéditeur `noreply@` |
| 5 | **Helius** | Données Solana (RPC) | 0 € (plan gratuit) | Créer le compte | Créer le projet « raijin » et une 2e clé « raijin-banc-de-test », restreindre les clés par domaine/IP si proposé |
| 6 | [x] **Google** (configuré le 2026-11-26 : GA4 propriété 566021245, flux `G-PT7KBL87SH`, Search Console, Cloud `raijin-admin`, compte de service lecteur ; reste la clé JSON ; détail dans `docs/OPS-LOG.md`) (compte créé avec admin@raijinshield.com, sans Gmail) | Analytics, Search Console, API | 0 € | Créer le compte Google | GA4 : propriété + flux web + événements de conversion ; Search Console : propriété domaine (vérif DNS chez OVH) + sitemap ; Google Cloud : projet, activation des API « Google Analytics Data » et « Search Console », **compte de service** ajouté en lecteur sur GA4 et Search Console |

## B. Recommandés (avant la mise en ligne)

| # | Service | À quoi ça sert | Coût | Ce que TU fais | Ce que Claude fait |
|---|---|---|---|---|---|
| 7 | [x] **Zoho Mail** (configuré le 2026-11-26) — **nouvelle organisation séparée de celle de MTC** | Boîtes `contact@` et `support@raijinshield.com` | 0 € (le plan gratuit n'accepte qu'un domaine par organisation) | Créer un **nouveau compte Zoho** (avec ton e-mail perso, voir « Ordre de création ») et choisir le plan Forever Free ; ajouter ce compte dans l'app Zoho Mail à côté de celui de MTC | Ajouter le domaine `raijinshield.com`, DNS MX/SPF/DKIM chez OVH (compatibles avec Resend), alias `support@`, filtres (Stripe, inscriptions, alertes) |
| 8 | **Backblaze B2** (tu l'utilises pour XMR) | Sauvegardes hors site des bases | ~0 € (10 Go gratuits) | Rien si compte existant | Bucket **dédié** `raijin-backups` privé, règle de cycle de vie 30 jours, clé d'application limitée à ce bucket |
| 9 | **UptimeRobot** | Être prévenu si le site tombe | 0 € | Créer le compte | Moniteurs sur landing, app, `api/health`, banc ; alertes e-mail |
| 10 | **Sentry** | Erreurs front et back en production | 0 € (plan Developer) | Créer le compte | Projets `raijin-web`, `raijin-api`, `raijin-banc`, DSN, filtrage des données personnelles |

## C. Pour lancer et vendre

| # | Service | À quoi ça sert | Coût | Ce que TU fais | Ce que Claude fait |
|---|---|---|---|---|---|
| 11 | **Micro-entreprise** (formalites.entreprises.gouv.fr) | SIRET : obligatoire pour Stripe live et les mentions légales | 0 € | **Toi seul** (déclaration, choix BIC/BNC, versement libératoire, ACRE) | Rien. Il remplit les mentions légales avec tes infos une fois que tu les lui donnes |
| 12 | **X** (@raijin…) | Acquisition | 0 € | Créer le compte, choisir le @ | Bio, photo (Rai), bannière, lien, post épinglé (rédigés, tu valides avant publication) |
| 13 | **Telegram** (canal) | Communauté crypto, annonces | 0 € | Créer le canal | Description, photo, lien, message épinglé |

## D. Optionnels plus tard
- **Jupiter Portal** (portal.jup.ag) : clé API si le quota gratuit de lite-api devient limitant.
- **RugCheck** : compte uniquement si leur API impose une clé.
- **DexScreener / GeckoTerminal** : aucun compte nécessaire.

## E. À arrêter APRÈS la bascule du banc (pas avant)
- **Supabase** (projet « Raijin », réf. jntknbxdpetvcmoejncm) : mettre en pause, supprimer après 30 jours.
- **Vercel** (raijin.vercel.app) : supprimer le projet après la bascule.

## Clés secrètes : règle du jeu
Claude Code crée et configure tout, **mais il ne copie jamais une clé secrète**. Quand une clé est générée (Stripe, Resend, Helius, Google, B2, Sentry), il s'arrête sur la page et te demande de la copier toi-même dans :
1. ton `.env` local (à partir de `.env.example`) ;
2. le `.env` du VPS (au déploiement).
La liste exacte des variables est dans `docs/SECRETS-CHECKLIST.md`, générée par Claude Code.
