import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRoute, AuditService, Client, CurrentAuth, type AuthContext, type ClientInfo } from '@raijin/api-auth';
import { ApiZodBody, ZodValidationPipe } from '@raijin/api-core';
import {
  adminAuditLogQuerySchema,
  adminUserActionRequestSchema,
  adminUserListQuerySchema,
  type AdminAuditLogPage,
  type AdminAuditLogQuery,
  type AdminUserActionRequest,
  type AdminUserActionResult,
  type AdminUserDetail,
  type AdminUserListQuery,
  type AdminUserPage,
} from '@raijin/shared-contracts';
import { AdminUsersService } from './admin-users.service';

/** Utilisateurs de l'espace admin (`/api/v1/admin/users*`), session admin vérifiée ; CSRF sur l'action. */
@ApiTags('admin')
@Controller('admin/users')
@AdminRoute()
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @ApiOperation({ summary: 'Liste filtrable des comptes ; une recherche par e-mail (q) est auditée.' })
  list(
    @Query(new ZodValidationPipe(adminUserListQuerySchema)) query: AdminUserListQuery,
    @CurrentAuth() auth: AuthContext,
    @Client() client: ClientInfo,
  ): Promise<AdminUserPage> {
    return this.users.list(query, { userId: auth.userId, client });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fiche d’un compte (consultation auditée).' })
  detail(
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND })) id: string,
    @CurrentAuth() auth: AuthContext,
    @Client() client: ClientInfo,
  ): Promise<AdminUserDetail> {
    return this.users.detail(id, { userId: auth.userId, client });
  }

  @Post(':id/actions')
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(adminUserActionRequestSchema)
  @ApiOperation({ summary: 'Action confirmée sur un compte (prolonger l’essai, offrir un mois de Pro, suspendre…), auditée.' })
  act(
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND })) id: string,
    @Body(new ZodValidationPipe(adminUserActionRequestSchema)) body: AdminUserActionRequest,
    @CurrentAuth() auth: AuthContext,
    @Client() client: ClientInfo,
  ): Promise<AdminUserActionResult> {
    return this.users.act(id, body, { userId: auth.userId, client });
  }
}

/** Journal d'audit (`/api/v1/admin/audit-logs`), session admin vérifiée. */
@ApiTags('admin')
@Controller('admin/audit-logs')
@AdminRoute()
export class AdminAuditLogsController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'Journal d’audit paginé (filtres : compte visé, auteur, action).' })
  list(@Query(new ZodValidationPipe(adminAuditLogQuerySchema)) query: AdminAuditLogQuery): Promise<AdminAuditLogPage> {
    return this.audit.list(query);
  }
}
