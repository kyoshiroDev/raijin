import { testConfig } from '@raijin/api-core';
import type { Request, Response } from 'express';
import type { AnalysisService } from '../analysis/analysis.service';
import { FIXTURE_MINTS } from '../fixtures/fixture-facts-collector';
import type { OgImageService } from '../og/og-image.service';
import type { QuotaService } from '../quota/quota.service';
import type { SharePageService } from '../share/share-page.service';
import { AnalysisController } from './analysis.controller';
import { MintParamPipe, parseMint } from './mint-param.pipe';
import { ShareController, sharePageCsp } from './share.controller';

interface FakeResponse {
  headers: Record<string, string>;
  statusCode: number;
  body: unknown;
  setHeader: jest.Mock;
  status: jest.Mock;
  send: jest.Mock;
  end: jest.Mock;
}

function fakeResponse(): FakeResponse {
  const res: FakeResponse = {
    headers: {} as Record<string, string>,
    statusCode: 0,
    body: undefined as unknown,
    setHeader: jest.fn((name: string, value: string) => {
      res.headers[name] = value;
    }),
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    send: jest.fn((body: unknown) => {
      res.body = body;
    }),
    end: jest.fn(),
  };
  return res;
}

describe('MintParamPipe', () => {
  it('400 MINT_INVALID pour une adresse invalide', () => {
    expect(new MintParamPipe().transform(FIXTURE_MINTS.safe)).toBe(FIXTURE_MINTS.safe);
    expect(() => new MintParamPipe().transform('<script>')).toThrow(expect.objectContaining({ code: 'MINT_INVALID' }));
    expect(parseMint('0OIl')).toBeNull();
  });
});

describe('AnalysisController', () => {
  const analyses = { analyze: jest.fn(), latest: jest.fn() };
  const quota = { resolvePolicy: jest.fn(async () => ({})), info: jest.fn(async () => ({ remaining: 3 })) };
  const controller = new AnalysisController(analyses as unknown as AnalysisService, quota as unknown as QuotaService);
  const client = { ip: '203.0.113.9', userAgent: null };

  it('anonyme : quota par IP ; connecté : par utilisateur ; temps mesuré dans Server-Timing', async () => {
    analyses.analyze.mockResolvedValue({ response: { analysis: {}, quota: {} }, durationMs: 41.7 });
    const res = fakeResponse();
    await controller.analyze({ input: FIXTURE_MINTS.safe }, null, client, res as unknown as Response);
    expect(analyses.analyze).toHaveBeenLastCalledWith(FIXTURE_MINTS.safe, { kind: 'anonymous', ip: '203.0.113.9' });
    expect(res.headers['Server-Timing']).toBe('analysis;dur=42');
    const auth = { userId: 'u1', sessionId: 's', role: 'USER' as const, accessTokenExpiresAt: new Date() };
    await controller.analyze({ input: FIXTURE_MINTS.safe }, auth, client, fakeResponse() as unknown as Response);
    expect(analyses.analyze).toHaveBeenLastCalledWith(FIXTURE_MINTS.safe, { kind: 'user', userId: 'u1' });
  });

  it('quota restant et dernière analyse', async () => {
    await expect(controller.remaining(null, client)).resolves.toEqual({ remaining: 3 });
    expect(quota.resolvePolicy).toHaveBeenCalledWith({ kind: 'anonymous', ip: '203.0.113.9' });
    analyses.latest.mockResolvedValue({ verdict: 'safe' });
    await expect(controller.latest(FIXTURE_MINTS.safe)).resolves.toEqual({ verdict: 'safe' });
  });
});

describe('ShareController', () => {
  const pages = { render: jest.fn(async () => '<html></html>') };
  const images = {
    imageFor: jest.fn(async () => ({ png: Buffer.from('png'), etag: '"abc"' })),
    generic: jest.fn(async () => ({ png: Buffer.from('gen'), etag: '"gen"' })),
  };
  const config = testConfig({ API_URL: 'https://api.raijinshield.com' });
  const controller = new ShareController(pages as unknown as SharePageService, images as unknown as OgImageService, config);

  it('page publique : HTML, CSP du document de l’app, mint invalide → page générique', async () => {
    const res = fakeResponse();
    await controller.page(FIXTURE_MINTS.safe, res as unknown as Response);
    expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(res.headers['Content-Security-Policy']).toBe(sharePageCsp('https://api.raijinshield.com'));
    expect(res.headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(res.statusCode).toBe(200);
    await controller.page('<script>', fakeResponse() as unknown as Response);
    expect(pages.render).toHaveBeenLastCalledWith(null);
  });

  it('image OG : PNG, cache public, ETag/304, mint invalide → image générique', async () => {
    const res = fakeResponse();
    await controller.image(FIXTURE_MINTS.safe, { headers: {} } as Request, res as unknown as Response);
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.headers['Cache-Control']).toBe('public, max-age=600');
    expect(res.statusCode).toBe(200);
    const cached = fakeResponse();
    await controller.image(FIXTURE_MINTS.safe, { headers: { 'if-none-match': '"abc"' } } as unknown as Request, cached as unknown as Response);
    expect(cached.statusCode).toBe(304);
    await controller.image('pas-un-mint', { headers: {} } as Request, fakeResponse() as unknown as Response);
    expect(images.generic).toHaveBeenCalled();
  });
});
