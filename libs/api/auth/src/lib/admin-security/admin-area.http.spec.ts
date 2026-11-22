import { Global, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ApiCoreModule, setupApp, testConfig } from '@raijin/api-core';
import { PrismaService } from '@raijin/api-prisma';
import request from 'supertest';
import { ApiAuthModule } from '../api-auth.module';
import { AccessTokenService } from '../services/access-token.service';
import { SessionService } from '../services/session.service';

const ORIGIN = 'http://localhost:4200';
const ADMIN = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a50';
const USER = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51';
const config = testConfig({ RATE_LIMIT_AUTH_PER_MINUTE: '1000' });

const users: Record<string, { role: string; suspendedAt: Date | null; totpSecret: { enabledAt: Date | null } | null }> = {
  [ADMIN]: { role: 'ADMIN', suspendedAt: null, totpSecret: null },
  [USER]: { role: 'USER', suspendedAt: null, totpSecret: null },
};
const prisma = {
  user: { findUnique: jest.fn(async ({ where }: { where: { id: string } }) => users[where.id] ?? null) },
  session: { findUnique: jest.fn(async () => ({ adminVerifiedAt: null, adminLastSeenAt: null })), updateMany: jest.fn() },
  totpSecret: { findUnique: jest.fn(async () => null) },
  adminRecoveryCode: { count: jest.fn(async () => 0) },
};

@Global()
@Module({ providers: [{ provide: PrismaService, useValue: prisma }], exports: [PrismaService] })
class FakePrismaModule {}

describe('Espace admin invisible (HTTP, m3) : 404 avant AuthGuard, CSRF et throttler pour tout non-admin', () => {
  let app: NestExpressApplication;
  let accessTokens: AccessTokenService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiCoreModule.forRoot(config), FakePrismaModule, ApiAuthModule] })
      .overrideProvider(SessionService)
      .useValue({ isActive: jest.fn(async () => true) })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
    setupApp(app, config);
    await app.init();
    accessTokens = app.get(AccessTokenService);
  });

  afterAll(() => app.close());

  const server = () => app.getHttpServer();
  const cookie = (sub: string, role: 'USER' | 'ADMIN' = 'USER') => `rj_at=${accessTokens.sign({ sub, sid: 'sid-1', role }).token}`;

  it('anonyme : 404 NOT_FOUND (au lieu de 401) en GET, et en POST sans CSRF (au lieu de 403)', async () => {
    const get = await request(server()).get('/api/v1/admin/security/status').set('Origin', ORIGIN).expect(404);
    expect(get.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
    expect(get.headers['cache-control']).toBe('no-store');
    await request(server()).post('/api/v1/admin/security/verify').set('Origin', ORIGIN).send({}).expect(404);
    await request(server()).get('/api/v1/admin/route-inexistante').set('Origin', ORIGIN).expect(404);
  });

  it('compte USER (jeton marqué ADMIN compris : rôle relu en base) : 404, même sans CSRF', async () => {
    await request(server()).get('/api/v1/admin/security/status').set('Origin', ORIGIN).set('Cookie', cookie(USER, 'ADMIN')).expect(404);
    await request(server()).post('/api/v1/admin/security/enrollment').set('Origin', ORIGIN).set('Cookie', cookie(USER)).expect(404);
    await request(server()).get('/api/v1/admin/security/status').set('Origin', ORIGIN).set('Cookie', 'rj_at=jeton-forge').expect(404);
  });

  it('ADMIN : codes normaux (200 sur le statut, 403 CSRF sur une mutation sans jeton)', async () => {
    const status = await request(server()).get('/api/v1/admin/security/status').set('Origin', ORIGIN).set('Cookie', cookie(ADMIN, 'ADMIN')).expect(200);
    expect(status.body).toMatchObject({ enrolled: false, verified: false });
    const csrf = await request(server()).post('/api/v1/admin/security/enrollment').set('Origin', ORIGIN).set('Cookie', cookie(ADMIN, 'ADMIN')).expect(403);
    expect(csrf.body.code).toBe('AUTH_CSRF_INVALID');
  });

  it('hors admin/* : comportement inchangé (état de session anonyme servi normalement)', async () => {
    await request(server()).get('/api/v1/auth/session').set('Origin', ORIGIN).expect(200);
  });
});
