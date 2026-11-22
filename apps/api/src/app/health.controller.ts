import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '@raijin/api-prisma';
import type { Response } from 'express';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: 'raijin-api';
  database: 'up' | 'down';
}

/**
 * Santé de l'API (Traefik, supervision). L'état « configuré / non configuré » des services n'est plus public
 * (ex-`GET health/config`, retiré en phase 6 bis, M3) : il est servi par `GET admin/health` (espace admin).
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async health(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const databaseUp = await this.prisma.isHealthy();
    res.status(databaseUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    res.setHeader('Cache-Control', 'no-store');
    return { status: databaseUp ? 'ok' : 'degraded', service: 'raijin-api', database: databaseUp ? 'up' : 'down' };
  }
}
