/**
 * Chemins de l'espace admin côté front (feature `web-feature-admin`, route lazy `/admin`).
 * Les écrans de sécurité (`/admin/securite/*`) s'affichent hors de la coque admin.
 */
export const ADMIN_PATHS = {
  root: '/admin',
  security: '/admin/securite',
  enrollment: '/admin/securite/activation',
  verify: '/admin/securite/code',
  recoveryCodes: '/admin/securite/codes-de-secours',
  /** État de la 2FA et régénération des codes de secours (dans la coque). */
  accountSecurity: '/admin/double-authentification',
} as const;

/**
 * URL sans route : la navigation (sans changer la barre d'adresse) tombe sur la page 404 standard de l'app.
 * Utilisée quand l'API répond 404 sur l'espace admin (compte non admin : l'espace reste invisible).
 */
export const ADMIN_NOT_FOUND_URL = '/introuvable';

/** Valeur du paramètre `motif` de l'écran de saisie du code après une expiration de session. */
export const ADMIN_EXPIRED_REASON = 'expiree';

/** Vrai si le chemin est un écran de sécurité admin (activation, code, codes de secours). */
export function isAdminSecurityPath(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0] ?? '';
  return path === ADMIN_PATHS.security || path.startsWith(`${ADMIN_PATHS.security}/`);
}

/**
 * Retour après la saisie du code : uniquement un écran de la coque admin (jamais une autre origine,
 * jamais un écran de sécurité, pour éviter les boucles). Sinon, la vue d'ensemble.
 */
export function safeAdminReturn(url: string | null | undefined): string {
  if (!url || url.length > 512) return ADMIN_PATHS.root;
  if (!url.startsWith(ADMIN_PATHS.root)) return ADMIN_PATHS.root;
  const next = url.charAt(ADMIN_PATHS.root.length);
  if (next !== '' && next !== '/' && next !== '?') return ADMIN_PATHS.root;
  if (url.includes('//') || url.includes('\\') || isAdminSecurityPath(url)) return ADMIN_PATHS.root;
  return url;
}

/** Vrai si l'URL vise une route `admin/*` de l'API Raijin. */
export function isAdminApiUrl(url: string, base: string): boolean {
  const root = base.endsWith('/') ? base.slice(0, -1) : base;
  return url.startsWith(`${root}/admin/`) || url === `${root}/admin`;
}
