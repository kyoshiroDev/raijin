import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@raijin/api-core';
import { AUTH_EMAIL_LINK_PATHS, AUTH_EMAIL_TOKEN_PARAM } from '@raijin/shared-contracts';
import { Mailer } from './mailer/mailer';
import {
  accountExistsTemplate,
  magicLinkTemplate,
  passwordChangedTemplate,
  passwordResetTemplate,
  verifyEmailTemplate,
  welcomeTemplate,
  type RenderedMail,
  type TemplateContext,
} from './templates/auth-templates';

/**
 * E-mails d'authentification. Les liens sont toujours construits avec APP_URL (jamais avec
 * l'en-tête Host de la requête) et le jeton opaque en paramètre `token`.
 */
@Injectable()
export class AuthMailService {
  private readonly ctx: TemplateContext;

  constructor(
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.ctx = { logoUrl: config.mail.logoUrl, appUrl: config.appUrl };
  }

  link(path: string, token?: string): string {
    const url = new URL(path, this.config.appUrl);
    if (token) url.searchParams.set(AUTH_EMAIL_TOKEN_PARAM, token);
    return url.toString();
  }

  sendEmailVerification(to: string, token: string): Promise<void> {
    const link = this.link(AUTH_EMAIL_LINK_PATHS.verifyEmail, token);
    return this.send(to, verifyEmailTemplate(this.ctx, link, this.config.auth.emailVerifyTtlMs));
  }

  sendPasswordReset(to: string, token: string): Promise<void> {
    const link = this.link(AUTH_EMAIL_LINK_PATHS.resetPassword, token);
    return this.send(to, passwordResetTemplate(this.ctx, link, this.config.auth.passwordResetTtlMs));
  }

  sendMagicLink(to: string, token: string): Promise<void> {
    const link = this.link(AUTH_EMAIL_LINK_PATHS.magicLink, token);
    return this.send(to, magicLinkTemplate(this.ctx, link, this.config.auth.magicLinkTtlMs));
  }

  sendWelcome(to: string, trialEndsAt: Date | null): Promise<void> {
    return this.send(to, welcomeTemplate(this.ctx, trialEndsAt));
  }

  sendAccountExists(to: string): Promise<void> {
    return this.send(
      to,
      accountExistsTemplate(
        this.ctx,
        this.link(AUTH_EMAIL_LINK_PATHS.login),
        this.link(AUTH_EMAIL_LINK_PATHS.forgotPassword),
      ),
    );
  }

  sendPasswordChanged(to: string): Promise<void> {
    return this.send(to, passwordChangedTemplate(this.ctx, this.link(AUTH_EMAIL_LINK_PATHS.forgotPassword)));
  }

  private send(to: string, mail: RenderedMail): Promise<void> {
    return this.mailer.send({ to, ...mail });
  }
}
