import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { takeEarlyStartup } from '../startup-prefetch';
import { FAKE_MINTS, fakeAnalysisResponse } from '../testing/analysis-fixtures';
import { AnalysisPrefetch, type EarlyAnalysis } from './analysis-prefetch';
import { sameData } from './analysis.store';

const API = '/api/v1';

function taken(prefetch: AnalysisPrefetch) {
  const response = prefetch.take(FAKE_MINTS.safe);
  if (!response) throw new Error('requête de démarrage absente');
  return response;
}

function setup() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  return { prefetch: TestBed.inject(AnalysisPrefetch), ctrl: TestBed.inject(HttpTestingController) };
}

describe('AnalysisPrefetch.adopt (requête partie avant Angular)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('réponse 2xx remise telle quelle, sans seconde requête', async () => {
    const { prefetch } = setup();
    const body = fakeAnalysisResponse('safe');
    prefetch.adopt(FAKE_MINTS.safe, Date.now(), Promise.resolve<EarlyAnalysis>({ status: 200, body }));
    const response = prefetch.take(FAKE_MINTS.safe);
    if (!response) throw new Error('requête de démarrage absente');
    expect(await firstValueFrom(response)).toEqual(body);
  });

  it('erreur métier (429) reprise en HttpErrorResponse', async () => {
    const { prefetch } = setup();
    const body = { code: 'QUOTA_EXCEEDED', message: 'limite' };
    prefetch.adopt(FAKE_MINTS.safe, Date.now(), Promise.resolve<EarlyAnalysis>({ status: 429, body }));
    const error = await firstValueFrom(taken(prefetch)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpErrorResponse);
    expect(error).toMatchObject({ status: 429, error: body });
  });

  it.each([401, 403, 503])('statut %i : requête normale à la place (intercepteurs)', async (status) => {
    const { prefetch, ctrl } = setup();
    prefetch.adopt(FAKE_MINTS.safe, Date.now(), Promise.resolve<EarlyAnalysis>({ status, body: null }));
    const result = firstValueFrom(taken(prefetch));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const req = ctrl.expectOne(`${API}/analyses`);
    expect(req.request.body).toEqual({ input: FAKE_MINTS.safe });
    req.flush(fakeAnalysisResponse('warn'));
    expect(await result).toEqual(fakeAnalysisResponse('warn'));
  });

  it('CSRF ou réseau en échec : requête normale', async () => {
    const { prefetch, ctrl } = setup();
    prefetch.adopt(FAKE_MINTS.safe, Date.now(), Promise.reject(new Error('csrf')));
    const result = firstValueFrom(taken(prefetch));
    await new Promise((resolve) => setTimeout(resolve, 0));
    ctrl.expectOne(`${API}/analyses`).flush(fakeAnalysisResponse('safe'));
    expect(await result).toEqual(fakeAnalysisResponse('safe'));
  });
});

describe('AnalysisPrefetch.adoptLatest (page publique)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('2xx : résultat déballé, sans seconde requête ; mint différent : rien', async () => {
    const { prefetch } = setup();
    const analysis = fakeAnalysisResponse('safe').analysis;
    prefetch.adoptLatest(FAKE_MINTS.safe, Date.now(), Promise.resolve<EarlyAnalysis>({ status: 200, body: { analysis } }));
    expect(prefetch.takeLatest(FAKE_MINTS.warn)).toBeNull();
    prefetch.adoptLatest(FAKE_MINTS.safe, Date.now(), Promise.resolve<EarlyAnalysis>({ status: 200, body: analysis }));
    const response = prefetch.takeLatest(FAKE_MINTS.safe);
    if (!response) throw new Error('lecture de démarrage absente');
    expect(await firstValueFrom(response)).toEqual(analysis);
  });

  it('404 repris ; 503 : lecture normale', async () => {
    const { prefetch, ctrl } = setup();
    const body = { code: 'ANALYSIS_NOT_FOUND', message: 'absente' };
    prefetch.adoptLatest(FAKE_MINTS.safe, Date.now(), Promise.resolve<EarlyAnalysis>({ status: 404, body }));
    const notFound = prefetch.takeLatest(FAKE_MINTS.safe);
    if (!notFound) throw new Error('lecture de démarrage absente');
    expect(await firstValueFrom(notFound).catch((e: unknown) => e)).toMatchObject({ status: 404, error: body });

    prefetch.adoptLatest(FAKE_MINTS.safe, Date.now(), Promise.resolve<EarlyAnalysis>({ status: 503, body: null }));
    const retried = prefetch.takeLatest(FAKE_MINTS.safe);
    if (!retried) throw new Error('lecture de démarrage absente');
    const result = firstValueFrom(retried);
    await new Promise((resolve) => setTimeout(resolve, 0));
    ctrl.expectOne(`${API}/analyses/${FAKE_MINTS.safe}/latest`).flush(fakeAnalysisResponse('warn').analysis);
    expect(await result).toEqual(fakeAnalysisResponse('warn').analysis);
  });
});

describe('takeEarlyStartup', () => {
  it('lit puis efface window.__rjStartup, et refuse une forme inattendue', () => {
    const view = {} as Window & { __rjStartup?: unknown };
    const csrf = Promise.resolve('x'.repeat(40));
    const analysis = Promise.resolve({ status: 200, body: {} });
    view.__rjStartup = { kind: 'analyse', mint: FAKE_MINTS.safe, startedAt: 1, csrf, analysis };
    expect(takeEarlyStartup(view)).toMatchObject({ kind: 'analyse', mint: FAKE_MINTS.safe, csrf, analysis });
    expect('__rjStartup' in view).toBe(false);
    view.__rjStartup = { kind: 'latest', mint: FAKE_MINTS.safe, startedAt: 1, latest: analysis };
    expect(takeEarlyStartup(view)).toMatchObject({ kind: 'latest', latest: analysis });
    view.__rjStartup = { kind: 'analyse', mint: FAKE_MINTS.safe, startedAt: 1, csrf: 'jeton', analysis };
    expect(takeEarlyStartup(view)).toBeNull();
    view.__rjStartup = { kind: 'latest', mint: FAKE_MINTS.safe, startedAt: 1 };
    expect(takeEarlyStartup(view)).toBeNull();
    expect(takeEarlyStartup(null)).toBeNull();
  });
});

describe('sameData', () => {
  it('compare les données sans tenir compte de l’ordre des clés', () => {
    expect(sameData({ a: 1, b: [1, { c: 'x' }] }, { b: [1, { c: 'x' }], a: 1 })).toBe(true);
    expect(sameData({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(sameData({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameData([1, 2], [1])).toBe(false);
    expect(sameData({ a: [] }, { a: {} })).toBe(false);
  });
});
