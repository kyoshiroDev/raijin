import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { APP_CONFIG, ApiException, ApiZodBody, ZodValidationPipe, type AppConfig } from '@raijin/api-core';
import { PrismaService } from '@raijin/api-prisma';
import {
  adminEnrollmentConfirmRequestSchema,
  adminRegenerateRecoveryCodesRequestSchema,
  adminVerifyRequestSchema,
  type AdminEnrollmentConfirmRequest,
  type AdminEnrollmentConfirmResponse,
  type AdminEnrollmentStart,
  type AdminRecoveryCodes,
  type AdminRegenerateRecoveryCodesRequest,
  type AdminSecurityStatus,
  type AdminVerifyRequest,
} from '@raijin/shared-contracts';
import * as z from 'zod';
import { AuthGuard, CurrentAuth, type AuthContext } from '../http/auth.guard';
import { Client, type ClientInfo } from '../services/client-info';
import { AdminRoute, AdminStageOverride } from './admin.guard';
import { AdminSecurityService } from './admin-security.service';

/**
 * 2FA et session admin (`/api/v1/admin/security/*`, contrat `admin/security`). Non-admin : 404. CSRF sur les POST
 * (garde globale). Aucune route ne pose de cookie : la session admin est portée par la session de l'app.
 */
@ApiTags('admin')
@Controller('admin/security')
@AdminRoute('enrollment')
export class AdminSecurityController {
  constructor(private readonly security: AdminSecurityService) {}

  @Get('status')
  @ApiOperation({ summary: 'État de la 2FA et de la session admin.' })
  status(@CurrentAuth() auth: AuthContext): Promise<AdminSecurityStatus> {
    return this.security.status(auth.userId, auth.sessionId);
  }

  @Post('enrollment')
  @ApiOperation({ summary: 'Commence l’enrôlement TOTP (QR code, secret) ; 409 si déjà activée.' })
  startEnrollment(@CurrentAuth() auth: AuthContext): Promise<AdminEnrollmentStart> {
    return this.security.startEnrollment(auth.userId);
  }

  @Post('enrollment/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(adminEnrollmentConfirmRequestSchema)
  @ApiOperation({ summary: 'Confirme l’enrôlement par un code, renvoie les 10 codes de secours (une seule fois).' })
  confirmEnrollment(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(adminEnrollmentConfirmRequestSchema)) body: AdminEnrollmentConfirmRequest,
    @Client() client: ClientInfo,
  ): Promise<AdminEnrollmentConfirmResponse> {
    return this.security.confirmEnrollment(auth.userId, auth.sessionId, body.code, client);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @AdminStageOverride('verify')
  @ApiZodBody(adminVerifyRequestSchema)
  @ApiOperation({ summary: 'Vérifie la session admin par un code TOTP ou un code de secours.' })
  verify(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(adminVerifyRequestSchema)) body: AdminVerifyRequest,
    @Client() client: ClientInfo,
  ): Promise<AdminSecurityStatus> {
    return this.security.verify(auth.userId, auth.sessionId, body, client);
  }

  @Post('recovery-codes')
  @HttpCode(HttpStatus.OK)
  @AdminStageOverride('full')
  @ApiZodBody(adminRegenerateRecoveryCodesRequestSchema)
  @ApiOperation({ summary: 'Régénère les codes de secours (code TOTP frais exigé, anciens codes invalidés).' })
  regenerate(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(adminRegenerateRecoveryCodesRequestSchema)) body: AdminRegenerateRecoveryCodesRequest,
    @Client() client: ClientInfo,
  ): Promise<AdminRecoveryCodes> {
    return this.security.regenerateRecoveryCodes(auth.userId, body.code, client);
  }

  @Post('end')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Quitte l’espace admin (la session de l’app reste ouverte).' })
  async end(@CurrentAuth() auth: AuthContext, @Client() client: ClientInfo): Promise<void> {
    await this.security.end(auth.userId, auth.sessionId, client);
  }
}

const ageBodySchema = z.object({ minutes: z.number().int().min(1).max(24 * 60) }).strict();

/**
 * Route de test (`/api/v1/internal/admin/age-session`), active seulement avec `JOBS_TEST_TRIGGER=1` hors production
 * (404 sinon) : recule de `minutes` la vérification et la dernière activité admin de la session courante, pour tester
 * l'expiration (inactivité, durée maximale) sans attendre.
 */
@ApiExcludeController()
@Controller('internal/admin')
@UseGuards(AuthGuard)
export class AdminSecurityInternalController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('age-session')
  @HttpCode(HttpStatus.NO_CONTENT)
  async age(@CurrentAuth() auth: AuthContext, @Body() rawBody: unknown): Promise<void> {
    if (!this.config.jobs.testTrigger || this.config.isProduction) throw new ApiException('NOT_FOUND', HttpStatus.NOT_FOUND);
    const body = ageBodySchema.safeParse(rawBody ?? {});
    if (!body.success) throw new ApiException('VALIDATION_ERROR', HttpStatus.BAD_REQUEST);
    const session = await this.prisma.session.findUnique({ where: { id: auth.sessionId }, select: { adminVerifiedAt: true, adminLastSeenAt: true } });
    if (!session?.adminVerifiedAt) return;
    const shift = body.data.minutes * 60_000;
    await this.prisma.session.update({
      where: { id: auth.sessionId },
      data: {
        adminVerifiedAt: new Date(session.adminVerifiedAt.getTime() - shift),
        adminLastSeenAt: new Date((session.adminLastSeenAt ?? session.adminVerifiedAt).getTime() - shift),
      },
    });
  }
}
