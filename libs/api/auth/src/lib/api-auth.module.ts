import { MiddlewareConsumer, Module, NestModule, OnModuleInit, RequestMethod } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SessionIdResolverRegistry } from '@raijin/api-core';
import { ApiNotificationsModule } from '@raijin/api-notifications';
import { AuthController } from './http/auth.controller';
import { AuthGuard, OptionalAuthGuard } from './http/auth.guard';
import { AccessTokenService } from './services/access-token.service';
import { ADMIN_AREA_ROUTES, AdminAreaMiddleware } from './admin-security/admin-area.middleware';
import { AdminGuard } from './admin-security/admin.guard';
import { AdminSecurityController, AdminSecurityInternalController } from './admin-security/admin-security.controller';
import { AdminSecurityService } from './admin-security/admin-security.service';
import { AuditService } from './audit/audit.service';
import { AuthTokenService } from './services/auth-token.service';
import { AuthService } from './services/auth.service';
import { LoginAttemptsService } from './services/login-attempts.service';
import { PasswordService } from './services/password.service';
import { SessionService } from './services/session.service';
import { RolesGuard } from './http/roles.guard';
import { TrialEligibilityService } from './trial/trial-eligibility.service';

/**
 * Authentification : inscription, vérification d'e-mail, connexion, refresh rotatif,
 * lien magique, mots de passe. Requiert `ApiCoreModule` et `ApiPrismaModule` (globaux).
 */
@Module({
  // Secret et options passés à chaque appel (AccessTokenService) : rien de global ici.
  imports: [JwtModule.register({}), ApiNotificationsModule],
  controllers: [AuthController, AdminSecurityController, AdminSecurityInternalController],
  providers: [
    AccessTokenService,
    AdminAreaMiddleware,
    AdminGuard,
    AdminSecurityService,
    AuditService,
    AuthGuard,
    OptionalAuthGuard,
    AuthService,
    AuthTokenService,
    LoginAttemptsService,
    PasswordService,
    SessionService,
    RolesGuard,
    TrialEligibilityService,
  ],
  exports: [
    AccessTokenService,
    AdminGuard,
    AdminSecurityService,
    AuditService,
    AuthGuard,
    OptionalAuthGuard,
    RolesGuard,
    AuthService,
    LoginAttemptsService,
    PasswordService,
    SessionService,
    TrialEligibilityService,
  ],
})
export class ApiAuthModule implements OnModuleInit, NestModule {
  constructor(
    private readonly registry: SessionIdResolverRegistry,
    private readonly accessTokens: AccessTokenService,
  ) {}

  /** Branche la lecture du `sid` (access token signé) sur la garde CSRF globale. */
  onModuleInit(): void {
    this.registry.register((req) => this.accessTokens.readSessionId(req));
  }

  /** Espace admin invisible (404) pour tout compte qui n'est pas ADMIN, avant les gardes globales (m3). */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AdminAreaMiddleware).forRoutes({ path: ADMIN_AREA_ROUTES, method: RequestMethod.ALL });
  }
}
