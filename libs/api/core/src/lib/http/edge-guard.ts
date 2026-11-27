import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { defaultMessage } from '../errors/api-exception';

/**
 * En-tête secret posé par Traefik (`customRequestHeaders`) sur chaque requête qu'il relaie vers l'API
 * (docs/SECURITY.md §17, option B du réseau du dev). Valeur : `EDGE_SHARED_SECRET`. Jamais journalisé ni renvoyé :
 * il est retiré de la requête dès sa vérification.
 */
export const EDGE_HEADER = 'X-Raijin-Edge';

/** Préfixe global de l'API (dupliqué de `GLOBAL_PREFIX` pour éviter un import circulaire avec setup-app). */
const PREFIX = '/api/v1';

/**
 * Routes exemptées (sans en-tête valide, elles restent servies, mais l'IP est toujours celle de la socket) :
 * - `/api/v1/health` et `/api/v1/health/…` : healthcheck Docker (`fetch http://127.0.0.1:3000/api/v1/health`,
 *   infra/docker/Dockerfile) et healthcheck du load balancer Traefik (`loadbalancer.healthcheck.path`), qui
 *   n'appliquent pas les middlewares Traefik ; aucune donnée sensible ;
 * - `/api/v1/internal/bot/…` : appels internes du bot Telegram (réseau Docker interne, sans Traefik), protégés par
 *   leur propre jeton de service. Exemption **par préfixe**, indépendante de l'existence de ces routes.
 * Comparaison insensible à la casse (le routeur Express l'est aussi), sur le chemin brut (sans requête).
 */
export const EDGE_EXEMPT_EXACT: readonly string[] = [`${PREFIX}/health`, `${PREFIX}/internal/bot`];
export const EDGE_EXEMPT_PREFIXES: readonly string[] = [`${PREFIX}/health/`, `${PREFIX}/internal/bot/`];

/** En-têtes de transfert ignorés (supprimés) quand l'en-tête secret est absent ou faux. */
const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'forwarded'];

const EDGE_HEADER_LOWER = EDGE_HEADER.toLowerCase();

export function isEdgeExempt(path: string): boolean {
  const value = path.toLowerCase();
  return EDGE_EXEMPT_EXACT.includes(value) || EDGE_EXEMPT_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Comparaison à temps constant sur les hachages SHA-256 (longueur fixe, aucune fuite sur la longueur). */
export function edgeHeaderMatches(received: unknown, expectedDigest: Buffer): boolean {
  // Une valeur répétée arrive jointe par « , » (en-tête personnalisé) : elle ne correspond donc jamais.
  if (typeof received !== 'string' || received.length === 0 || received.length > 512) return false;
  return timingSafeEqual(digest(received), expectedDigest);
}

/** Retire l'en-tête secret de la requête (objet `headers` et `rawHeaders`) : rien en aval ne peut le lire. */
function scrubEdgeHeader(req: Request): void {
  delete req.headers[EDGE_HEADER_LOWER];
  const raw = req.rawHeaders;
  if (Array.isArray(raw) && raw.some((entry, index) => index % 2 === 0 && entry.toLowerCase() === EDGE_HEADER_LOWER)) {
    const kept: string[] = [];
    for (let index = 0; index + 1 < raw.length; index += 2) {
      const name = raw[index] ?? '';
      if (name.toLowerCase() !== EDGE_HEADER_LOWER) kept.push(name, raw[index + 1] ?? '');
    }
    req.rawHeaders = kept;
  }
}

/**
 * Exige l'en-tête `X-Raijin-Edge` quand `EDGE_SHARED_SECRET` est défini (`secret` non nul) :
 * - en-tête valide : la requête continue ; `trust proxy` s'applique (IP réelle prise dans `X-Forwarded-For` de Traefik) ;
 * - en-tête absent ou faux : les en-têtes de transfert sont supprimés (IP = adresse de la socket pour le rate limiting,
 *   le verrouillage, le plafond de l'espace admin, l'empreinte anonyme), puis 403 `FORBIDDEN` neutre, sauf routes exemptées.
 * `secret` nul : fonctionnalité désactivée (local, tests, dev), comportement inchangé.
 * À monter **avant** tout autre middleware (parseurs de corps compris).
 */
export function edgeGuardMiddleware(secret: string | null): RequestHandler {
  const expected = secret ? digest(secret) : null;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!expected) {
      scrubEdgeHeader(req);
      next();
      return;
    }
    const valid = edgeHeaderMatches(req.headers[EDGE_HEADER_LOWER], expected);
    scrubEdgeHeader(req);
    if (valid) {
      next();
      return;
    }
    for (const name of FORWARDING_HEADERS) delete req.headers[name];
    if (isEdgeExempt(req.path)) {
      next();
      return;
    }
    res
      .status(403)
      .set('Cache-Control', 'no-store')
      .json({ code: 'FORBIDDEN', message: defaultMessage('FORBIDDEN') });
  };
}
