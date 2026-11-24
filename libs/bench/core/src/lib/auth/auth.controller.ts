import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import { BENCH_ROUTES, benchLoginRequestSchema, type BenchLoginRequest, type BenchSession } from '@raijin/bench-contracts';
import type { Request, Response } from 'express';
import { BENCH_CLOCK, type BenchClock } from '../config/tokens';
import { BenchLoginThrottle, BenchPublic, BenchSkipCsrf } from '../http/decorators';
import { BenchZodPipe } from '../http/zod.pipe';
import { BenchAuthService } from './auth.service';
import { BenchCookies } from './cookies';
import { BenchCsrfService } from './csrf';
import { CurrentBenchSession, type BenchRequestSession } from './session';

/**
 * Connexion du propriétaire (`POST /api/auth/login`), session courante, déconnexion. Aucune route
 * d'inscription, de mot de passe oublié ni de réinitialisation : tout passe par la CLI du conteneur.
 */
@Controller()
export class BenchAuthController {
  constructor(
    private readonly auth: BenchAuthService,
    private readonly cookies: BenchCookies,
    private readonly csrf: BenchCsrfService,
    @Inject(BENCH_CLOCK) private readonly clock: BenchClock,
  ) {}

  private setCookies(res: Response, session: BenchRequestSession): void {
    const maxAge = session.expiresAt.getTime() - this.clock().getTime();
    this.cookies.setSession(res, session.token, maxAge);
    this.cookies.setCsrf(res, this.csrf.issue(session.sessionId), maxAge);
  }

  /** Public, limité à 10/min par IP ; `Origin` contrôlé, pas de double-submit (aucune session avant). */
  @Post(BENCH_ROUTES.authLogin)
  @BenchPublic()
  @BenchSkipCsrf()
  @BenchLoginThrottle()
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new BenchZodPipe(benchLoginRequestSchema)) body: BenchLoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BenchSession> {
    const userAgent = req.headers['user-agent'];
    const result = await this.auth.login(body, { ip: req.ip ?? null, userAgent: typeof userAgent === 'string' ? userAgent : null });
    this.setCookies(res, result.session);
    return result.body;
  }

  /** Session courante ; repose un jeton CSRF si le cookie manque ou ne correspond plus. */
  @Get(BENCH_ROUTES.authSession)
  session(@CurrentBenchSession() session: BenchRequestSession, @Req() req: Request, @Res({ passthrough: true }) res: Response): BenchSession {
    const current = this.cookies.read(req, 'csrf');
    if (!current || !this.csrf.verify(current, session.sessionId)) {
      this.cookies.setCsrf(res, this.csrf.issue(session.sessionId), session.expiresAt.getTime() - this.clock().getTime());
    }
    return this.auth.describe(session);
  }

  @Post(BENCH_ROUTES.authLogout)
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@CurrentBenchSession() session: BenchRequestSession, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(session);
    this.cookies.clear(res);
  }
}
