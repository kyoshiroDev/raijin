import { Body, Controller, Get, Header, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Client, OptionalAuth, OptionalAuthGuard, type AuthContext, type ClientInfo } from '@raijin/api-auth';
import { AnalysisThrottle, ApiZodBody, ZodValidationPipe } from '@raijin/api-core';
import {
  analysisRequestSchema,
  type AnalysisRequest,
  type AnalysisResponse,
  type AnalysisResult,
  type QuotaInfo,
} from '@raijin/shared-contracts';
import type { Response } from 'express';
import { AnalysisService } from '../analysis/analysis.service';
import { QuotaService, type QuotaActor } from '../quota/quota.service';
import { MintParamPipe } from './mint-param.pipe';

function actorOf(auth: AuthContext | null, client: ClientInfo): QuotaActor {
  return auth ? { kind: 'user', userId: auth.userId } : { kind: 'anonymous', ip: client.ip };
}

/** Analyse de token (`/api/v1/analyses`), docs/ARCHITECTURE.md §9.2. */
@ApiTags('analyses')
@Controller('analyses')
export class AnalysisController {
  constructor(
    private readonly analyses: AnalysisService,
    private readonly quota: QuotaService,
  ) {}

  @Post()
  @HttpCode(200)
  @UseGuards(OptionalAuthGuard)
  @AnalysisThrottle()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Analyse un token (mint ou lien) ; visiteur anonyme ou connecté, quota journalier.' })
  @ApiZodBody(analysisRequestSchema)
  async analyze(
    @Body(new ZodValidationPipe(analysisRequestSchema)) body: AnalysisRequest,
    @OptionalAuth() auth: AuthContext | null,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AnalysisResponse> {
    const { response, durationMs } = await this.analyses.analyze(body.input, actorOf(auth, client));
    res.setHeader('Server-Timing', `analysis;dur=${Math.round(durationMs)}`);
    return response;
  }

  @Get('quota')
  @UseGuards(OptionalAuthGuard)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Quota d’analyses restant aujourd’hui (UTC).' })
  async remaining(@OptionalAuth() auth: AuthContext | null, @Client() client: ClientInfo): Promise<QuotaInfo> {
    return this.quota.info(await this.quota.resolvePolicy(actorOf(auth, client)));
  }

  @Get(':mint/latest')
  @Header('Cache-Control', 'public, max-age=30')
  @ApiOperation({ summary: 'Dernière analyse publiée d’un mint (moins de 24 h), sans quota.' })
  latest(@Param('mint', MintParamPipe) mint: string): Promise<AnalysisResult> {
    return this.analyses.latest(mint);
  }
}
