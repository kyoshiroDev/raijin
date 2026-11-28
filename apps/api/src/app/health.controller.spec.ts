import { Reflector } from '@nestjs/core';
import type { PrismaService } from '@raijin/api-prisma';
import type { Response } from 'express';
import { HealthController } from './health.controller';

function response() {
  return { status: jest.fn(), setHeader: jest.fn() } as unknown as Response & { status: jest.Mock };
}

describe('HealthController', () => {
  it('base joignable : 200 ok', async () => {
    const controller = new HealthController({ isHealthy: async () => true } as unknown as PrismaService);
    const res = response();
    await expect(controller.health(res)).resolves.toEqual({ status: 'ok', service: 'raijin-api', database: 'up' });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('base injoignable : 503 degraded', async () => {
    const controller = new HealthController({ isHealthy: async () => false } as unknown as PrismaService);
    const res = response();
    await expect(controller.health(res)).resolves.toMatchObject({ status: 'degraded', database: 'down' });
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('GET health/config retiré (M3) : plus aucune route publique de configuration', () => {
    const reflector = new Reflector();
    const routes = Object.getOwnPropertyNames(HealthController.prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => reflector.get<string>('path', (HealthController.prototype as unknown as Record<string, () => unknown>)[name] as () => unknown));
    expect(routes).toEqual(['/']);
  });
});
