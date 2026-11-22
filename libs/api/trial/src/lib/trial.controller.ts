import { Body, Controller, Get, Header, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, CurrentAuth, Roles, RolesGuard, type AuthContext } from '@raijin/api-auth';
import { ApiException } from '@raijin/api-core';
import type { TrialConversionReport, TrialRecap } from '@raijin/shared-contracts';
import * as z from 'zod';
import { TrialConversionService } from './trial-conversion.service';
import { TrialLifecycleService, type TrialTickResult } from './trial-lifecycle.service';
import { TrialRecapService } from './trial-recap.service';

/** Essai Pro de l'utilisateur (`/api/v1/trial`), session ; CSRF sur la mutation (garde globale). */
@ApiTags('essai')
@Controller('trial')
@UseGuards(AuthGuard)
export class TrialController {
  constructor(
    private readonly recaps: TrialRecapService,
    private readonly lifecycle: TrialLifecycleService,
  ) {}

  @Get('recap')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Récapitulatif de l’essai Pro (analyses, alertes, tokens Danger, suivis) ; 404 sans essai.' })
  recap(@CurrentAuth() auth: AuthContext): Promise<TrialRecap> {
    return this.recaps.recap(auth.userId);
  }

  @Post('end-screen/seen')
  @HttpCode(204)
  @ApiOperation({ summary: 'L’écran de fin d’essai ne réapparaît plus (tous appareils).' })
  async endScreenSeen(@CurrentAuth() auth: AuthContext): Promise<void> {
    await this.lifecycle.markEndScreenSeen(auth.userId);
  }
}

/** Administration (phase 6 : tableau de conversion minimal ; espace admin complet en 6 bis). Rôle ADMIN relu en base. */
@ApiTags('admin')
@Controller('admin')
@UseGuards(AuthGuard, RolesGuard)
@Roles('ADMIN')
export class TrialAdminController {
  constructor(private readonly conversion: TrialConversionService) {}

  @Get('trial-conversion')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Conversion des essais Pro par cohorte hebdomadaire (rôle ADMIN).' })
  report(): Promise<TrialConversionReport> {
    return this.conversion.report();
  }
}

/** Horloge simulée : instant ISO compris dans ±400 jours de l'heure réelle. */
const tickBodySchema = z
  .object({ now: z.iso.datetime(), userId: z.uuid().optional() })
  .strict()
  .refine((body) => Math.abs(Date.parse(body.now) - Date.now()) <= 400 * 86_400_000);

/**
 * Route de test (`/api/v1/internal/trial`), active seulement avec `JOBS_TEST_TRIGGER=1` hors production
 * (404 sinon, comme les autres `internal/*`) : `POST internal/trial/tick {now, userId?}` exécute le job de fin
 * d'essai à l'instant donné (horloge simulée), sans toucher l'horloge du reste de l'API ; `userId` limite le
 * passage à un compte (tests e2e isolés).
 */
@ApiExcludeController()
@Controller('internal/trial')
export class TrialInternalController {
  constructor(private readonly lifecycle: TrialLifecycleService) {}

  @Post('tick')
  @HttpCode(200)
  async tick(@Body() rawBody: unknown): Promise<TrialTickResult | { locked: true }> {
    this.lifecycle.assertTestClock();
    const body = tickBodySchema.safeParse(rawBody ?? {});
    if (!body.success) throw new ApiException('VALIDATION_ERROR', HttpStatus.BAD_REQUEST);
    return this.lifecycle.tick(new Date(body.data.now), body.data.userId);
  }
}
