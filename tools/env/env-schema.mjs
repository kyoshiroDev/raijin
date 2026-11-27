// Modèle de référence UNIQUE des variables d'environnement de Raijin Shield (aucune valeur réelle ici).
// Lu par tools/env/env-tool.mjs (bash tools/env/organiser-env.sh). Détail de chaque variable : docs/ENV.md.
//
// Champs d'une variable :
//   name      nom exact
//   section   identifiant de section (SECTIONS ci-dessous)
//   desc      description courte en français (une ligne)
//   link      où obtenir la valeur (URL) ou commande qui la génère
//   secret    true = valeur jamais affichée (l'outil n'affiche de toute façon aucune valeur)
//   required  environnements où la variable est obligatoire : 'local' (ta machine), 'dev', 'prod'
//   envs      fichiers où elle est proposée : 'local' (.env), 'dev' (.env.dev), 'prod' (.env.prod)
//   advanced  true = réglage avancé : écrit seulement s'il est déjà présent ou s'il a une valeur recommandée
//   def       valeur par défaut du code (vide = comportement par défaut décrit dans docs/ENV.md)
//   rec       valeur recommandée par environnement { local, dev, prod } (écrite si la variable est absente)
//   share     environnements où la valeur de .env est reprise si la variable y est absente (clés communes)
//   vps       fichier(s) du serveur : 'compose' (env/.env), 'api' (env/.env.api), 'bench' (env/.env.bench-api)
//   vpsGen    true = secret généré (ou demandé) par l'installation du VPS : laissé vide, jamais remplacé
//   vpsFill   true = renseigné automatiquement par l'installation du VPS (détection Traefik, --repo)
//   imposed   true = imposée par infra/docker-compose*.yml sur le serveur (inutile dans .env.dev / .env.prod)
//   example   valeur factice de .env.example (sinon : def, ou vide)

export const SECTIONS = [
  { id: 'base', title: 'Base, Redis et adresses' },
  { id: 'secu', title: 'Sécurité (secrets générés)' },
  { id: 'helius', title: 'Helius (données Solana)' },
  { id: 'google', title: 'Google (GA4, Search Console)' },
  { id: 'stripe', title: 'Stripe (paiement)' },
  { id: 'mail', title: 'E-mails' },
  { id: 'bot', title: 'Bot Telegram' },
  { id: 'radar', title: 'Radar' },
  { id: 'sentry', title: 'Sentry (suivi des erreurs, facultatif)' },
  {
    id: 'serveur',
    title: 'Serveur (Traefik, déploiement, sauvegardes, veille)',
  },
  { id: 'banc', title: 'Banc de test (serveur de prod seulement, facultatif)' },
  {
    id: 'avance',
    title: 'Réglages avancés (optionnel : vide ou absent = valeur par défaut)',
  },
];

export const OTHER_SECTION_TITLE = 'Autres (à vérifier)';
export const VPS_GEN_NOTE = "généré par l'installation du VPS";

const L = 'local';
const D = 'dev';
const P = 'prod';
const ALL = [L, D, P];
const SRV = [D, P];

const HELIUS_KEYS = 'https://dashboard.helius.dev/api-keys';
const HELIUS_CREDITS = 'https://www.helius.dev/docs/billing/credits';
const STRIPE_KEYS = 'https://dashboard.stripe.com/test/apikeys';
const STRIPE_PRODUCTS = 'https://dashboard.stripe.com/test/products';
const B48 = 'openssl rand -base64 48';
const B32 = 'openssl rand -base64 32';
const HEX = 'openssl rand -hex 32';

/** Raccourci : variable avancée de l'API (ta machine ; sur le serveur, fichier env/.env.api). */
const adv = (name, desc, def = '', extra = {}) => ({
  name,
  section: 'avance',
  desc,
  advanced: true,
  envs: [L],
  vps: ['api'],
  def,
  ...extra,
});

// prettier-ignore
export const VARIABLES = [
  // ---------------------------------------------------------------- 1. Base, Redis et adresses
  { name: 'NODE_ENV', section: 'base', desc: "Mode d'exécution (development sur ta machine)", envs: [L], def: 'development', rec: { local: 'development' }, imposed: true },
  { name: 'DATABASE_URL', section: 'base', desc: 'Adresse de la base PostgreSQL locale (docker-compose.dev.yml, port 5433)', secret: true, envs: [L], rec: { local: 'postgresql://raijin:changeme-factice@localhost:5433/raijin?schema=public' }, imposed: true },
  { name: 'REDIS_URL', section: 'base', desc: 'Adresse du Redis local (port 6380)', envs: [L], rec: { local: 'redis://localhost:6380' }, imposed: true },
  { name: 'POSTGRES_USER', section: 'base', desc: 'Utilisateur du Postgres local', envs: [L], def: 'raijin', rec: { local: 'raijin' } },
  { name: 'POSTGRES_PASSWORD', section: 'base', desc: 'Mot de passe du Postgres local (le même que dans DATABASE_URL)', secret: true, envs: [L], link: B32, example: 'changeme-factice', rec: { local: 'changeme-factice' } },
  { name: 'POSTGRES_DB', section: 'base', desc: 'Nom de la base locale', envs: [L], def: 'raijin', rec: { local: 'raijin' } },
  { name: 'APP_URL', section: 'base', desc: "Adresse de l'app (prod : https://app.raijinshield.com)", envs: [L], rec: { local: 'http://localhost:4200' }, imposed: true },
  { name: 'LANDING_URL', section: 'base', desc: 'Adresse de la landing (prod : https://raijinshield.com)', envs: [L], rec: { local: 'http://localhost:4321' }, imposed: true },
  { name: 'API_URL', section: 'base', desc: "Adresse de l'API (prod : https://api.raijinshield.com)", envs: [L], rec: { local: 'http://localhost:3100' }, imposed: true },
  { name: 'API_PORT', section: 'base', desc: "Port de l'API sur ta machine (3000 est pris par d'autres projets)", envs: [L], def: '3100', rec: { local: '3100' }, imposed: true },
  { name: 'CORS_ORIGINS', section: 'base', desc: 'Origines autorisées (app + landing), séparées par des virgules', envs: [L], rec: { local: 'http://localhost:4200,http://localhost:4321' }, imposed: true },
  { name: 'LANDING_DOMAIN', section: 'base', desc: 'Nom de domaine de la landing (enregistrement DNS vers le VPS)', required: SRV, envs: SRV, vps: ['compose'], rec: { dev: 'landing-dev.raijinshield.com', prod: 'raijinshield.com' } },
  { name: 'APP_DOMAIN', section: 'base', desc: "Nom de domaine de l'app", required: SRV, envs: SRV, vps: ['compose'], rec: { dev: 'dev.raijinshield.com', prod: 'app.raijinshield.com' } },
  { name: 'API_DOMAIN', section: 'base', desc: "Nom de domaine de l'API", required: SRV, envs: SRV, vps: ['compose'], rec: { dev: 'api-dev.raijinshield.com', prod: 'api.raijinshield.com' } },
  { name: 'BENCH_DOMAIN', section: 'base', desc: 'Nom de domaine du banc de test', envs: [P], vps: ['compose'], rec: { prod: 'banc.raijinshield.com' } },

  // ---------------------------------------------------------------- 2. Sécurité (secrets générés)
  { name: 'JWT_ACCESS_SECRET', section: 'secu', desc: 'Signature des sessions (vide sur ta machine = généré à chaque démarrage)', secret: true, envs: ALL, vps: ['api'], vpsGen: true, link: B48, required: SRV, example: 'changeme-access-secret-factice' },
  { name: 'COOKIE_SECRET', section: 'secu', desc: 'Signature des jetons anti-CSRF', secret: true, envs: ALL, vps: ['api'], vpsGen: true, link: B32, required: SRV, example: 'changeme-cookie-secret-factice' },
  { name: 'IP_HASH_SECRET', section: 'secu', desc: 'Empreinte des IP des visiteurs anonymes (quota)', secret: true, envs: ALL, vps: ['api'], vpsGen: true, link: B48, required: SRV, example: 'changeme-ip-hash-secret-factice' },
  { name: 'TOTP_ENCRYPTION_KEY', section: 'secu', desc: 'Chiffrement de la 2FA admin (32 octets en base64)', secret: true, envs: ALL, vps: ['api'], vpsGen: true, link: B32, required: SRV, example: 'changeme-cle-totp-factice' },
  { name: 'VAPID_PUBLIC_KEY', section: 'secu', desc: 'Clé publique des notifications push (paire propre à chaque environnement)', envs: ALL, vps: ['api'], vpsGen: true, link: 'pnpm exec web-push generate-vapid-keys --json' },
  { name: 'VAPID_PRIVATE_KEY', section: 'secu', desc: 'Clé privée des notifications push (avec la clé publique, jamais seule)', secret: true, envs: ALL, vps: ['api'], vpsGen: true, link: 'pnpm exec web-push generate-vapid-keys --json' },
  { name: 'VAPID_SUBJECT', section: 'secu', desc: 'Contact exigé par les services push (mailto: ou https:)', envs: ALL, vps: ['api'], def: 'mailto:support@raijinshield.com', rec: { local: 'mailto:support@raijinshield.com', dev: 'mailto:support@raijinshield.com', prod: 'mailto:support@raijinshield.com' } },
  { name: 'POSTGRES_SUPERUSER_PASSWORD', section: 'secu', desc: 'Mot de passe administrateur Postgres du serveur', secret: true, envs: SRV, vps: ['compose'], vpsGen: true, link: HEX, required: SRV },
  { name: 'RAIJIN_DB_PASSWORD', section: 'secu', desc: "Mot de passe de la base de l'app sur le serveur", secret: true, envs: SRV, vps: ['compose'], vpsGen: true, link: HEX, required: SRV },
  { name: 'BENCH_DB_PASSWORD', section: 'secu', desc: 'Mot de passe de la base du banc sur le serveur', secret: true, envs: SRV, vps: ['compose'], vpsGen: true, link: HEX, required: SRV },
  { name: 'REDIS_PASSWORD', section: 'secu', desc: "Mot de passe Redis de l'API sur le serveur", secret: true, envs: SRV, vps: ['compose'], vpsGen: true, link: HEX, required: SRV },
  { name: 'REDIS_BENCH_PASSWORD', section: 'secu', desc: 'Mot de passe Redis du banc (prod)', secret: true, envs: [P], vps: ['compose'], vpsGen: true, link: HEX },
  { name: 'EDGE_SHARED_SECRET', section: 'secu', desc: "Secret posé par Traefik (en-tête X-Raijin-Edge) vers l'API et le banc de la prod", secret: true, envs: [P], vps: ['compose'], vpsGen: true, link: HEX, required: [P] },

  // ---------------------------------------------------------------- 3. Helius
  { name: 'HELIUS_API_KEY', section: 'helius', desc: 'Clé Helius (sans clé sur ta machine : RPC public et simulations)', secret: true, envs: ALL, vps: ['api'], link: HELIUS_KEYS, share: SRV, required: [P] },
  { name: 'HELIUS_DAILY_CREDIT_BUDGET', section: 'helius', desc: "Crédits Helius par jour pour l'API (bas en dev)", advanced: true, envs: [L], vps: ['api'], link: HELIUS_CREDITS, def: '22000', rec: { dev: '5000' } },
  { name: 'WATCH_DAILY_CREDIT_BUDGET', section: 'helius', desc: 'Part des crédits Helius réservée aux suivis', advanced: true, envs: [L], vps: ['api'], link: HELIUS_CREDITS, def: '12000', rec: { dev: '2000' } },
  { name: 'WALLET_DAILY_CREDIT_BUDGET', section: 'helius', desc: 'Part des crédits Helius réservée aux scans de wallet', advanced: true, envs: [L], vps: ['api'], link: HELIUS_CREDITS, def: '3000', rec: { dev: '1000' } },

  // ---------------------------------------------------------------- 4. Google
  { name: 'GA4_MEASUREMENT_ID', section: 'google', desc: 'ID de flux GA4 « G-… » (landing ; vide = ni GA4 ni bannière)', envs: [L, P], vps: ['compose'], link: 'https://analytics.google.com/ → Administration → Flux de données', share: [P] },
  { name: 'GOOGLE_SITE_VERIFICATION', section: 'google', desc: 'Balise HTML Search Console (inutile si vérifié par DNS)', envs: [L, P], vps: ['compose'], link: 'https://search.google.com/search-console', share: [P] },
  { name: 'GA4_PROPERTY_ID', section: 'google', desc: 'ID numérique de la propriété GA4 (écrans de l’admin)', envs: [L, P], vps: ['api'], link: 'https://analytics.google.com/ → Administration → Paramètres de la propriété', share: [P] },
  { name: 'GOOGLE_SERVICE_ACCOUNT_JSON', section: 'google', desc: 'Clé JSON du compte de service, sur une ligne (lecture seule)', secret: true, envs: [L, P], vps: ['api'], link: 'https://console.cloud.google.com/iam-admin/serviceaccounts', share: [P] },
  { name: 'SEARCH_CONSOLE_SITE_URL', section: 'google', desc: 'Propriété Search Console (ex. sc-domain:raijinshield.com)', envs: [L, P], vps: ['api'], link: 'https://search.google.com/search-console', share: [P] },

  // ---------------------------------------------------------------- 5. Stripe
  { name: 'BILLING_PROVIDER', section: 'stripe', desc: 'fake (simulation, ta machine) ou stripe (serveur)', envs: ALL, vps: ['api'], rec: { dev: 'stripe', prod: 'stripe' } },
  { name: 'STRIPE_SECRET_KEY', section: 'stripe', desc: 'Clé secrète Stripe « sk_test_… » (jamais sk_live_ hors prod)', secret: true, envs: ALL, vps: ['api'], link: STRIPE_KEYS, share: SRV, required: [P] },
  { name: 'STRIPE_WEBHOOK_SECRET', section: 'stripe', desc: 'Secret « whsec_… » du webhook (un par environnement)', secret: true, envs: ALL, vps: ['api'], link: 'https://dashboard.stripe.com/test/webhooks (local : stripe listen)', required: [P] },
  { name: 'STRIPE_PRICE_PRO_MONTHLY', section: 'stripe', desc: 'ID du prix mensuel « price_… » de Raijin Pro (14,90 €)', envs: ALL, vps: ['api'], link: STRIPE_PRODUCTS, share: SRV, required: [P] },
  { name: 'STRIPE_PRICE_PRO_YEARLY', section: 'stripe', desc: 'ID du prix annuel « price_… » de Raijin Pro (149 €)', envs: ALL, vps: ['api'], link: STRIPE_PRODUCTS, share: SRV, required: [P] },

  // ---------------------------------------------------------------- 6. E-mails
  { name: 'MAIL_PROVIDER', section: 'mail', desc: 'smtp (Mailpit sur ta machine et en dev) ou resend (prod)', envs: [L, P], vps: ['api'], rec: { local: 'smtp', prod: 'resend' } },
  { name: 'RESEND_API_KEY', section: 'mail', desc: "Clé Resend d'envoi des e-mails (prod ; dev : capturés par Mailpit)", secret: true, envs: [L, P], vps: ['api'], link: 'https://resend.com/api-keys', share: [P], required: [P] },
  { name: 'MAIL_FROM', section: 'mail', desc: 'Expéditeur (domaine vérifié sur https://resend.com/domains)', envs: [L, P], vps: ['api'], rec: { local: '"Raijin <noreply@raijinshield.com>"', prod: '"Raijin <noreply@raijinshield.com>"' } },
  { name: 'SMTP_HOST', section: 'mail', desc: 'Serveur SMTP local (Mailpit)', envs: [L], rec: { local: 'localhost' }, vps: ['api'] },
  { name: 'SMTP_PORT', section: 'mail', desc: 'Port SMTP local (Mailpit, interface http://localhost:8026)', envs: [L], rec: { local: '1026' }, vps: ['api'] },

  // ---------------------------------------------------------------- 7. Bot Telegram
  { name: 'TELEGRAM_BOT_TOKEN', section: 'bot', desc: 'Token du bot (dev et prod : deux bots distincts ; vide = bot désactivé)', secret: true, envs: ALL, vps: ['compose'], link: 'https://t.me/BotFather → /newbot', share: [D] },
  { name: 'TELEGRAM_BOT_USERNAME', section: 'bot', desc: 'Identifiant public du bot, sans @', envs: ALL, vps: ['compose', 'api'], share: [D], rec: { prod: 'RaijinShieldBot' } },
  { name: 'TELEGRAM_WEBHOOK_SECRET', section: 'bot', desc: 'Secret du webhook Telegram (en-tête de chaque appel)', secret: true, envs: ALL, vps: ['compose'], link: HEX },
  { name: 'BOT_SERVICE_TOKEN', section: 'bot', desc: 'Secret partagé bot → API (même valeur des deux côtés)', secret: true, envs: ALL, vps: ['compose', 'api'], link: HEX },
  { name: 'BOT_LOG_SALT', section: 'bot', desc: 'Hachage des identifiants de chat dans les journaux du bot', secret: true, envs: ALL, vps: ['compose'], link: HEX },
  { name: 'REDIS_BOT_PASSWORD', section: 'bot', desc: 'Mot de passe Redis du bot sur le serveur (vide = bot non démarré)', secret: true, envs: SRV, vps: ['compose'], link: HEX },

  // ---------------------------------------------------------------- 8. Radar
  { name: 'RADAR_ENABLED', section: 'radar', desc: 'Coupe-circuit du radar : 0 = en pause (vide = actif)', envs: ALL, vps: ['api'] },

  // ---------------------------------------------------------------- 9. Sentry
  { name: 'SENTRY_DSN_API', section: 'sentry', desc: "DSN Sentry de l'API (vide = désactivé)", envs: ALL, vps: ['api'], link: 'https://sentry.io/settings/projects/ → Client Keys', share: SRV },
  { name: 'SENTRY_DSN_WEB', section: 'sentry', desc: "DSN Sentry de l'app web (vide = désactivé)", envs: [L], vps: ['api'], link: 'https://sentry.io/settings/projects/ → Client Keys' },
  { name: 'SENTRY_ENVIRONMENT', section: 'sentry', desc: "Nom de l'environnement dans Sentry", envs: ALL, vps: ['api'], rec: { local: 'development', dev: 'dev', prod: 'production' } },

  // ---------------------------------------------------------------- 10. Serveur
  { name: 'TRAEFIK_NETWORK', section: 'serveur', desc: 'Réseau Docker du Traefik existant (dev option B : le même que la prod)', required: SRV, envs: SRV, vps: ['compose'], vpsFill: true },
  { name: 'TRAEFIK_ENTRYPOINT', section: 'serveur', desc: 'Entrypoint HTTPS de Traefik (souvent websecure)', required: SRV, envs: SRV, vps: ['compose'], vpsFill: true },
  { name: 'TRAEFIK_CERTRESOLVER', section: 'serveur', desc: "Certresolver Let's Encrypt de Traefik", required: SRV, envs: SRV, vps: ['compose'], vpsFill: true },
  { name: 'RAIJIN_NAME', section: 'serveur', desc: 'Préfixe des noms Docker du dev (ne pas changer)', envs: [D], vps: ['compose'], rec: { dev: 'raijin-dev' } },
  { name: 'RAIJIN_DEV_EDGE', section: 'serveur', desc: "Réseau d'entrée du dev : traefik-shared (option B retenue)", envs: [D], vps: ['compose'], rec: { dev: 'traefik-shared' } },
  { name: 'DEV_BASIC_AUTH_USERS', section: 'serveur', desc: 'Mot de passe devant tout le dev (htpasswd -nBC 12, ENTRE APOSTROPHES)', secret: true, envs: [D], vps: ['compose'], vpsGen: true, required: [D] },
  { name: 'DEPLOY_GITHUB_REPOSITORY', section: 'serveur', desc: 'Dépôt GitHub compte/raijin (déploiement continu)', required: [P], envs: [P], vps: ['compose'], vpsFill: true },
  { name: 'DEPLOY_GIT_REMOTE', section: 'serveur', desc: 'Adresse SSH du dépôt (git@github.com:compte/raijin.git)', required: [P], envs: [P], vps: ['compose'], vpsFill: true },
  { name: 'WATCHDOG_ALERT_EMAIL', section: 'serveur', desc: 'Ton adresse pour les alertes de la veille du serveur', required: [P], envs: [P], vps: ['compose'] },
  { name: 'BACKUP_RCLONE_REMOTE', section: 'serveur', desc: 'Remote rclone chiffré vers B2 (vide = pas de copie hors site)', envs: [P], vps: ['compose'], link: 'https://secure.backblaze.com/b2_buckets.htm' },
  { name: 'BACKUP_DIR', section: 'serveur', desc: 'Dossier des sauvegardes sur le serveur', envs: [P], vps: ['compose'], rec: { prod: '/var/backups/raijin' } },
  { name: 'BACKUP_RETENTION_DAYS', section: 'serveur', desc: 'Jours de sauvegardes gardés', envs: [P], vps: ['compose'], rec: { prod: '7' } },
  { name: 'BENCH_BASIC_AUTH_USERS', section: 'serveur', desc: 'Mot de passe devant le banc (htpasswd -nBC 12, ENTRE APOSTROPHES)', secret: true, envs: [P], vps: ['compose'] },
  { name: 'WATCHDOG_FAILS_BEFORE_ALERT', section: 'serveur', desc: 'Échecs de suite avant une alerte de la veille', envs: [P], vps: ['compose'], advanced: true, rec: { prod: '2' } },
  { name: 'WATCHDOG_REMIND_HOURS', section: 'serveur', desc: 'Rappel de la veille toutes les N heures', envs: [P], vps: ['compose'], advanced: true, rec: { prod: '6' } },
  { name: 'WATCHDOG_DISK_PCT', section: 'serveur', desc: 'Alerte au-delà de ce taux de disque occupé (%)', envs: [P], vps: ['compose'], advanced: true, rec: { prod: '85' } },
  { name: 'WATCHDOG_MIN_MEM_MB', section: 'serveur', desc: 'Alerte en dessous de cette mémoire libre (Mo)', envs: [P], vps: ['compose'], advanced: true, rec: { prod: '200' } },
  { name: 'WATCHDOG_EXTERNAL', section: 'serveur', desc: 'Vérifier aussi les adresses publiques (1 ou 0)', envs: [P], vps: ['compose'], advanced: true, rec: { prod: '1' } },

  // ---------------------------------------------------------------- 11. Banc de test (prod)
  { name: 'BENCH_OWNER_EMAIL', section: 'banc', desc: 'Ton adresse : compte unique du banc (vide = banc non envoyé au serveur)', envs: [P], vps: ['bench'] },
  { name: 'BENCH_MODE', section: 'banc', desc: 'shadow (avant la bascule) ou primary', envs: [P], vps: ['bench'], rec: { prod: 'shadow' } },
  { name: 'BENCH_SESSION_SECRET', section: 'banc', desc: 'Signature des sessions du banc (distinct de Raijin)', secret: true, envs: [P], vps: ['bench'], link: B48 },
  { name: 'BENCH_TOTP_ENCRYPTION_KEY', section: 'banc', desc: 'Chiffrement du TOTP du banc (32 octets en base64)', secret: true, envs: [P], vps: ['bench'], link: B32 },
  { name: 'BENCH_HELIUS_API_KEY', section: 'banc', desc: 'Clé Helius du banc (distincte de celle de Raijin)', secret: true, envs: [P], vps: ['bench'], link: HELIUS_KEYS },
  { name: 'BENCH_VAPID_PUBLIC_KEY', section: 'banc', desc: 'Clé publique push du banc (paire propre au banc)', envs: [P], vps: ['bench'], link: 'pnpm exec web-push generate-vapid-keys --json' },
  { name: 'BENCH_VAPID_PRIVATE_KEY', section: 'banc', desc: 'Clé privée push du banc', secret: true, envs: [P], vps: ['bench'], link: 'pnpm exec web-push generate-vapid-keys --json' },
  { name: 'BENCH_VAPID_SUBJECT', section: 'banc', desc: 'Contact push du banc', envs: [P], vps: ['bench'], rec: { prod: 'mailto:support@raijinshield.com' } },
  ...[
    ['BENCH_JOBS_ENABLED', 'Jobs programmés du banc (0 seulement pour un diagnostic)', '1'],
    ['BENCH_DB_ALLOCATED_BYTES', 'Espace alloué à la base du banc, en octets (vide = 2 Gio)', ''],
    ['BENCH_HELIUS_RPC_RPS', 'Débit RPC Helius du banc (max 3)', '3'],
    ['BENCH_HELIUS_DAS_RPS', 'Débit DAS Helius du banc (max 0.5)', '0.5'],
    ['BENCH_HELIUS_DAILY_CREDIT_BUDGET', 'Crédits Helius par jour du banc (max 10000)', '10000'],
    ['BENCH_WALLET_STUDY_DAILY_CREDITS', 'Part des crédits pour l’étude des premiers acheteurs (0 = coupée)', '2000'],
    ['BENCH_JUP_API_BASE', 'URL Jupiter du banc (vide = lite-api sans clé)', ''],
    ['BENCH_JUP_API_KEY', 'Clé Jupiter du banc (https://portal.jup.ag)', '', true],
    ['BENCH_MIN_MARKET_CAP', 'Filtre du scan : capitalisation minimale (USD)', '50000'],
    ['BENCH_MIN_LIQUIDITY', 'Filtre du scan : liquidité minimale (USD)', '10000'],
    ['BENCH_SCAN_KEYWORDS', 'Mots-clés DexScreener, séparés par des virgules', ''],
    ['BENCH_VERDICTS_PER_RUN', 'Verdicts mesurés par passage (max 20)', '6'],
    ['BENCH_MAIL_TRANSPORT', 'E-mails d’alerte du banc : none, resend ou smtp', 'none'],
    ['BENCH_MAIL_FROM', 'Expéditeur des e-mails du banc', ''],
    ['BENCH_ALERT_EMAIL', 'Destinataire des alertes (vide = BENCH_OWNER_EMAIL)', ''],
    ['BENCH_RESEND_API_KEY', 'Clé Resend propre au banc (https://resend.com/api-keys)', '', true],
    ['BENCH_SMTP_URL', 'smtp://utilisateur:motdepasse@hôte:587 (transport smtp)', '', true],
  ].map(([name, desc, def, secret]) => ({ name, section: 'banc', desc, def, secret: !!secret, advanced: true, envs: [P], vps: ['bench'] })),

  // ---------------------------------------------------------------- 12. Réglages avancés (API)
  adv('JOBS_ENABLED', 'Jobs programmés : réanalyses, alertes, purges (false en dev serveur)', 'true', { rec: { dev: 'false', prod: 'true' } }),
  adv('PUSH_PROVIDER', 'webpush (envoi réel) ou fake (tests)', '', { rec: { dev: 'webpush', prod: 'webpush' } }),
  adv('COOKIE_SECURE', 'Cookies Secure : false sur http://localhost, true en HTTPS', 'false', { rec: { local: 'false' }, imposed: true }),
  adv('COOKIE_DOMAIN', 'Laisser vide (cookies liés à l’hôte de l’API)', '', { imposed: true }),
  adv('TRUST_PROXY', 'Nombre de proxys devant l’API (vide sur ta machine)', '', { imposed: true }),
  adv('BULLMQ_PREFIX', 'Préfixe des files BullMQ dans Redis', 'raijin', { imposed: true }),
  adv('WEB_INDEX_HTML_PATH', 'index.html du build web pour les pages /t/<mint>', '', { imposed: true }),
  adv('ANALYSIS_FIXTURES', 'Sources simulées par des fixtures (0 ou 1, refusé en prod)', '0', { imposed: true }),
  adv('JOBS_TEST_TRIGGER', 'Déclenchement manuel des jobs pour les tests (0 ou 1)', '0', { imposed: true }),
  adv('ANALYSIS_FIXTURES_DIR', 'Dossier des fixtures rejouées'),
  adv('OG_FONTS_DIR', 'Dossier des polices de l’image Open Graph'),
  adv('SEED_USER_PASSWORD', 'Mot de passe du compte local dev@raijin.local (vide = généré)', '', { secret: true }),
  adv('SMTP_USER', 'Utilisateur SMTP (vide pour Mailpit)'),
  adv('SMTP_PASSWORD', 'Mot de passe SMTP (vide pour Mailpit)', '', { secret: true }),
  adv('MAIL_LOGO_URL', 'Logo PNG des e-mails (vide = APP_URL/icons/icon-192.png)'),
  adv('MAIL_ASSETS_BASE_URL', 'Base des images des e-mails (vide = APP_URL/email)'),
  adv('STRIPE_PUBLISHABLE_KEY', 'Clé publiable Stripe : non utilisée, laisser vide'),
  adv('STRIPE_PORTAL_CONFIGURATION_ID', 'Configuration « bpc_… » du portail client (vide = défaut)'),
  adv('PRO_PRICE_MONTHLY_CENTS', 'Prix mensuel affiché, en centimes TTC (= prix Stripe)', '1490'),
  adv('PRO_PRICE_YEARLY_CENTS', 'Prix annuel affiché, en centimes TTC (= prix Stripe)', '14900'),
  adv('BILLING_CURRENCY', 'Devise des prix (ISO 4217)', 'EUR'),
  adv('ANALYTICS_PROVIDER', 'google ou fake (vide = google si la clé JSON est fournie)'),
  adv('ANALYTICS_CACHE_TTL_S', 'Cache des réponses Google (s)', '3600'),
  adv('HELIUS_RPC_RPS', 'Débit RPC Helius de l’API (req/s)', '7'),
  adv('HELIUS_DAS_RPS', 'Débit DAS Helius de l’API (req/s)', '1.5'),
  adv('HELIUS_RPC_URL', 'URL de base Helius (la clé est ajoutée par le code)', 'https://mainnet.helius-rpc.com'),
  adv('SOLANA_RPC_URL', 'RPC public de repli sans clé', 'https://api.mainnet-beta.solana.com'),
  adv('SOLANA_RPC_RPS', 'Débit du RPC public (req/s)', '1'),
  adv('DEXSCREENER_API_URL', 'URL de l’API DexScreener', 'https://api.dexscreener.com'),
  adv('GECKOTERMINAL_API_URL', 'URL de l’API GeckoTerminal', 'https://api.geckoterminal.com/api/v2'),
  adv('JUPITER_API_URL', 'URL de l’API de devis Jupiter', 'https://lite-api.jup.ag/swap/v1'),
  adv('RUGCHECK_API_URL', 'URL de l’API RugCheck', 'https://api.rugcheck.xyz/v1'),
  adv('RATE_LIMIT_PER_MINUTE', 'Requêtes par minute et par IP, toutes routes', '120'),
  adv('RATE_LIMIT_AUTH_PER_MINUTE', 'Requêtes par minute sur /auth (vide = 10 en prod, 60 en dev)'),
  adv('RATE_LIMIT_ANALYSIS_PER_MINUTE', 'Analyses par minute et par IP (vide = 10 en prod, 60 en dev)'),
  adv('RATE_LIMIT_BILLING_PER_MINUTE', 'Sessions de paiement par minute (vide = 10)'),
  adv('RATE_LIMIT_WALLET_SCAN_PER_MINUTE', 'Scans de wallet par minute (vide = 5 en prod)'),
  adv('RATE_LIMIT_ADMIN_PER_MINUTE', 'Requêtes admin par minute et par compte', '60'),
  adv('JWT_ACCESS_TTL', 'Durée de la session courte', '15m'),
  adv('JWT_REFRESH_TTL', 'Durée de la session longue', '30d'),
  adv('EMAIL_VERIFY_TTL', 'Validité du lien de vérification d’e-mail', '24h'),
  adv('PASSWORD_RESET_TTL', 'Validité du lien de mot de passe oublié', '30m'),
  adv('MAGIC_LINK_TTL', 'Validité du lien de connexion', '15m'),
  adv('AUTH_LOCKOUT_THRESHOLD', 'Échecs de connexion avant blocage temporaire', '5'),
  adv('AUTH_LOCKOUT_DURATION', 'Durée du blocage temporaire', '15m'),
  adv('ANON_ANALYSIS_DAILY_LIMIT', 'Analyses par jour d’un visiteur anonyme', '3'),
  adv('FREE_ANALYSIS_DAILY_LIMIT', 'Analyses par jour du plan Gratuit', '5'),
  adv('TRIAL_ANALYSIS_DAILY_LIMIT', 'Analyses par jour de l’essai Pro', '50'),
  adv('ANALYSIS_FAILED_DAILY_LIMIT', 'Analyses en échec remboursées par jour', '20'),
  adv('ANALYSIS_UPSTREAM_FAILED_DAILY_LIMIT', 'Pannes de sources remboursées par jour', '10'),
  adv('ANALYSIS_CACHE_TTL_S', 'Cache d’un résultat d’analyse (s)', '60'),
  adv('ANALYSIS_CACHE_TTL_NO_KEY_S', 'Cache d’un résultat sans clé Helius (s)', '300'),
  adv('TRIAL_DAYS', 'Durée de l’essai Pro (jours)', '7'),
  adv('TRIAL_JOB_CRON', 'Job de fin d’essai (cron UTC)'),
  adv('TRIAL_EMAIL_HOUR', 'Heure d’envoi des e-mails d’essai (Paris)'),
  adv('TRIAL_FINGERPRINT_RETENTION_DAYS', 'Conservation des empreintes d’essai (jours)', '90'),
  adv('TRIAL_CLAIM_RETENTION_DAYS', 'Conservation des e-mails ayant eu un essai (jours)', '730'),
  adv('TRIAL_CONVERSION_WINDOW_DAYS', 'Fenêtre de conversion après l’essai (jours)'),
  adv('FREE_WATCH_LIMIT', 'Suivis actifs du plan Gratuit', '3'),
  adv('PRO_WATCH_LIMIT', 'Suivis actifs du Pro et de l’essai', '50'),
  adv('FREE_ALERT_HISTORY_DAYS', 'Historique d’alertes affiché, Gratuit (jours)'),
  adv('PRO_ALERT_HISTORY_DAYS', 'Historique d’alertes affiché, Pro (jours)'),
  adv('WATCH_TICK_SECONDS', 'Période du planificateur des réanalyses (s)'),
  adv('WATCH_FAST_INTERVAL_MIN', 'Passe rapide des suivis (min)'),
  adv('WATCH_HOLDERS_INTERVAL_MIN', 'Passe holders des suivis (min)'),
  adv('WATCH_FULL_INTERVAL_MIN', 'Passe complète des suivis (min)'),
  adv('ALERT_COOLDOWN_MINUTES', 'Délai minimal entre deux alertes identiques (min)'),
  adv('ALERT_EMAIL_BATCH_DELAY_S', 'Regroupement des alertes par e-mail (s)'),
  adv('ALERT_EMAIL_DAILY_MAX', 'E-mails d’alerte au plus par jour'),
  adv('RETENTION_DAYS', 'Rétention des analyses et événements (jours)', '90'),
  adv('PURGE_CRON', 'Heure de la purge quotidienne (cron UTC)'),
  adv('MAINTENANCE_MODE', 'Maintenance : 1 = tout répond 503 sauf /health', '0'),
  adv('WALLET_SCAN_DAILY_LIMIT_PRO', 'Scans de wallet par jour, Pro'),
  adv('WALLET_SCAN_DAILY_LIMIT_TRIAL', 'Scans de wallet par jour, essai Pro'),
  adv('WALLET_SCAN_MAX_TOKENS', 'Tokens analysés au plus par scan'),
  adv('WALLET_SCAN_MAX_TOKENS_NO_KEY', 'Tokens analysés au plus par scan, sans clé Helius'),
  adv('WALLET_SCAN_MAX_ACCOUNTS', 'Comptes de tokens au-delà desquels le scan est refusé'),
  adv('WALLET_SCAN_PRICE_LOOKUP_MAX', 'Prix demandés au plus par scan'),
  adv('WALLET_SCAN_DUST_USD', 'Seuil « poussière » (USD)'),
  adv('WALLET_SCAN_DEADLINE_MS', 'Échéance d’un scan (ms)'),
  adv('WALLET_SCAN_CACHE_TTL_S', 'Cache d’un scan de wallet (s)'),
  adv('WALLET_SCAN_CACHE_TTL_NO_KEY_S', 'Cache d’un scan sans clé Helius (s)'),
  adv('WALLET_TOKEN_VERDICT_TTL_S', 'Cache du verdict rapide par mint (s)'),
  adv('WALLET_REUSE_ANALYSIS_MAX_AGE_S', 'Âge maximal d’une analyse réutilisée (s)'),
  adv('ADMIN_SESSION_IDLE_MINUTES', 'Session admin : expiration sans activité (min)'),
  adv('ADMIN_SESSION_MAX_HOURS', 'Session admin : durée maximale (h)'),
  adv('ADMIN_TOTP_ISSUER', 'Nom affiché dans l’application d’authentification'),
  adv('ADMIN_TOTP_MAX_ATTEMPTS', 'Codes 2FA faux tolérés avant blocage'),
  adv('ADMIN_TOTP_LOCKOUT_MINUTES', 'Durée du blocage 2FA (min)'),
  adv('METRICS_CRON', 'Agrégats nocturnes (cron UTC, avant la purge)'),
  adv('ADMIN_ALERTS_CRON', 'Vérification des alertes admin (cron UTC)'),
  adv('ADMIN_ALERT_JOB_FAILURES', 'Échecs de job de suite avant alerte admin'),
  adv('ADMIN_ALERT_QUOTA_RATIO', 'Ratio de quota au-delà duquel alerter'),
  adv('JUPITER_DAILY_CALL_BUDGET', 'Plafond d’appels Jupiter par jour (vide = sans ratio)'),
  adv('RUGCHECK_DAILY_CALL_BUDGET', 'Plafond d’appels RugCheck par jour (vide = sans ratio)'),
  adv('AUDIT_LOG_RETENTION_DAYS', 'Conservation du journal d’audit (jours)'),
  // Radar (réglages fins, tous facultatifs)
  adv('RADAR_DISCOVER_SECONDS', 'Radar : période de découverte (s)', '120'),
  adv('RADAR_CHECK_SECONDS', 'Radar : période des contrôles (s)', '60'),
  adv('RADAR_CHECKS_PER_TICK', 'Radar : contrôles par passe', '4'),
  adv('RADAR_MAX_NEW_PER_HOUR', 'Radar : nouvelles entrées par heure', '60'),
  adv('RADAR_RECHECK_AFTER_MINUTES', 'Radar : recontrôles après découverte (min)', '60,360'),
  adv('RADAR_WINDOW_HOURS', 'Radar : fenêtre affichée (h)', '24'),
  adv('RADAR_REFRESH_MINUTES', 'Radar : rafraîchissement annoncé (min)', '5'),
  adv('RADAR_RUGCHECK_PER_MIN', 'Radar : rapports RugCheck par minute', '6'),
  adv('RADAR_RETENTION_DAYS', 'Radar : rétention des entrées (jours)', '7'),
  // Bot Telegram (réglages fins)
  adv('BOT_TRANSPORT', 'Bot : polling (ta machine), webhook (prod) ou fake', '', { vps: ['compose'] }),
  adv('BOT_WEBHOOK_URL', 'Bot : URL publique du webhook (prod)', '', { vps: ['compose'] }),
  adv('TELEGRAM_API_ROOT', 'Bot : racine de l’API Bot (vide = officielle)', '', { vps: ['compose'] }),
  adv('BOT_PORT', 'Bot : port d’écoute', '3300', { vps: ['compose'] }),
  adv('RAIJIN_API_INTERNAL_URL', 'Bot : URL de l’API vue par le bot', 'http://localhost:3100/api/v1', { vps: ['compose'] }),
  adv('BOT_REDIS_URL', 'Bot : Redis du bot', 'redis://localhost:6380/4', { vps: ['compose'] }),
  adv('BOT_BULLMQ_PREFIX', 'Bot : préfixe des files', 'raijin-bot', { vps: ['compose'] }),
  adv('BOT_GROUP_ANALYSES_PER_HOUR', 'Bot : analyses par heure et par groupe', '20', { vps: ['compose'] }),
  adv('BOT_ALERT_POLL_SECONDS', 'Bot : période de réclamation des alertes (s)', '10', { vps: ['compose'] }),
  adv('BOT_ALERT_WORKER', 'Bot : travailleur d’alertes (on ou off)', 'on', { vps: ['compose'] }),
  adv('BOT_UNLINKED_ANALYSES_PER_DAY', 'Bot : analyses par jour d’un compte non lié', '5'),
  adv('BOT_FREE_ALERT_DELAY_SECONDS', 'Bot : retard des alertes du plan Gratuit (s)', '600'),
  adv('BOT_RATE_LIMIT_PER_SUBJECT_PER_MINUTE', 'Bot : requêtes internes par minute et par utilisateur'),
];

/** Index par nom (contrôle des doublons du schéma au chargement). */
export function schemaIndex() {
  const byName = new Map();
  for (const v of VARIABLES) {
    if (byName.has(v.name))
      throw new Error(`schéma : ${v.name} défini deux fois`);
    if (!SECTIONS.some((s) => s.id === v.section))
      throw new Error(`schéma : section inconnue pour ${v.name}`);
    byName.set(v.name, v);
  }
  return byName;
}
