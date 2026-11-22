import { Body, Controller, Get, HttpStatus, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import * as z from 'zod';
import request from 'supertest';
import { testConfig } from '../../testing/test-config';
import { ApiCoreModule } from '../api-core.module';
import { ApiException } from '../errors/api-exception';
import { CsrfService } from '../security/csrf';
import { AuthThrottle } from '../throttler/throttler';
import { ApiZodBody, ZodValidationPipe } from '../validation/zod-validation.pipe';
import { setupApp } from './setup-app';

const bodySchema = z.object({ email: z.email({ message: 'Adresse e-mail invalide.' }) });

@Controller('health')
class FakeHealthController {
  @Get()
  health() {
    return { ok: true };
  }
}

@Controller('demo')
class DemoController {
  @Get('ok')
  ok() {
    return { ok: true };
  }

  @Get('boom')
  boom() {
    throw new Error('détail interne secret');
  }

  @Get('metier')
  metier() {
    throw new ApiException('QUOTA_EXCEEDED', HttpStatus.TOO_MANY_REQUESTS);
  }

  @Post('echo')
  @ApiZodBody(bodySchema)
  echo(@Body(new ZodValidationPipe(bodySchema)) body: z.infer<typeof bodySchema>) {
    return body;
  }

  @Post('auth')
  @AuthThrottle()
  auth() {
    return { ok: true };
  }

  @Get('limite')
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  limited() {
    return { ok: true };
  }
}

async function createApp(env: Record<string, string> = {}): Promise<NestExpressApplication> {
  const config = testConfig({ RATE_LIMIT_AUTH_PER_MINUTE: '2', ...env });
  @Module({ imports: [ApiCoreModule.forRoot(config)], controllers: [DemoController, FakeHealthController] })
  class DemoModule {}
  const app = await NestFactory.create<NestExpressApplication>(DemoModule, { bodyParser: false, logger: false });
  setupApp(app, config);
  await app.init();
  return app;
}

describe('setupApp (socle HTTP)', () => {
  let app: NestExpressApplication;
  let csrf: CsrfService;
  const origin = 'http://localhost:4200';

  beforeAll(async () => {
    app = await createApp();
    csrf = app.get(CsrfService);
  });
  afterAll(() => app.close());

  const withCsrf = (req: request.Test) => {
    const token = csrf.issue(null);
    return req.set('Origin', origin).set('X-CSRF-Token', token).set('Cookie', `rj_csrf=${token}`);
  };

  it('préfixe /api/v1, en-têtes Helmet, pas de X-Powered-By', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/demo/ok').expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    await request(app.getHttpServer()).get('/demo/ok').expect(404);
  });

  it('CORS : origine autorisée avec credentials, origine tierce sans en-tête', async () => {
    const ok = await request(app.getHttpServer()).get('/api/v1/demo/ok').set('Origin', origin);
    expect(ok.headers['access-control-allow-origin']).toBe(origin);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await request(app.getHttpServer()).get('/api/v1/demo/ok').set('Origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('erreur inattendue : 500 {code, message} sans détail interne (stack seulement hors production)', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/demo/boom').expect(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.message).not.toContain('secret');
  });

  it('erreur métier et route inconnue au format {code, message}', async () => {
    const quota = await request(app.getHttpServer()).get('/api/v1/demo/metier').expect(429);
    expect(quota.body).toEqual({ code: 'QUOTA_EXCEEDED', message: 'Quota atteint.' });
    const missing = await request(app.getHttpServer()).get('/api/v1/inconnu').expect(404);
    expect(missing.body).toEqual({ code: 'NOT_FOUND', message: 'Ressource introuvable.' });
  });

  it('mutation sans CSRF : 403 AUTH_CSRF_INVALID', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/demo/echo').send({ email: 'a@b.fr' }).expect(403);
    expect(res.body.code).toBe('AUTH_CSRF_INVALID');
  });

  it('validation Zod : 400 VALIDATION_ERROR avec le message du schéma', async () => {
    const res = await withCsrf(request(app.getHttpServer()).post('/api/v1/demo/echo')).send({ email: 'x' }).expect(400);
    expect(res.body).toEqual({ code: 'VALIDATION_ERROR', message: 'Adresse e-mail invalide.' });
    const ok = await withCsrf(request(app.getHttpServer()).post('/api/v1/demo/echo')).send({ email: 'a@b.fr' }).expect(201);
    expect(ok.body).toEqual({ email: 'a@b.fr' });
  });

  it('JSON invalide ou trop gros : 4xx VALIDATION_ERROR', async () => {
    const bad = await withCsrf(request(app.getHttpServer()).post('/api/v1/demo/echo'))
      .set('Content-Type', 'application/json')
      .send('{pas du json')
      .expect(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
    const big = await withCsrf(request(app.getHttpServer()).post('/api/v1/demo/echo'))
      .send({ email: 'x'.repeat(40_000) })
      .expect(413);
    expect(big.body.code).toBe('VALIDATION_ERROR');
  });

  it('rate limiting renforcé des routes d’auth : 429 RATE_LIMITED', async () => {
    await withCsrf(request(app.getHttpServer()).post('/api/v1/demo/auth')).expect(201);
    await withCsrf(request(app.getHttpServer()).post('/api/v1/demo/auth')).expect(201);
    const res = await withCsrf(request(app.getHttpServer()).post('/api/v1/demo/auth')).expect(429);
    expect(res.body).toEqual({ code: 'RATE_LIMITED', message: 'Trop de requêtes. Réessaie dans un instant.' });
  });

  it('rate limiting global (limite par route)', async () => {
    await request(app.getHttpServer()).get('/api/v1/demo/limite').expect(200);
    await request(app.getHttpServer()).get('/api/v1/demo/limite').expect(200);
    await request(app.getHttpServer()).get('/api/v1/demo/limite').expect(429);
  });

  it('Swagger servi hors production', async () => {
    await request(app.getHttpServer()).get('/api/v1/docs-json').expect(200);
  });
});

describe('setupApp en production', () => {
  it('pas de Swagger, CSP stricte, HSTS', async () => {
    const strong = 'P'.repeat(48);
    const app = await createApp({
      NODE_ENV: 'production',
      APP_URL: 'https://app.raijinshield.com',
      LANDING_URL: 'https://raijinshield.com',
      DATABASE_URL: 'postgresql://u:p@db/raijin',
      REDIS_URL: 'redis://127.0.0.1:1',
      TRUST_PROXY: '1',
      JWT_ACCESS_SECRET: strong,
      COOKIE_SECRET: `${strong}q`,
    });
    try {
      await request(app.getHttpServer()).get('/api/v1/docs-json').expect(404);
      const res = await request(app.getHttpServer()).get('/api/v1/demo/ok').expect(200);
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
      const boom = await request(app.getHttpServer()).get('/api/v1/demo/boom').expect(500);
      expect(boom.body.stack).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('maintenance : 503 MAINTENANCE partout sauf health', async () => {
    const app = await createApp({ MAINTENANCE_MODE: '1' });
    try {
      const res = await request(app.getHttpServer()).get('/api/v1/demo/ok').expect(503);
      expect(res.body).toEqual({ code: 'MAINTENANCE', message: expect.stringContaining('maintenance') });
      expect(res.headers['retry-after']).toBe('300');
      await request(app.getHttpServer()).post('/api/v1/demo/echo').send({}).expect(503);
      await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    } finally {
      await app.close();
    }
  });
});
