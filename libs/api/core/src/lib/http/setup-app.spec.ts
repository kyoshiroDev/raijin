import { Body, Controller, Get, HttpStatus, Module, Post, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import * as z from 'zod';
import type { Request } from 'express';
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

  @Get('ip')
  ip(@Req() req: Request) {
    return { ip: req.ip ?? null };
  }
}

@Controller('internal/bot')
class FakeBotInternalController {
  @Get('ping')
  ping(@Req() req: Request) {
    return { ip: req.ip ?? null };
  }
}

@Controller('demo')
class DemoController {
  @Get('ip')
  ip(@Req() req: Request) {
    return { ip: req.ip ?? null, edge: req.headers['x-raijin-edge'] ?? null, raw: req.rawHeaders.some((h) => h.toLowerCase() === 'x-raijin-edge') };
  }

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
  @Module({ imports: [ApiCoreModule.forRoot(config)], controllers: [DemoController, FakeHealthController, FakeBotInternalController] })
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
    // Audit 6 bis n1 : toute erreur (404 de route inconnue compris) est `no-store`, comme le 404 de l'espace admin.
    expect(missing.headers['cache-control']).toBe('no-store');
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

describe('setupApp : en-tête secret de Traefik (EDGE_SHARED_SECRET, X-Raijin-Edge)', () => {
  const secret = 'e'.repeat(40);
  const forwarded = '203.0.113.7';
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp({ EDGE_SHARED_SECRET: secret, TRUST_PROXY: '1', RATE_LIMIT_PER_MINUTE: '1000' });
  });
  afterAll(() => app.close());

  it('sans en-tête : 403 FORBIDDEN au corps neutre, sans écho de l’en-tête', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/demo/ok').expect(403);
    expect(res.body).toEqual({ code: 'FORBIDDEN', message: 'Accès refusé.' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-raijin-edge']).toBeUndefined();
    await request(app.getHttpServer()).post('/api/v1/demo/echo').send({ email: 'a@b.fr' }).expect(403);
    await request(app.getHttpServer()).get('/api/v1/inconnu').expect(403);
  });

  it('mauvais en-tête (autre valeur, préfixe, valeur répétée, casse) : 403', async () => {
    for (const value of ['f'.repeat(40), secret.slice(0, 39), `${secret}x`, secret.toUpperCase(), ' ']) {
      await request(app.getHttpServer()).get('/api/v1/demo/ok').set('X-Raijin-Edge', value).expect(403);
    }
    await request(app.getHttpServer()).get('/api/v1/demo/ok').set('X-Raijin-Edge', `${secret}, ${secret}`).expect(403);
  });

  it('bon en-tête : 200, X-Forwarded-For pris en compte (trust proxy), en-tête retiré de la requête', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/demo/ip')
      .set('x-raijin-edge', secret)
      .set('X-Forwarded-For', forwarded)
      .expect(200);
    expect(res.body).toEqual({ ip: forwarded, edge: null, raw: false });
    expect(JSON.stringify(res.headers)).not.toContain(secret);
  });

  it('santé sans en-tête : servie (healthchecks Docker et Traefik)', async () => {
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    await request(app.getHttpServer()).get('/API/V1/HEALTH').expect(200);
    // Le préfixe exempté ne couvre pas un chemin voisin.
    await request(app.getHttpServer()).get('/api/v1/healthx').expect(403);
  });

  it('aucune exemption /api/v1/internal/bot/ (audit 5) : 403 sans en-tête, 200 avec le bon', async () => {
    await request(app.getHttpServer()).get('/api/v1/internal/bot/ping').expect(403);
    await request(app.getHttpServer()).get('/API/V1/INTERNAL/BOT/ping').expect(403);
    await request(app.getHttpServer()).get('/api/v1/internal/bot/ping').set('X-Raijin-Edge', 'faux').expect(403);
    await request(app.getHttpServer()).get('/api/v1/internal/bot/ping').set('x-raijin-edge', secret).expect(200);
  });

  it('sous-chemin de santé exempté, mais X-Forwarded-For ignoré sans en-tête valide', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/ip').set('X-Forwarded-For', forwarded).expect(200);
    expect(res.body.ip).not.toBe(forwarded);
    expect(res.body.ip).toMatch(/127\.0\.0\.1|::1/);
  });

  it('X-Forwarded-For ignoré sans en-tête valide (IP = socket) : aucune falsification possible', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').set('X-Forwarded-For', forwarded);
    expect(res.status).toBe(200);
    // Contrôle direct sur une route exemptée qui renvoie l'IP.
    const bot = await request(app.getHttpServer())
      .get('/api/v1/health/ip')
      .set('X-Raijin-Edge', 'faux')
      .set('X-Forwarded-For', forwarded)
      .set('Forwarded', `for=${forwarded}`)
      .expect(200);
    expect(bot.body.ip).not.toBe(forwarded);
  });

  it('variable absente : contrôle désactivé, comportement inchangé (trust proxy selon TRUST_PROXY)', async () => {
    const off = await createApp({ TRUST_PROXY: '1', RATE_LIMIT_PER_MINUTE: '1000' });
    try {
      const res = await request(off.getHttpServer()).get('/api/v1/demo/ip').set('X-Forwarded-For', forwarded).expect(200);
      expect(res.body.ip).toBe(forwarded);
      await request(off.getHttpServer()).get('/api/v1/demo/ok').expect(200);
      // L'en-tête, même envoyé, n'est jamais visible en aval.
      const scrubbed = await request(off.getHttpServer()).get('/api/v1/demo/ip').set('X-Raijin-Edge', 'peu importe').expect(200);
      expect(scrubbed.body.edge).toBeNull();
    } finally {
      await off.close();
    }
  });
});
