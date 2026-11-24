import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Session du propriétaire validée par `BenchSessionGuard`, attachée à la requête. */
export interface BenchRequestSession {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly email: string;
  readonly expiresAt: Date;
  /** Jeton brut du cookie (revalidation du flux SSE), jamais journalisé. */
  readonly token: string;
}

const SESSION_KEY = Symbol('benchSession');

export function attachBenchSession(req: Request, session: BenchRequestSession): void {
  (req as unknown as Record<symbol, unknown>)[SESSION_KEY] = session;
}

export function benchSessionOf(req: Request): BenchRequestSession | null {
  const value = (req as unknown as Record<symbol, unknown>)[SESSION_KEY];
  return (value as BenchRequestSession | undefined) ?? null;
}

/** Paramètre de contrôleur : session courante (toujours présente derrière la garde). */
export const CurrentBenchSession = createParamDecorator((_data: unknown, context: ExecutionContext): BenchRequestSession | null =>
  benchSessionOf(context.switchToHttp().getRequest<Request>()),
);
