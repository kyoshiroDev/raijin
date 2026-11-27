import { BENCH_API_PREFIX, BENCH_ROUTES } from '@raijin/bench-contracts';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { BENCH_ERROR_MESSAGES } from './bench-exception';

/**
 * En-tête secret posé par Traefik sur chaque requête qu'il relaie vers le banc (docs/SECURITY.md §17, option B
 * du réseau du dev) : une requête qui arrive sans lui ne vient pas de Traefik (conteneur voisin sur le réseau
 * partagé) et ne doit ni atteindre l'API ni faire croire à une IP cliente via `X-Forwarded-For`.
 */
export const EDGE_HEADER = 'x-raijin-edge';

/** Seule route accessible sans l'en-tête : la sonde du conteneur (`GET`/`HEAD /api/health`). */
export const EDGE_EXEMPT_PATH = `${BENCH_API_PREFIX}/${BENCH_ROUTES.health}`;

/** En-têtes de proxy ignorés (supprimés) quand l'en-tête secret est absent ou faux. */
const FORWARDED_HEADERS = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'forwarded', 'x-real-ip'] as const;

/** Corps neutre du refus : identique au 403 générique du banc, ne révèle pas l'existence du contrôle. */
const FORBIDDEN_BODY = JSON.stringify({ code: 'UNAUTHORIZED', message: BENCH_ERROR_MESSAGES.UNAUTHORIZED });

/** Empreinte SHA-256 du secret (seule forme gardée en mémoire par la configuration). */
export function edgeSecretDigest(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** Vrai si la valeur reçue correspond au secret (comparaison à temps constant sur les empreintes, longueur fixe). */
export function isValidEdgeHeader(value: unknown, expectedDigest: Buffer): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  return timingSafeEqual(edgeSecretDigest(value), expectedDigest);
}

/**
 * Middleware Express, à monter avant tout ce qui lit `req.ip` (throttler, verrous de connexion).
 * - `expectedDigest` nul (variable absente) : contrôle désactivé, comportement inchangé ;
 * - sinon : en-tête valide → requête relayée (`trust proxy` s'applique) ; en-tête absent ou faux → en-têtes de
 *   proxy supprimés (IP de la socket), puis 403 neutre sauf pour la santé.
 * L'en-tête est toujours retiré de la requête après contrôle (jamais journalisé, jamais renvoyé).
 */
export function createEdgeGuard(expectedDigest: Buffer | null): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (expectedDigest === null) {
      delete req.headers[EDGE_HEADER];
      next();
      return;
    }
    const valid = isValidEdgeHeader(req.headers[EDGE_HEADER], expectedDigest);
    delete req.headers[EDGE_HEADER];
    if (valid) {
      next();
      return;
    }
    for (const name of FORWARDED_HEADERS) delete req.headers[name];
    if ((req.method === 'GET' || req.method === 'HEAD') && req.path === EDGE_EXEMPT_PATH) {
      next();
      return;
    }
    res.status(403).set('Cache-Control', 'no-store').type('application/json').send(FORBIDDEN_BODY);
  };
}
