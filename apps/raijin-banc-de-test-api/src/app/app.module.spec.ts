import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { benchLivenessSchema } from '@raijin/bench-contracts';
import { loadBenchConfig, setupBenchApp } from '@raijin/bench-core';
import { BenchPrismaService } from '@raijin/bench-prisma';
import request from 'supertest';
import { AppModule } from './app.module';

describe('AppModule (API du banc)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const config = loadBenchConfig({ NODE_ENV: 'test' });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
      .overrideProvider(BenchPrismaService)
      .useValue({ isHealthy: async () => true, databaseSizeBytes: async () => 0, $connect: async () => undefined, $disconnect: async () => undefined })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
    setupBenchApp(app, config);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('santé publique conforme au contrat, noindex', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(benchLivenessSchema.parse(res.body)).toEqual({ status: 'ok' });
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('toute autre route exige la session du banc ; aucune inscription', async () => {
    for (const path of ['/api/status', '/api/events', '/api/jobs/runs', '/api/auth/session']) {
      expect((await request(app.getHttpServer()).get(path).expect(401)).body.code).toBe('AUTH_SESSION_EXPIRED');
    }
    await request(app.getHttpServer()).post('/api/auth/register').send({}).expect(404);
  });
});
