import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Contexte client d'une requête (IP réelle selon `trust proxy`, user-agent borné). */
export interface ClientInfo {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export function clientInfoFromRequest(req: Request): ClientInfo {
  const userAgent = req.headers['user-agent'];
  return {
    ip: req.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 256) : null,
  };
}

/** `@Client() client: ClientInfo` */
export const Client = createParamDecorator((_data: unknown, context: ExecutionContext): ClientInfo =>
  clientInfoFromRequest(context.switchToHttp().getRequest<Request>()),
);
