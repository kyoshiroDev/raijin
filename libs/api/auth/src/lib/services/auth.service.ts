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
import { AuditService } from '../audit/audit.service';
import { AuthTokenService } from './auth-token.service';
import type { ClientInfo } from './client-info';
import { normalizeEmail } from './email-normalizer';
import { LoginAttemptsService } from './login-attempts.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { TrialEligibilityService, type TrialOutcome } from '../trial/trial-eligibility.service';

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
    private readonly attempts: LoginAttemptsService,
    private readonly trials: TrialEligibilityService,
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
    await this.assertNotSuspended(user, client, 'email_verify');
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

  /**
   * Marque l'e-mail vérifié (une seule fois) et, dans la même transaction, démarre l'essai Pro si
   * l'anti-abus l'accepte (docs/ARCHITECTURE.md §13.6) ; sinon le compte reste en Gratuit, sans motif
   * communiqué. Puis e-mail de bienvenue (qui annonce l'essai, ou neutre).
   */
  private async markEmailVerified(userId: string, client: ClientInfo): Promise<User> {
    const now = new Date();
    const outcome: TrialOutcome | null = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({ where: { id: userId, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
      if (updated.count !== 1) return null;
      const candidate = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, emailNormalized: true, plan: true, trialStatus: true },
      });
      return candidate ? this.trials.startOnVerification(tx, candidate, client, now) : null;
    });
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw ApiException.auth('AUTH_TOKEN_INVALID', HttpStatus.BAD_REQUEST);
    if (outcome !== null) {
      const trial = outcome.kind === 'started' ? { endsAt: outcome.endsAt, days: this.config.trial.days } : null;
      this.dispatch('bienvenue', this.mail.sendWelcome(user.email, trial));
      await this.prisma.productEvent.create({ data: { userId, type: 'email_verified' } });
      await this.audit.record('auth.email_verified', userId, client, { trial: outcome.kind });
    }
    return user;
  }

  // -------------------------------------------------------------------------
  // Connexion, sessions
  // -------------------------------------------------------------------------

  /**
   * Connexion. Même réponse (401 AUTH_INVALID_CREDENTIALS) et même coût (argon2 réel ou factice)
   * que le compte existe ou non, qu'il soit verrouillé ou non : aucune énumération possible.
   * Le verrouillage temporaire est indexé par adresse normalisée, comptes inconnus compris.
   */
  async login(input: LoginRequest, client: ClientInfo): Promise<IssuedSession> {
    const emailNormalized = normalizeEmail(input.email);
    // Tentative réservée avant la vérification (audit 6 bis n3) : pas de lecture du verrou puis écriture séparées.
    const [user, { locked, lockedNow }] = await Promise.all([
      this.prisma.user.findUnique({ where: { emailNormalized } }),
      this.attempts.reserve(emailNormalized),
    ]);
    const valid = user
      ? await this.passwords.verify(user.passwordHash, input.password)
      : (await this.passwords.verifyDummy(input.password), false);

    if (!user || !valid || locked) {
      const action = locked ? 'auth.login_locked' : lockedNow ? 'auth.account_locked' : 'auth.login_failed';
      await this.audit.record(action, user?.id ?? null, client);
      throw invalidCredentials(HttpStatus.UNAUTHORIZED);
    }
    await this.attempts.reset(emailNormalized);
    // Suspension : signalée seulement après des identifiants valides (aucune énumération).
    await this.assertNotSuspended(user, client, 'password');
    const fresh = await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await this.audit.record('auth.login', user.id, client, { method: 'password' });
    return this.startSession(fresh, client);
  }

  /**
   * Confirmation par mot de passe d'une action sensible (changement de mot de passe, suppression
   * du compte) : soumise au même compteur d'échecs que la connexion, tentative réservée avant la vérification
   * (audit 6 bis n3). Refus : 400 INVALID_CREDENTIALS.
   */
  async confirmPassword(user: User, password: string, client: ClientInfo, action: string): Promise<void> {
    const { locked } = await this.attempts.reserve(user.emailNormalized);
    const valid = await this.passwords.verify(user.passwordHash, password);
    if (locked || !valid) {
      await this.audit.record(`${action}_failed`, user.id, client, { locked });
      throw invalidCredentials(HttpStatus.BAD_REQUEST);
    }
    await this.attempts.reset(user.emailNormalized);
  }

  /** Rotation du refresh (cookie) : nouvelle paire de jetons, même session. */
  /**
   * Rotation du refresh. `expectedSessionId` : sid de l'access token signé (même expiré) présent
   * dans la requête ; s'il est fourni, le refresh doit appartenir à cette session.
   */
  async refresh(
    rawRefreshToken: string | null,
    client: ClientInfo,
    expectedSessionId: string | null = null,
  ): Promise<IssuedSession> {
    // Pas de cookie de refresh : visiteur jamais connecté ou déconnecté. Code distinct
    // (UNAUTHORIZED) pour que le front n'essaie pas de rafraîchir.
    if (!rawRefreshToken) throw new ApiException('UNAUTHORIZED', HttpStatus.UNAUTHORIZED);
    const { session, refreshToken } = await this.sessions.rotate(rawRefreshToken, client, expectedSessionId);
    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    if (user.suspendedAt) {
      await this.sessions.revoke(session.id, 'suspended');
      throw ApiException.admin('ACCOUNT_SUSPENDED', HttpStatus.FORBIDDEN);
    }
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
    await this.assertNotSuspended(user, client, 'magic_link');
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
    // Le lien prouve la possession de la boîte : même vérification (et même décision d'essai) que le lien dédié.
    if (!user.emailVerifiedAt) await this.markEmailVerified(user.id, client);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await this.passwords.hash(password),
        passwordChangedAt: new Date(),
      },
    });
    await this.tokens.revokeUnused(user.id, ['PASSWORD_RESET', 'MAGIC_LINK']);
    await this.attempts.reset(user.emailNormalized);
    await this.sessions.revokeAllForUser(user.id, 'password_reset');
    // Appareils abonnés au push retirés avec les sessions (audit phase 4, m2) : ils se réabonnent après connexion.
    await this.prisma.pushSubscription.deleteMany({ where: { userId: user.id } });
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
    await this.confirmPassword(user, input.currentPassword, client, 'auth.password_change');
    if (this.passwords.isRejected(input.newPassword, user.email)) {
      throw ApiException.auth('AUTH_PASSWORD_REJECTED', HttpStatus.BAD_REQUEST);
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await this.passwords.hash(input.newPassword), passwordChangedAt: new Date() },
    });
    await this.tokens.revokeUnused(user.id, ['PASSWORD_RESET', 'MAGIC_LINK']);
    await this.sessions.revokeAllForUser(user.id, 'password_change', sessionId);
    await this.prisma.pushSubscription.deleteMany({ where: { userId: user.id } });
    this.dispatch('mot de passe changé', this.mail.sendPasswordChanged(user.email));
    await this.audit.record('auth.password_changed', user.id, client);
  }

  // -------------------------------------------------------------------------
  // Outils
  // -------------------------------------------------------------------------

  /** Compte suspendu par un admin : 403 `ACCOUNT_SUSPENDED` (audité), aucune session ouverte. */
  private async assertNotSuspended(user: Pick<User, 'id' | 'suspendedAt'>, client: ClientInfo, method: string): Promise<void> {
    if (!user.suspendedAt) return;
    await this.audit.record('auth.login_suspended', user.id, client, { method });
    throw ApiException.admin('ACCOUNT_SUSPENDED', HttpStatus.FORBIDDEN);
  }

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
      // Uniquement code et statut : les messages SMTP peuvent contenir l'adresse du destinataire.
      const { code, responseCode } = (error ?? {}) as { code?: unknown; responseCode?: unknown };
      this.logger.error(
        `E-mail « ${label} » non envoyé (code=${typeof code === 'string' ? code : 'inconnu'}, statut=${typeof responseCode === 'number' ? responseCode : '-'})`,
      );
    });
  }
}

function invalidCredentials(status: HttpStatus): ApiException {
  return ApiException.auth('AUTH_INVALID_CREDENTIALS', status);
}
