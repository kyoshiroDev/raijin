import { testConfig } from '@raijin/api-core';
import type { PrismaService } from '@raijin/api-prisma';
import type { Response } from 'express';
import { HealthController } from './health.controller';

function response() {
  return { status: jest.fn(), setHeader: jest.fn() } as unknown as Response & { status: jest.Mock };
}

describe('HealthController', () => {
  it('base joignable : 200 ok', async () => {
    const controller = new HealthController({ isHealthy: async () => true } as unknown as PrismaService, testConfig());
    const res = response();
    await expect(controller.health(res)).resolves.toEqual({ status: 'ok', service: 'raijin-api', database: 'up' });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('base injoignable : 503 degraded', async () => {
    const controller = new HealthController({ isHealthy: async () => false } as unknown as PrismaService, testConfig());
    const res = response();
    await expect(controller.health(res)).resolves.toMatchObject({ status: 'degraded', database: 'down' });
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('/health/config : état par service, jamais de valeur', () => {
    const controller = new HealthController(
      {} as PrismaService,
      testConfig({ HELIUS_API_KEY: 'cle-helius-secrete' }),
    );
    const body = controller.configuration();
    expect(body.services['helius']).toBe('configured');
    expect(body.services['stripe']).toBe('not_configured');
    expect(JSON.stringify(body)).not.toContain('cle-helius-secrete');
  });
});
