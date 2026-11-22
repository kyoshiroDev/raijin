import { Module, OnModuleInit } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SessionIdResolverRegistry } from '@raijin/api-core';
import { ApiNotificationsModule } from '@raijin/api-notifications';
import { AuthController } from './http/auth.controller';
import { AuthGuard } from './http/auth.guard';
import { AccessTokenService } from './services/access-token.service';
import { AuditService } from './services/audit.service';
import { AuthTokenService } from './services/auth-token.service';
import { AuthService } from './services/auth.service';
import { LoginAttemptsService } from './services/login-attempts.service';
import { PasswordService } from './services/password.service';
import { SessionService } from './services/session.service';

/**
 * Authentification : inscription, vérification d'e-mail, connexion, refresh rotatif,
 * lien magique, mots de passe. Requiert `ApiCoreModule` et `ApiPrismaModule` (globaux).
 */
@Module({
  // Secret et options passés à chaque appel (AccessTokenService) : rien de global ici.
  imports: [JwtModule.register({}), ApiNotificationsModule],
  controllers: [AuthController],
  providers: [
    AccessTokenService,
    AuditService,
    AuthGuard,
    AuthService,
    AuthTokenService,
    LoginAttemptsService,
    PasswordService,
    SessionService,
  ],
  exports: [AccessTokenService, AuditService, AuthGuard, AuthService, LoginAttemptsService, PasswordService, SessionService],
})
export class ApiAuthModule implements OnModuleInit {
  constructor(
    private readonly registry: SessionIdResolverRegistry,
    private readonly accessTokens: AccessTokenService,
  ) {}

  /** Branche la lecture du `sid` (access token signé) sur la garde CSRF globale. */
  onModuleInit(): void {
    this.registry.register((req) => this.accessTokens.readSessionId(req));
  }
}
