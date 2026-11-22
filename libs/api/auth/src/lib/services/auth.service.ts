import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, ApiException, type AppConfig } from '@raijin/api-core';
import { AuthMailService } from '@raijin/api-notifications';
import { Prisma, PrismaService, type User } from '@raijin/api-prisma';
import type {
  ChangePasswordRequest,
  LoginRequest,
  MagicLinkRequest,
  RegisterRequest,
} from '@raijin/shared-contracts';
import { AccessTokenService } from './access-token.service';
import { AuditService } from './audit.service';
import { AuthTokenService } from './auth-token.service';
import type { ClientInfo } from './client-info';
import { normalizeEmail } from './email-normalizer';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

/** Messages neutres (202) : identiques que le compte existe ou non. */
export const NEUTRAL_MESSAGES = {
  register: 'Vérifie ta boîte mail : un e-mail t’attend pour confirmer ton adresse.',
  resend: 'Si un compte attend une confirmation à cette adresse, un nouvel e-mail vient de partir.',
  magicLink: 'Si un compte existe à cette adresse, un lien de connexion vient de partir.',
  forgot: 'Si un compte existe à cette adresse, un lien de réinitialisation vient de partir.',
} as const;

/** Session émise : jetons destinés aux cookies httpOnly (jamais au corps de la réponse). */
export interface IssuedSession {
  readonly user: User;
  readonly sessionId: string;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
}

/** Cas d'usage d'authentification (PROMPT.md §4.4, docs/ARCHITECTURE.md §8.4). */
@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly tokens: AuthTokenService,
    private readonly accessTokens: AccessTokenService,
    private readonly mail: AuthMailService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // -------------------------------------------------------------------------
  // Inscription et vérification d'e-mail
  // -------------------------------------------------------------------------

  /** Inscription neutre : même réponse et même coût que l'adresse soit libre ou non. */
  async register(input: RegisterRequest, client: ClientInfo): Promise<string> {
    if (this.passwords.isRejected(input.password, input.email)) {
      throw ApiException.auth('AUTH_PASSWORD_REJECTED', HttpStatus.BAD_REQUEST);
    }
    const emailNormalized = normalizeEmail(input.email);
    const passwordHash = await this.passwords.hash(input.password);
    const existing = await this.prisma.user.findUnique({ where: { emailNormalized } });
    if (existing) {
      await this.notifyExistingAccount(existing, client);
      return NEUTRAL_MESSAGES.register;
    }

    const attribution = input.attribution ?? {};
    let user: User;
    try {
      user = await this.prisma.user.create({
        data: {
          email: input.email,
          emailNormalized,
          passwordHash,
          termsAcceptedAt: new Date(),
          utmSource: attribution.utmSource ?? null,
          utmMedium: attribution.utmMedium ?? null,
          utmCampaign: attribution.utmCampaign ?? null,
          referrer: attribution.referrer ?? null,
          landingPath: attribution.landingPath ?? null,
        },
      });
    } catch (error) {
      // Course entre deux inscriptions de la même adresse : réponse neutre.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return NEUTRAL_MESSAGES.register;
      }
      throw error;
    }

    const token = await this.tokens.issue(user.id, 'EMAIL_VERIFY', this.config.auth.emailVerifyTtlMs);
    this.dispatch('vérification', this.mail.sendEmailVerification(user.email, token));
    await this.prisma.productEvent.create({ data: { userId: user.id, type: 'signup' } });
    await this.audit.record('auth.register', user.id, client);
    return NEUTRAL_MESSAGES.register;
  }

  private async notifyExistingAccount(user: User, client: ClientInfo): Promise<void> {
    if (user.emailVerifiedAt) {
      this.dispatch('compte existant', this.mail.sendAccountExists(user.email));
    } else {
      const token = await this.tokens.issue(user.id, 'EMAIL_VERIFY', this.config.auth.emailVerifyTtlMs);
      this.dispatch('vérification', this.mail.sendEmailVerification(user.email, token));
    }
    await this.audit.record('auth.register_existing', user.id, client);
  }

  /** Vérifie l'e-mail (jeton à usage unique) et ouvre une session. */
  async verifyEmail(token: string, client: ClientInfo): Promise<IssuedSession> {
    const record = await this.tokens.consume(token, 'EMAIL_VERIFY');
    if (!record) throw ApiException.auth('AUTH_TOKEN_INVALID', HttpStatus.BAD_REQUEST);
    const user = await this.markEmailVerified(record.userId, client);
    await this.tokens.revokeUnused(user.id, ['EMAIL_VERIFY']);
    return this.startSession(user, client);
  }

  /** Renvoi de l'e-mail de vérification (session ou adresse fournie), réponse neutre. */
  async resendVerification(sessionUserId: string | null, email: string | undefined): Promise<string> {
    const user = sessionUserId
      ? await this.prisma.user.findUnique({ where: { id: sessionUserId } })
      : email
        ? await this.prisma.user.findUnique({ where: { emailNormalized: normalizeEmail(email) } })
        : null;
    if (user && !user.emailVerifiedAt) {
      const token = await this.tokens.issue(user.id, 'EMAIL_VERIFY', this.config.auth.emailVerifyTtlMs);
      this.dispatch('vérification', this.mail.sendEmailVerification(user.email, token));
    }
    return NEUTRAL_MESSAGES.resend;
  }

  /** Marque l'e-mail vérifié (une seule fois) et envoie l'e-mail de bienvenue. */
  private async markEmailVerified(userId: string, client: ClientInfo): Promise<User> {
    const now = new Date();
    const updated = await this.prisma.user.updateMany({
      where: { id: userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: now },
    });
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw ApiException.auth('AUTH_TOKEN_INVALID', HttpStatus.BAD_REQUEST);
    if (updated.count === 1) {
      // L'essai Pro (phase 6) démarrera ici ; pour l'instant seul l'événement est enregistré.
      this.dispatch('bienvenue', this.mail.sendWelcome(user.email, user.trialEndsAt));
      await this.prisma.productEvent.create({ data: { userId, type: 'email_verified' } });
      await this.audit.record('auth.email_verified', userId, client);
    }
    return user;
  }

  // -------------------------------------------------------------------------
  // Connexion, sessions
  // -------------------------------------------------------------------------

  async login(input: LoginRequest, client: ClientInfo): Promise<IssuedSession> {
    const user = await this.prisma.user.findUnique({
      where: { emailNormalized: normalizeEmail(input.email) },
    });
    if (!user) {
      await this.passwords.verifyDummy(input.password);
      throw invalidCredentials(HttpStatus.UNAUTHORIZED);
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw ApiException.auth('AUTH_ACCOUNT_LOCKED', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (!(await this.passwords.verify(user.passwordHash, input.password))) {
      await this.registerFailedLogin(user, client);
      throw invalidCredentials(HttpStatus.UNAUTHORIZED);
    }
    const fresh = await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await this.audit.record('auth.login', user.id, client, { method: 'password' });
    return this.startSession(fresh, client);
  }

  private async registerFailedLogin(user: User, client: ClientInfo): Promise<void> {
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    if (updated.failedLoginCount >= this.config.auth.lockoutThreshold) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + this.config.auth.lockoutMs) },
      });
      await this.audit.record('auth.account_locked', user.id, client);
    } else {
      await this.audit.record('auth.login_failed', user.id, client);
    }
  }

  /** Rotation du refresh (cookie) : nouvelle paire de jetons, même session. */
  async refresh(rawRefreshToken: string | null, client: ClientInfo): Promise<IssuedSession> {
    if (!rawRefreshToken) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    const { session, refreshToken } = await this.sessions.rotate(rawRefreshToken, client);
    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    return this.issue(user, session.id, refreshToken);
  }

  /** Déconnexion idempotente : révoque la session identifiée par l'access token ou le refresh. */
  async logout(sessionId: string | null, rawRefreshToken: string | null, client: ClientInfo): Promise<void> {
    const sid = sessionId ?? (rawRefreshToken ? await this.sessions.sessionIdForRefresh(rawRefreshToken) : null);
    if (!sid) return;
    await this.sessions.revoke(sid, 'logout');
    const session = await this.prisma.session.findUnique({ where: { id: sid }, select: { userId: true } });
    await this.audit.record('auth.logout', session?.userId ?? null, client);
  }

  /** Utilisateur de la session courante (GET /auth/session). */
  async currentUser(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    return user;
  }

  // -------------------------------------------------------------------------
  // Lien magique
  // -------------------------------------------------------------------------

  async requestMagicLink(input: MagicLinkRequest, client: ClientInfo): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { emailNormalized: normalizeEmail(input.email) },
    });
    if (user) {
      const token = await this.tokens.issue(
        user.id,
        'MAGIC_LINK',
        this.config.auth.magicLinkTtlMs,
        input.redirectPath ?? null,
      );
      this.dispatch('lien magique', this.mail.sendMagicLink(user.email, token));
      await this.audit.record('auth.magic_link_requested', user.id, client);
    }
    return NEUTRAL_MESSAGES.magicLink;
  }

  async verifyMagicLink(
    token: string,
    client: ClientInfo,
  ): Promise<IssuedSession & { redirectPath: string | null }> {
    const record = await this.tokens.consume(token, 'MAGIC_LINK');
    if (!record) throw ApiException.auth('AUTH_TOKEN_INVALID', HttpStatus.BAD_REQUEST);
    // Le lien prouve la possession de la boîte : l'adresse est vérifiée du même coup.
    const user = await this.markEmailVerified(record.userId, client);
    const fresh = await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await this.audit.record('auth.login', user.id, client, { method: 'magic_link' });
    const issued = await this.startSession(fresh, client);
    return { ...issued, redirectPath: record.redirectPath };
  }

  // -------------------------------------------------------------------------
  // Mots de passe
  // -------------------------------------------------------------------------

  async forgotPassword(email: string, client: ClientInfo): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { emailNormalized: normalizeEmail(email) } });
    if (user) {
      const token = await this.tokens.issue(user.id, 'PASSWORD_RESET', this.config.auth.passwordResetTtlMs);
      this.dispatch('réinitialisation', this.mail.sendPasswordReset(user.email, token));
      await this.audit.record('auth.password_reset_requested', user.id, client);
    }
    return NEUTRAL_MESSAGES.forgot;
  }

  /** Réinitialisation par jeton : nouveau mot de passe, toutes les sessions révoquées. */
  async resetPassword(token: string, password: string, client: ClientInfo): Promise<void> {
    const record = await this.tokens.consume(token, 'PASSWORD_RESET');
    if (!record) throw ApiException.auth('AUTH_TOKEN_INVALID', HttpStatus.BAD_REQUEST);
    const user = await this.prisma.user.findUnique({ where: { id: record.userId } });
    if (!user) throw ApiException.auth('AUTH_TOKEN_INVALID', HttpStatus.BAD_REQUEST);
    if (this.passwords.isRejected(password, user.email)) {
      throw ApiException.auth('AUTH_PASSWORD_REJECTED', HttpStatus.BAD_REQUEST);
    }
    const now = new Date();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await this.passwords.hash(password),
        passwordChangedAt: now,
        failedLoginCount: 0,
        lockedUntil: null,
        emailVerifiedAt: user.emailVerifiedAt ?? now,
      },
    });
    await this.tokens.revokeUnused(user.id, ['PASSWORD_RESET', 'MAGIC_LINK']);
    await this.sessions.revokeAllForUser(user.id, 'password_reset');
    this.dispatch('mot de passe changé', this.mail.sendPasswordChanged(user.email));
    await this.audit.record('auth.password_reset', user.id, client);
  }

  /** Changement (connecté) : mot de passe actuel exigé, autres sessions révoquées. */
  async changePassword(
    userId: string,
    sessionId: string,
    input: ChangePasswordRequest,
    client: ClientInfo,
  ): Promise<void> {
    const user = await this.currentUser(userId);
    if (!(await this.passwords.verify(user.passwordHash, input.currentPassword))) {
      await this.audit.record('auth.password_change_failed', user.id, client);
      throw invalidCredentials(HttpStatus.BAD_REQUEST);
    }
    if (this.passwords.isRejected(input.newPassword, user.email)) {
      throw ApiException.auth('AUTH_PASSWORD_REJECTED', HttpStatus.BAD_REQUEST);
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await this.passwords.hash(input.newPassword), passwordChangedAt: new Date() },
    });
    await this.tokens.revokeUnused(user.id, ['PASSWORD_RESET', 'MAGIC_LINK']);
    await this.sessions.revokeAllForUser(user.id, 'password_change', sessionId);
    this.dispatch('mot de passe changé', this.mail.sendPasswordChanged(user.email));
    await this.audit.record('auth.password_changed', user.id, client);
  }

  // -------------------------------------------------------------------------
  // Outils
  // -------------------------------------------------------------------------

  private async startSession(user: User, client: ClientInfo): Promise<IssuedSession> {
    const { session, refreshToken } = await this.sessions.create(user.id, client);
    return this.issue(user, session.id, refreshToken);
  }

  private issue(user: User, sessionId: string, refreshToken: string): IssuedSession {
    const { token, expiresAt } = this.accessTokens.sign({ sub: user.id, sid: sessionId, role: user.role });
    return { user, sessionId, accessToken: token, accessTokenExpiresAt: expiresAt, refreshToken };
  }

  /**
   * Envoi d'e-mail sans attendre : la réponse ne dépend ni du succès ni de la durée de l'envoi
   * (anti-énumération par le temps). Les échecs sont journalisés sans l'adresse.
   */
  private dispatch(label: string, sending: Promise<void>): void {
    sending.catch((error: unknown) => {
      this.logger.error(`E-mail « ${label} » non envoyé : ${(error as Error).message}`);
    });
  }
}

function invalidCredentials(status: HttpStatus): ApiException {
  return ApiException.auth('AUTH_INVALID_CREDENTIALS', status);
}
