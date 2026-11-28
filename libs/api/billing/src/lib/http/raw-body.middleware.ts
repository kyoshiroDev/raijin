import { BILLING_ERROR_MESSAGES } from '@raijin/shared-contracts';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { raw } from 'express';

/** Chemin du webhook Stripe sous le préfixe global (`/api/v1`). */
export const BILLING_WEBHOOK_PATH = 'billing/webhook';
/** Corps maximal d'un webhook Stripe. */
export const WEBHOOK_BODY_LIMIT = '1mb';

/**
 * Corps **brut** (Buffer) pour le seul webhook Stripe : la signature porte sur les octets exacts reçus.
 * À monter avant le parseur JSON global (`setupApp`), qui ignore ensuite un corps déjà lu.
 * Corps trop gros ou illisible : 400 `BILLING_WEBHOOK_INVALID` au format `{code, message}`.
 */
export function billingWebhookRawBody(): RequestHandler {
  const parse = raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT });
  return (req: Request, res: Response, next: NextFunction) => {
    parse(req, res, (error?: unknown) => {
      if (error) {
        res
          .status(400)
          .set('Cache-Control', 'no-store')
          .json({ code: 'BILLING_WEBHOOK_INVALID', message: BILLING_ERROR_MESSAGES.BILLING_WEBHOOK_INVALID });
        return;
      }
      next();
    });
  };
}
