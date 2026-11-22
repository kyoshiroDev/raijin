import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { BillingProvider } from '@raijin/api-billing';
import { APP_CONFIG, type AppConfig } from '@raijin/api-core';
import { PrismaService } from '@raijin/api-prisma';
import type { Response } from 'express';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: 'raijin-api';
  database: 'up' | 'down';
}

export type ServiceState = 'configured' | 'not_configured';

/** Santé de l'API (Traefik, supervision) et état de configuration des services, sans valeur. */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly billing: BillingProvider,
  ) {}

  @Get()
  async health(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const databaseUp = await this.prisma.isHealthy();
    res.status(databaseUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    res.setHeader('Cache-Control', 'no-store');
    return { status: databaseUp ? 'ok' : 'degraded', service: 'raijin-api', database: databaseUp ? 'up' : 'down' };
  }

  /** Pour chaque service : « configured » ou « not_configured ». Jamais de valeur ni d'extrait. */
  @Get('config')
  configuration(): { services: Record<string, ServiceState> } {
    const services: Record<string, ServiceState> = {};
    for (const [name, configured] of Object.entries(this.config.services)) {
      services[name] = configured ? 'configured' : 'not_configured';
    }
    // Stripe utilisable seulement en mode `stripe` (clés et prix valides) ; simulation ou indisponible : non configuré.
    services['stripe'] = this.billing.mode() === 'stripe' ? 'configured' : 'not_configured';
    return { services };
  }
}
