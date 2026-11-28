import { ThrottlerStorageService } from '@nestjs/throttler';
import { testConfig } from '@raijin/api-core';
import type { PrismaService } from '@raijin/api-prisma';
import type { NextFunction, Request, Response } from 'express';
import type { AccessTokenService } from '../services/access-token.service';
import { AdminAreaMiddleware } from './admin-area.middleware';

const USER = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

const storages: ThrottlerStorageService[] = [];
afterAll(() => storages.forEach((storage) => storage.onApplicationShutdown()));

function setup(subject: string | null, row: { role: string; suspendedAt: Date | null } | null, perMinute = 100) {
  const accessTokens = { readSubject: jest.fn(() => subject) };
  const prisma = { user: { findUnique: jest.fn(async () => row) } };
  const storage = new ThrottlerStorageService();
  storages.push(storage);
  const base = testConfig();
  const config = { ...base, rateLimit: { ...base.rateLimit, perMinute } };
  const middleware = new AdminAreaMiddleware(accessTokens as unknown as AccessTokenService, prisma as unknown as PrismaService, storage, config);
  const res = { setHeader: jest.fn(), status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  const next = jest.fn() as unknown as NextFunction & jest.Mock;
  const run = (method = 'GET', ip = '203.0.113.7') => middleware.use({ method, ip } as Request, res as unknown as Response, next);
  return { run, res, next, prisma };
}

describe('AdminAreaMiddleware (m3 : espace admin invisible)', () => {
  it('visiteur anonyme (ou jeton invalide) : 404 NOT_FOUND, no-store, sans requête en base', async () => {
    const { run, res, next, prisma } = setup(null, null);
    await run('POST');
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ code: 'NOT_FOUND', message: expect.any(String) });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(next).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('compte USER, suspendu ou disparu : 404 avant CSRF, throttler et AuthGuard', async () => {
    for (const row of [{ role: 'USER', suspendedAt: null }, { role: 'ADMIN', suspendedAt: new Date() }, null]) {
      const { run, res, next } = setup(USER, row);
      await run('DELETE');
      expect(res.status).toHaveBeenCalledWith(404);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('ADMIN en base (jeton signé, même expiré) : passe, garde ses 401 / 403 / 429 normaux', async () => {
    const { run, res, next, prisma } = setup(USER, { role: 'ADMIN', suspendedAt: null });
    await run('POST');
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: USER }, select: { role: true, suspendedAt: true } });
  });

  it('n2 : rafale comptée avant le jeton et la base, 404 (jamais 429) au-delà de la limite, par préfixe d’IP', async () => {
    const { run, res, next, prisma } = setup(USER, { role: 'ADMIN', suspendedAt: null }, 3);
    for (let i = 0; i < 3; i += 1) await run('GET');
    expect(next).toHaveBeenCalledTimes(3);
    await run('GET');
    await run('GET');
    expect(next).toHaveBeenCalledTimes(3);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(3);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.status).not.toHaveBeenCalledWith(429);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    await run('GET', '198.51.100.9');
    expect(next).toHaveBeenCalledTimes(4);
  });

  it('pré-requête CORS (OPTIONS) : non concernée', async () => {
    const { run, next, res } = setup(null, null);
    await run('OPTIONS');
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
