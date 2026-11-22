import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ANALYSIS_ERROR_MESSAGES, analysisResultSchema } from '@raijin/shared-contracts';
import { loadContracts } from '../contracts';
import { FAKE_MINTS, fakeAnalysis, fakeAnalysisResponse, fakeQuota } from '../testing/analysis-fixtures';
import { toAnalysisError } from './analysis-errors';
import { AnalysisPrefetch } from './analysis-prefetch';
import { AnalysisStore } from './analysis.store';

const API = '/api/v1';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup() {
  await loadContracts();
  TestBed.configureTestingModule({
    providers: [AnalysisStore, provideHttpClient(), provideHttpClientTesting()],
  });
  return { store: TestBed.inject(AnalysisStore), ctrl: TestBed.inject(HttpTestingController) };
}

describe('fixtures d’analyse', () => {
  it.each(['safe', 'warn', 'danger', 'degraded'] as const)('%s respecte analysisResultSchema', (scenario) => {
    expect(analysisResultSchema.safeParse(fakeAnalysis(scenario)).success).toBe(true);
  });
});

describe('AnalysisStore', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('POST /analyses { input } puis résultat et quota', async () => {
    const { store, ctrl } = await setup();
    expect(store.status()).toBe('idle');
    const done = store.analyze(`  https://dexscreener.com/solana/${FAKE_MINTS.warn}  `);
    expect(store.status()).toBe('loading');
    const req = ctrl.expectOne(`${API}/analyses`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ input: `https://dexscreener.com/solana/${FAKE_MINTS.warn}` });
    req.flush(fakeAnalysisResponse('warn', { remaining: 1, used: 2 }));
    expect(await done).toBe(true);
    expect(store.status()).toBe('ready');
    expect(store.result()?.verdict).toBe('warn');
    expect(store.quota()?.remaining).toBe(1);
  });

  it('nettoie à nouveau un nom hostile (contrats rejoués côté front)', async () => {
    const { store, ctrl } = await setup();
    const done = store.analyze(FAKE_MINTS.safe);
    const response = fakeAnalysisResponse('safe');
    const hostile = { ...response, analysis: { ...response.analysis, token: { ...response.analysis.token, name: 'Bon\u202eToken\u200b<img src=x onerror=alert(1)>' } } };
    ctrl.expectOne(`${API}/analyses`).flush(hostile);
    await done;
    const name = store.result()?.token.name ?? '';
    expect(name).not.toMatch(/[\u202e\u200b]/);
    expect(name.length).toBeLessThanOrEqual(64);
  });

  it('réponse hors contrat : erreur interne, pas de résultat', async () => {
    const { store, ctrl } = await setup();
    const done = store.analyze(FAKE_MINTS.safe);
    ctrl.expectOne(`${API}/analyses`).flush({ analysis: { verdict: 'safe' }, quota: fakeQuota() });
    expect(await done).toBe(false);
    expect(store.status()).toBe('error');
    expect(store.error()?.code).toBe('INTERNAL_ERROR');
    expect(store.result()).toBeNull();
    ctrl.expectOne(`${API}/analyses/quota`).flush(fakeQuota());
  });

  it.each([
    ['MINT_INVALID', 400],
    ['TOKEN_NOT_FOUND', 404],
    ['UPSTREAM_UNAVAILABLE', 503],
  ] as const)('erreur %s : message de l’analyse', async (code, status) => {
    const { store, ctrl } = await setup();
    const done = store.analyze(FAKE_MINTS.safe);
    ctrl.expectOne(`${API}/analyses`).flush({ code, message: 'texte brut du serveur' }, { status, statusText: 'x' });
    await done;
    expect(store.error()).toEqual({ code, message: ANALYSIS_ERROR_MESSAGES[code], status });
    ctrl.expectOne(`${API}/analyses/quota`).flush(fakeQuota());
  });

  it('erreur sans quota connu (ex. TOKEN_NOT_FOUND) : quota demandé une seule fois et affiché', async () => {
    const { store, ctrl } = await setup();
    const done = store.analyze(FAKE_MINTS.safe);
    ctrl.expectOne(`${API}/analyses`).flush({ code: 'TOKEN_NOT_FOUND', message: 'x' }, { status: 404, statusText: 'x' });
    await done;
    // Appel concurrent (écran à l'inactivité) : même requête partagée.
    const again = store.refreshQuota();
    ctrl.expectOne(`${API}/analyses/quota`).flush(fakeQuota({ used: 0, remaining: 3 }));
    await again;
    expect(store.quota()?.remaining).toBe(3);
    // Quota connu : une nouvelle erreur ne le redemande pas.
    const retry = store.analyze(FAKE_MINTS.safe);
    ctrl.expectOne(`${API}/analyses`).flush({ code: 'TOKEN_NOT_FOUND', message: 'x' }, { status: 404, statusText: 'x' });
    await retry;
    ctrl.expectNone(`${API}/analyses/quota`);
  });

  it('requête de démarrage (AnalysisPrefetch) : réclamée une fois pour la même saisie, jamais rejouée', async () => {
    const { store, ctrl } = await setup();
    const prefetch = TestBed.inject(AnalysisPrefetch);
    prefetch.start(FAKE_MINTS.warn);
    const req = ctrl.expectOne(`${API}/analyses`);
    const done = store.analyze(FAKE_MINTS.warn);
    ctrl.expectNone(`${API}/analyses`);
    req.flush(fakeAnalysisResponse('warn', { remaining: 2, used: 1 }));
    expect(await done).toBe(true);
    expect(store.result()?.verdict).toBe('warn');
    expect(store.quota()?.remaining).toBe(2);
    // Déjà réclamée : la suivante repart sur une requête normale ; autre saisie : ignorée.
    expect(prefetch.take(FAKE_MINTS.warn)).toBeNull();
    prefetch.start(FAKE_MINTS.warn);
    ctrl.expectOne(`${API}/analyses`).flush(fakeAnalysisResponse('warn'));
    expect(prefetch.take(FAKE_MINTS.safe)).toBeNull();
  });

  it('quota dépassé : quota connu ramené à 0', async () => {
    const { store, ctrl } = await setup();
    const quota = store.refreshQuota();
    ctrl.expectOne(`${API}/analyses/quota`).flush(fakeQuota({ used: 2, remaining: 1 }));
    await quota;
    await settle();
    expect(store.quota()?.remaining).toBe(1);
    const done = store.analyze(FAKE_MINTS.safe);
    ctrl.expectOne(`${API}/analyses`).flush({ code: 'QUOTA_EXCEEDED', message: 'x' }, { status: 429, statusText: 'x' });
    await done;
    expect(store.quotaExhausted()).toBe(true);
    expect(store.quota()?.remaining).toBe(0);
    expect(store.error()?.message).toBe(ANALYSIS_ERROR_MESSAGES.QUOTA_EXCEEDED);
  });

  it('quota indisponible : aucune erreur affichée', async () => {
    const { store, ctrl } = await setup();
    const quota = store.refreshQuota();
    ctrl.expectOne(`${API}/analyses/quota`).flush(null, { status: 500, statusText: 'x' });
    await quota;
    expect(store.quota()).toBeNull();
    expect(store.status()).toBe('idle');
  });

  it('une réponse périmée est ignorée', async () => {
    const { store, ctrl } = await setup();
    const first = store.analyze(FAKE_MINTS.safe);
    const second = store.analyze(FAKE_MINTS.danger);
    const [r1, r2] = ctrl.match(`${API}/analyses`);
    r2?.flush(fakeAnalysisResponse('danger'));
    await second;
    r1?.flush(fakeAnalysisResponse('safe'));
    expect(await first).toBe(false);
    expect(store.result()?.verdict).toBe('danger');
  });

  it('GET /analyses/:mint/latest (résultat seul ou enveloppé)', async () => {
    const { store, ctrl } = await setup();
    let done = store.loadLatest(FAKE_MINTS.danger);
    ctrl.expectOne(`${API}/analyses/${FAKE_MINTS.danger}/latest`).flush(fakeAnalysis('danger'));
    expect(await done).toBe(true);
    expect(store.result()?.verdict).toBe('danger');
    done = store.loadLatest(FAKE_MINTS.safe);
    ctrl.expectOne(`${API}/analyses/${FAKE_MINTS.safe}/latest`).flush({ analysis: fakeAnalysis('safe') });
    expect(await done).toBe(true);
    expect(store.result()?.verdict).toBe('safe');
  });

  it('page publique : ANALYSIS_NOT_FOUND', async () => {
    const { store, ctrl } = await setup();
    const done = store.loadLatest(FAKE_MINTS.safe);
    ctrl
      .expectOne(`${API}/analyses/${FAKE_MINTS.safe}/latest`)
      .flush({ code: 'ANALYSIS_NOT_FOUND', message: 'x' }, { status: 404, statusText: 'x' });
    await done;
    expect(store.error()?.code).toBe('ANALYSIS_NOT_FOUND');
  });

  it('erreur locale puis reset', async () => {
    const { store } = await setup();
    store.setLocalError(toAnalysisError(new Error('x')));
    expect(store.status()).toBe('error');
    store.reset();
    expect(store.status()).toBe('idle');
    expect(store.error()).toBeNull();
  });
});
