import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiException, ApiZodBody, AuthCookies, AuthThrottle, CsrfService, ZodValidationPipe } from '@raijin/api-core';
import {
  changePasswordRequestSchema,
  forgotPasswordRequestSchema,
  loginRequestSchema,
  magicLinkRequestSchema,
  magicLinkVerifyRequestSchema,
  registerRequestSchema,
  resendVerificationRequestSchema,
  resetPasswordRequestSchema,
  verifyEmailRequestSchema,
  type AuthSession,
  type ChangePasswordRequest,
  type CsrfResponse,
  type ForgotPasswordRequest,
  type LoginRequest,
  type MagicLinkRequest,
  type MagicLinkSession,
  type MagicLinkVerifyRequest,
  type MessageResponse,
  type RegisterRequest,
  type ResendVerificationRequest,
  type ResetPasswordRequest,
  type SessionState,
  type VerifyEmailRequest,
} from '@raijin/shared-contracts';
import type { Request, Response } from 'express';
import { AccessTokenService } from '../services/access-token.service';
import { AuthService, type IssuedSession } from '../services/auth.service';
import { Client, type ClientInfo } from '../services/client-info';
import { toPublicUser } from '../services/public-user';
import { AuthGuard, CurrentAuth, OptionalAuth, OptionalAuthGuard, type AuthContext } from './auth.guard';

/** Routes d'authentification `/api/v1/auth/*` (docs/PROGRESS.md, phase 2). */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookies: AuthCookies,
    private readonly csrf: CsrfService,
    private readonly accessTokens: AccessTokenService,
  ) {}

  @Get('csrf')
  @ApiOperation({ summary: 'Pose le cookie CSRF et renvoie le jeton à garder en mémoire' })
  csrfToken(@Req() req: Request, @Res({ passthrough: true }) res: Response): CsrfResponse {
    // Lié au sid de l'access token signé, même expiré : la garde CSRF exige ce lien dès qu'un
    // sid est présent (flux front : auth/csrf puis auth/refresh après expiration de l'access).
    const sessionId = this.accessTokens.readSessionId(req);
    const csrfToken = this.csrf.issue(sessionId);
    this.cookies.setCsrf(res, csrfToken);
    return { csrfToken };
  }

  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  @AuthThrottle()
  @ApiZodBody(registerRequestSchema)
  async register(
    @Body(new ZodValidationPipe(registerRequestSchema)) body: RegisterRequest,
    @Client() client: ClientInfo,
  ): Promise<MessageResponse> {
    return { message: await this.auth.register(body, client) };
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @AuthThrottle()
  @ApiZodBody(verifyEmailRequestSchema)
  async verifyEmail(
    @Body(new ZodValidationPipe(verifyEmailRequestSchema)) body: VerifyEmailRequest,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSession> {
    return this.respond(res, await this.auth.verifyEmail(body.token, client));
  }

  @Post('verify-email/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @AuthThrottle()
  @ApiZodBody(resendVerificationRequestSchema)
  async resendVerification(
    @Body(new ZodValidationPipe(resendVerificationRequestSchema)) body: ResendVerificationRequest,
    @Req() req: Request,
    @Client() client: ClientInfo,
  ): Promise<MessageResponse> {
    const userId = this.accessTokens.fromRequest(req)?.sub ?? null;
    return { message: await this.auth.resendVerification(userId, body.email, client) };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @AuthThrottle()
  @ApiZodBody(loginRequestSchema)
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSession> {
    return this.respond(res, await this.auth.login(body, client));
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotation du refresh token (cookie) : nouvelle paire de cookies' })
  async refresh(
    @Req() req: Request,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSession> {
    try {
      const presented = this.cookies.readRefresh(req);
      // Nom de refresh répété dans l'en-tête Cookie : injection probable (sous-domaine), on refuse.
      if (presented.kind === 'duplicate') throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
      // Le refresh doit appartenir à la session de l'access token signé (même expiré) s'il y en a un.
      const sessionId = this.accessTokens.readSessionId(req);
      if (presented.kind === 'token' && presented.legacy && !sessionId) {
        // Ancien `__Secure-rj_rt` (déposable avec Domain) : accepté une dernière fois, seulement lié à un access.
        throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
      }
      const token = presented.kind === 'token' ? presented.token : null;
      // `respond` pose le nouveau `__Host-rj_rt` et efface l'ancien nom / ancien chemin.
      return this.respond(res, await this.auth.refresh(token, client, sessionId));
    } catch (error) {
      // 409 (refresh concurrent dans la fenêtre de grâce) : les cookies déjà tournés restent valables.
      if (!(error instanceof ApiException && error.code === 'CONFLICT')) this.cookies.clearSession(res);
      throw error;
    } finally {
      // Ancien `__Secure-rj_rt` (le nôtre ou injecté avec Domain=) : effacé partout, quelle que soit l'issue.
      if (this.cookies.hasLegacyRefresh(req)) this.cookies.clearLegacyRefreshEverywhere(res);
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() req: Request,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(this.accessTokens.readSessionId(req), this.presentedRefresh(req), client);
    this.cookies.clearSession(res);
    if (this.cookies.hasLegacyRefresh(req)) this.cookies.clearLegacyRefreshEverywhere(res);
    // Nouveau jeton CSRF anonyme : le front peut enchaîner sur une nouvelle connexion.
    this.cookies.setCsrf(res, this.csrf.issue(null));
  }

  /**
   * État de session (`SessionState`) :
   * - aucun cookie de session (ni access ni refresh) : 200 `{ authenticated: false }`, sans 401 ;
   * - cookie de refresh seul (access expiré et effacé) : 401 `AUTH_SESSION_EXPIRED` → le front rafraîchit ;
   *   seuls comptent `__Host-rj_rt`, ou l'ancien `__Secure-rj_rt` accompagné d'un sid signé : un ancien
   *   cookie seul (peut-être injecté par un sous-domaine) est effacé et la réponse reste anonyme ;
   * - cookie d'access invalide, expiré ou session révoquée : 401 `AUTH_SESSION_EXPIRED` (garde) ;
   * - session valide : `{ authenticated: true, ...AuthSession }`.
   */
  @Get('session')
  @UseGuards(OptionalAuthGuard)
  async session(
    @OptionalAuth() auth: AuthContext | null,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionState> {
    if (!auth) {
      if (this.refreshWorthTrying(req)) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
      if (this.cookies.hasLegacyRefresh(req)) this.cookies.clearLegacyRefreshEverywhere(res);
      return { authenticated: false };
    }
    const user = await this.auth.currentUser(auth.userId);
    const csrfToken = this.csrf.issue(auth.sessionId);
    this.cookies.setCsrf(res, csrfToken);
    return {
      authenticated: true,
      user: toPublicUser(user),
      accessTokenExpiresAt: auth.accessTokenExpiresAt.toISOString(),
      csrfToken,
    };
  }

  @Post('magic-link')
  @HttpCode(HttpStatus.ACCEPTED)
  @AuthThrottle()
  @ApiZodBody(magicLinkRequestSchema)
  async magicLink(
    @Body(new ZodValidationPipe(magicLinkRequestSchema)) body: MagicLinkRequest,
    @Client() client: ClientInfo,
  ): Promise<MessageResponse> {
    return { message: await this.auth.requestMagicLink(body, client) };
  }

  @Post('magic-link/verify')
  @HttpCode(HttpStatus.OK)
  @AuthThrottle()
  @ApiZodBody(magicLinkVerifyRequestSchema)
  async magicLinkVerify(
    @Body(new ZodValidationPipe(magicLinkVerifyRequestSchema)) body: MagicLinkVerifyRequest,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MagicLinkSession> {
    const issued = await this.auth.verifyMagicLink(body.token, client);
    return { ...this.respond(res, issued), redirectPath: issued.redirectPath };
  }

  @Post('password/forgot')
  @HttpCode(HttpStatus.ACCEPTED)
  @AuthThrottle()
  @ApiZodBody(forgotPasswordRequestSchema)
  async forgotPassword(
    @Body(new ZodValidationPipe(forgotPasswordRequestSchema)) body: ForgotPasswordRequest,
    @Client() client: ClientInfo,
  ): Promise<MessageResponse> {
    return { message: await this.auth.forgotPassword(body.email, client) };
  }

  @Post('password/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AuthThrottle()
  @ApiZodBody(resetPasswordRequestSchema)
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordRequestSchema)) body: ResetPasswordRequest,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.resetPassword(body.token, body.password, client);
    this.cookies.clearSession(res);
  }

  @Post('password/change')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthGuard)
  @AuthThrottle()
  @ApiZodBody(changePasswordRequestSchema)
  async changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(changePasswordRequestSchema)) body: ChangePasswordRequest,
    @Client() client: ClientInfo,
  ): Promise<void> {
    await this.auth.changePassword(auth.userId, auth.sessionId, body, client);
  }

  /**
   * Un refresh vaut-il la peine d'être tenté (état de session) ? `__Host-rj_rt` unique, ou ancien
   * `__Secure-rj_rt` / nom répété seulement avec un sid signé (même expiré) : sinon le front tournerait
   * en boucle (session → 401 → refresh refusé) sur un cookie injecté.
   */
  private refreshWorthTrying(req: Request): boolean {
    const presented = this.cookies.readRefresh(req);
    if (presented.kind === 'none') return false;
    if (presented.kind === 'token' && !presented.legacy) return true;
    return this.accessTokens.readSessionId(req) !== null;
  }

  /** Refresh unique de la requête (nouveau nom, sinon ancien) ; `null` s'il manque ou s'il est répété. */
  private presentedRefresh(req: Request): string | null {
    const presented = this.cookies.readRefresh(req);
    return presented.kind === 'token' ? presented.token : null;
  }

  /** Pose les cookies httpOnly et renvoie la session publique (aucun jeton hormis le CSRF). */
  private respond(res: Response, issued: IssuedSession): AuthSession {
    this.cookies.setSession(res, issued.accessToken, issued.refreshToken);
    const csrfToken = this.csrf.issue(issued.sessionId);
    this.cookies.setCsrf(res, csrfToken);
    return {
      user: toPublicUser(issued.user),
      accessTokenExpiresAt: issued.accessTokenExpiresAt.toISOString(),
      csrfToken,
    };
  }
}
