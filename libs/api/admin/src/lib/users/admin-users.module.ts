import { Module } from '@nestjs/common';
import { ApiAuthModule } from '@raijin/api-auth';
import { AdminAuditLogsController, AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

/**
 * Utilisateurs et journal d'audit de l'espace admin (nestjs-api), importé par `ApiAdminModule` (admin-analytics).
 * Requiert `ApiCoreModule`, `ApiPrismaModule` et `ApiUsersModule.forRoot(...)` (global : flux de suppression) dans l'app.
 */
@Module({
  imports: [ApiAuthModule],
  controllers: [AdminUsersController, AdminAuditLogsController],
  providers: [AdminUsersService],
  exports: [AdminUsersService],
})
export class AdminUsersModule {}
