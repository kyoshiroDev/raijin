import express from 'express';
import request from 'supertest';
import { createTestBench, ORIGIN, OWNER_EMAIL, OWNER_PASSWORD, type TestBench } from '../../testing/test-app';
import { createEdgeGuard, EDGE_HEADER, edgeSecretDigest, isValidEdgeHeader } from './edge-guard';

const EDGE = 'c4f1a9e07b3d5628e1f0a7b9c2d4e6f8';
const NEUTRAL = { code: 'UNAUTHORIZED', message: 'Accès refusé.' };

describe('en-tête secret de Traefik (X-Raijin-Edge)', () => {
  describe('API du banc avec EDGE_SHARED_SECRET', () => {
    let bench: TestBench;
    beforeEach(async () => {
      bench = await createTestBench({ EDGE_SHARED_SECRET: EDGE });
    });
    afterEach(async () => {
      await bench.app.close();
    });
    const http = () => request(bench.app.getHttpServer());

    it('403 neutre sans en-tête ou avec un mauvais en-tête, sans jamais renvoyer la valeur', async () => {
      for (const value of [undefined, '', 'mauvais', `${EDGE}x`, EDGE.slice(0, -1)]) {
        const req = http().get('/api/status');
        if (value !== undefined) req.set('X-Raijin-Edge', value);
        const res = await req.expect(403);
        expect(res.body).toEqual(NEUTRAL);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(JSON.stringify(res.headers)).not.toContain(EDGE);
      }
      const login = await http().post('/api/auth/login').set('Origin', ORIGIN).send({ email: OWNER_EMAIL, password: OWNER_PASSWORD, totp: bench.totp() });
      expect(login.status).toBe(403);
      expect(login.headers['set-cookie']).toBeUndefined();
    });

    it('en-tête valide : la requête atteint l’API (connexion 200, session exigée ensuite)', async () => {
      const res = await http()
        .post('/api/auth/login')
        .set('X-Raijin-Edge', EDGE)
        .set('Origin', ORIGIN)
        .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD, totp: bench.totp() })
        .expect(200);
      expect(JSON.stringify(res.headers)).not.toContain(EDGE);
      expect(JSON.stringify(res.body)).not.toContain(EDGE);
      // Route protégée : l'en-tête ne remplace pas la session (401, pas 403).
      await http().get('/api/status').set('X-Raijin-Edge', EDGE).expect(401);
    });

    it('santé accessible sans en-tête (sondes), mais seulement elle', async () => {
      await http().get('/api/health').expect(200);
      await http().head('/api/health').expect(200);
      await http().get('/api/health').set('X-Raijin-Edge', EDGE).expect(200);
      await http().post('/api/health').expect(403);
      await http().get('/api/healthz').expect(403);
      await http().get('/api/health/../status').expect(403);
    });
  });

  it('sans EDGE_SHARED_SECRET : contrôle désactivé (comportement inchangé)', async () => {
    const bench = await createTestBench();
    try {
      await request(bench.app.getHttpServer()).get('/api/status').expect(401);
      await request(bench.app.getHttpServer())
        .post('/api/auth/login')
        .set('Origin', ORIGIN)
        .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD, totp: bench.totp() })
        .expect(200);
    } finally {
      await bench.app.close();
    }
  });

  describe('X-Forwarded-For (trust proxy = 1)', () => {
    /** Application minimale : même ordre que `setupBenchApp` (garde avant toute lecture de `req.ip`). */
    function appWith(digest: Buffer | null) {
      const app = express();
      app.set('trust proxy', 1);
      app.use(createEdgeGuard(digest));
      const echo = (req: express.Request, res: express.Response) =>
        res.json({ ip: req.ip, protocol: req.protocol, edge: req.headers[EDGE_HEADER] ?? null });
      app.get('/api/health', echo);
      app.get('/api/echo', echo);
      return app;
    }
    const FORGED = '203.0.113.9';

    it('ignoré sans en-tête valide : IP de la socket (santé)', async () => {
      const app = appWith(edgeSecretDigest(EDGE));
      for (const value of [undefined, 'mauvais']) {
        const req = request(app).get('/api/health').set('X-Forwarded-For', FORGED).set('X-Forwarded-Proto', 'https');
        if (value !== undefined) req.set('X-Raijin-Edge', value);
        const res = await req.expect(200);
        expect(res.body.ip).not.toBe(FORGED);
        expect(res.body.ip).toMatch(/127\.0\.0\.1|::1/);
        expect(res.body.protocol).toBe('http');
        expect(res.body.edge).toBeNull();
      }
      await request(app).get('/api/echo').set('X-Forwarded-For', FORGED).expect(403);
    });

    it('pris en compte avec l’en-tête valide, qui est retiré de la requête', async () => {
      const res = await request(appWith(edgeSecretDigest(EDGE)))
        .get('/api/echo')
        .set('X-Raijin-Edge', EDGE)
        .set('X-Forwarded-For', FORGED)
        .expect(200);
      expect(res.body).toMatchObject({ ip: FORGED, edge: null });
    });

    it('contrôle désactivé : trust proxy inchangé, en-tête retiré quand même', async () => {
      const res = await request(appWith(null)).get('/api/echo').set('X-Raijin-Edge', 'peu importe').set('X-Forwarded-For', FORGED).expect(200);
      expect(res.body).toMatchObject({ ip: FORGED, edge: null });
    });
  });

  it('comparaison : valeurs non chaînes, vides ou répétées refusées', () => {
    const digest = edgeSecretDigest(EDGE);
    expect(isValidEdgeHeader(EDGE, digest)).toBe(true);
    for (const value of [undefined, null, '', [EDGE], `${EDGE}, ${EDGE}`, 42]) expect(isValidEdgeHeader(value, digest)).toBe(false);
  });
});
