import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { ANALYSIS_DISCLAIMER, ANALYSIS_ERROR_MESSAGES } from '@raijin/shared-contracts';
import { FAKE_MINTS, fakeAnalysis, fakeAnalysisResponse, fakeQuota } from '@raijin/web-data-access';
import { API, button, expectRequest, query, queryAll, root, settle, setupFeature, submitForm, typeInput, waitFor } from '../testing/harness';
import { NavigationStart } from '@angular/router';
import { AnalysePage, quotaText } from './analyse.page';
import { publicPageMeta } from './public-token.page';

vi.setConfig({ testTimeout: 30_000 });

describe('quotaText', () => {
  it('reste, épuisé, illimité', () => {
    expect(quotaText(fakeQuota())).toBe('Il te reste 2 analyses sur 3 aujourd’hui.');
    expect(quotaText(fakeQuota({ remaining: 1, used: 2 }))).toBe('Il te reste 1 analyse sur 3 aujourd’hui.');
    expect(quotaText(fakeQuota({ remaining: 0, used: 3 }))).toContain('minuit');
    expect(quotaText(fakeQuota({ limit: null, remaining: null, subject: 'user', plan: 'PRO' }))).toContain('illimitées');
  });
});

describe('AnalysePage', () => {
  async function open(url = '/analyse') {
    const setup = await setupFeature();
    await setup.harness.navigateByUrl(url);
    // Le quota part après le rendu, à l'inactivité, et seulement sans analyse en cours.
    if (url === '/analyse') (await expectRequest(setup.ctrl, `${API}/analyses/quota`)).flush(fakeQuota());
    await settle();
    setup.harness.detectChanges();
    return setup;
  }

  it('état vide : Rai bravo, champ 16 px avec Coller, une seule action jaune', async () => {
    const { harness } = await open();
    expect(query(harness, 'h1')?.textContent).toContain('Analyser un token');
    expect(query(harness, 'rj-empty-state img')?.getAttribute('src')).toContain('rai-bravo.svg');
    const input = query<HTMLInputElement>(harness, 'input[name="token"]');
    expect(input?.className).toContain('text-input');
    expect(input?.getAttribute('inputmode')).toBe('url');
    expect(button(harness, 'Coller')).toBeDefined();
    expect(queryAll(harness, '.bg-thunder')).toHaveLength(1);
    expect(query(harness, '[data-quota]')?.textContent).toContain('Il te reste 2 analyses');
  });

  it('lien DexScreener collé : adresse extraite et affichée', async () => {
    const { harness } = await open();
    typeInput(harness, `https://dexscreener.com/solana/${FAKE_MINTS.warn}?maker=x`);
    await harness.fixture.whenStable();
    const preview = query(harness, '[data-preview]')?.textContent ?? '';
    expect(preview).toContain('Adresse reconnue dans le lien DexScreener');
    expect(preview).toContain('EF3mFc…H3zBTR');
    expect(preview).toContain('paire');
  });

  it('saisie invalide : message sur le champ, aucun appel', async () => {
    const { harness, ctrl } = await open();
    typeInput(harness, 'https://exemple.com/pas-un-token');
    submitForm(harness);
    await harness.fixture.whenStable();
    expect(query(harness, 'input[name="token"]')?.getAttribute('aria-invalid')).toBe('true');
    expect(root(harness).textContent).toContain(ANALYSIS_ERROR_MESSAGES.MINT_INVALID);
    ctrl.expectNone(`${API}/analyses`);
  });

  it('analyse : chargement animé, puis résultat et URL /analyse/<mint>', async () => {
    const { harness, ctrl, router } = await open();
    typeInput(harness, FAKE_MINTS.safe);
    submitForm(harness);
    await harness.fixture.whenStable();
    expect(query(harness, 'rj-analysis-loading [role="status"]')?.textContent).toContain('Analyse en cours');
    expect(query(harness, 'rj-shield-scan')).not.toBeNull();
    const req = ctrl.expectOne(`${API}/analyses`);
    expect(req.request.body).toEqual({ input: FAKE_MINTS.safe });
    req.flush(fakeAnalysisResponse('safe', { remaining: 1, used: 2 }));
    await waitFor(() => router.url === `/analyse/${FAKE_MINTS.safe}`);
    await harness.fixture.whenStable();
    expect(router.url).toBe(`/analyse/${FAKE_MINTS.safe}`);
    expect(query(harness, '[data-verdict-block]')?.textContent).toContain('Sain');
    expect(root(harness).textContent).toContain(ANALYSIS_DISCLAIMER);
    expect(query(harness, '[data-quota]')?.textContent).toContain('Il te reste 1 analyse');
    expect(queryAll(harness, '.bg-thunder')).toHaveLength(1);
    expect(TestBed.inject(Title).getTitle()).toBe('Sain · Kitsune Inu — Raijin');
    ctrl.expectNone(`${API}/analyses`);
  });

  it('ordre défavorable : un effet « sans mint » pendant la navigation vers /analyse/<mint> n’efface pas le résultat', async () => {
    const { harness, ctrl, router } = await open();
    const page = harness.routeDebugElement?.componentInstance as AnalysePage;
    typeInput(harness, `https://solscan.io/token/${FAKE_MINTS.safe}`);
    submitForm(harness);
    ctrl.expectOne(`${API}/analyses`).flush(fakeAnalysisResponse('safe'));
    // Effet de l'écran rejoué sans mint au moment où la navigation vers /analyse/<mint> démarre.
    let replayed = false;
    const sub = router.events.subscribe((event) => {
      if (event instanceof NavigationStart && !replayed) {
        replayed = true;
        page['onRouteMint'](undefined);
      }
    });
    await waitFor(() => router.url === `/analyse/${FAKE_MINTS.safe}`);
    sub.unsubscribe();
    expect(replayed).toBe(true);
    // Et une fois arrivé : un effet tardif sans mint ne vide rien non plus.
    page['onRouteMint'](undefined);
    await harness.fixture.whenStable();
    expect(query(harness, '[data-verdict-block]')?.textContent).toContain('Sain');
    expect(query<HTMLInputElement>(harness, 'input[name="token"]')?.value).toBe(FAKE_MINTS.safe);
    ctrl.expectNone(`${API}/analyses`);
  });

  it('retour sur /analyse : état vide', async () => {
    const { harness, ctrl, router } = await open(`/analyse/${FAKE_MINTS.safe}`);
    ctrl.expectOne(`${API}/analyses`).flush(fakeAnalysisResponse('safe'));
    await settle();
    await router.navigateByUrl('/analyse');
    await harness.fixture.whenStable();
    expect(query(harness, 'rj-empty-state')).not.toBeNull();
    ctrl.match(`${API}/analyses/quota`).forEach((r) => r.flush(fakeQuota()));
  });

  it('accès direct à /analyse/<mint> : analyse lancée', async () => {
    const { harness, ctrl } = await open(`/analyse/${FAKE_MINTS.danger}`);
    ctrl.expectOne(`${API}/analyses`).flush(fakeAnalysisResponse('danger'));
    await settle();
    // Verdict rendu dans une tâche à part du démarrage (`nextTask`, AnalysisStore).
    await settle();
    await harness.fixture.whenStable();
    expect(query(harness, '[data-verdict-block]')?.textContent).toContain('Danger');
    expect(query<HTMLInputElement>(harness, 'input[name="token"]')?.value).toBe(FAKE_MINTS.danger);
  });

  it('adresse invalide dans l’URL : message sur le champ, aucun appel', async () => {
    const { harness, ctrl } = await open('/analyse/pas-une-adresse');
    await harness.fixture.whenStable();
    expect(query(harness, 'input[name="token"]')?.getAttribute('aria-invalid')).toBe('true');
    ctrl.expectNone(`${API}/analyses`);
  });

  it('erreur : Rai alerte et Réessayer relance l’analyse', async () => {
    const { harness, ctrl } = await open();
    typeInput(harness, FAKE_MINTS.safe);
    submitForm(harness);
    ctrl.expectOne(`${API}/analyses`).flush({ code: 'UPSTREAM_UNAVAILABLE', message: 'x' }, { status: 503, statusText: 'x' });
    await waitFor(() => (harness.detectChanges(), query(harness, '[role="alert"]') !== null));
    expect(query(harness, '[role="alert"] img')?.getAttribute('src')).toContain('rai-alerte.svg');
    expect(root(harness).textContent).toContain(ANALYSIS_ERROR_MESSAGES.UPSTREAM_UNAVAILABLE);
    button(harness, 'Réessayer')?.click();
    ctrl.expectOne(`${API}/analyses`).flush(fakeAnalysisResponse('safe'));
    await settle();
  });

  it('quota dépassé : message utile, sans urgence, lien vers un compte gratuit', async () => {
    const { harness, ctrl } = await open();
    typeInput(harness, FAKE_MINTS.safe);
    submitForm(harness);
    ctrl.expectOne(`${API}/analyses`).flush({ code: 'QUOTA_EXCEEDED', message: 'x' }, { status: 429, statusText: 'x' });
    await waitFor(() => (harness.detectChanges(), (root(harness).textContent ?? '').includes('Quota du jour atteint')));
    const text = root(harness).textContent ?? '';
    expect(text).toContain('Quota du jour atteint');
    expect(text).toContain(ANALYSIS_ERROR_MESSAGES.QUOTA_EXCEEDED);
    expect(query(harness, 'a[href="/compte/inscription"]')).not.toBeNull();
    expect(query(harness, '[role="alert"]')).toBeNull();
    expect(text).not.toMatch(/dépêche|dernière chance/i);
  });
});

describe('PublicTokenPage', () => {
  it('dernière analyse publiée : rendu en lecture, CTA, titre et description', async () => {
    const { harness, ctrl } = await setupFeature();
    await harness.navigateByUrl(`/t/${FAKE_MINTS.warn}`);
    expect(query(harness, 'rj-analysis-loading')).not.toBeNull();
    ctrl.expectOne(`${API}/analyses/${FAKE_MINTS.warn}/latest`).flush(fakeAnalysis('warn'));
    await settle();
    // Verdict rendu dans une tâche à part du démarrage (`nextTask`, AnalysisStore).
    await settle();
    await harness.fixture.whenStable();
    expect(query(harness, '[data-verdict-block]')?.textContent).toContain('Prudence');
    const cta = queryAll(harness, 'a').find((a) => a.textContent?.includes('Analyser un autre token'));
    expect(cta?.getAttribute('href')).toBe('/analyse');
    expect(cta?.className).toContain('bg-thunder');
    expect(queryAll(harness, '.bg-thunder')).toHaveLength(1);
    expect(root(harness).textContent).toContain(ANALYSIS_DISCLAIMER);
    expect(TestBed.inject(Title).getTitle()).toBe('Verdict Prudence pour « Raiden Frog » — Raijin Shield');
    expect(TestBed.inject(Meta).getTag('name="description"')?.content).toContain('pas un conseil en investissement');
    expect(TestBed.inject(Meta).getTag('property="og:url"')?.content).toContain(`/t/${FAKE_MINTS.warn}`);
  });

  it('aucune analyse récente : état vide et « Analyser ce token »', async () => {
    const { harness, ctrl } = await setupFeature();
    await harness.navigateByUrl(`/t/${FAKE_MINTS.safe}`);
    ctrl
      .expectOne(`${API}/analyses/${FAKE_MINTS.safe}/latest`)
      .flush({ code: 'ANALYSIS_NOT_FOUND', message: 'x' }, { status: 404, statusText: 'x' });
    await waitFor(() => (harness.detectChanges(), query(harness, 'rj-empty-state') !== null));
    expect(query(harness, 'rj-empty-state h2')?.textContent).toContain('Pas encore d’analyse récente');
    const cta = queryAll(harness, 'a').find((a) => a.textContent?.includes('Analyser ce token'));
    expect(cta?.getAttribute('href')).toBe(`/analyse/${FAKE_MINTS.safe}`);
  });

  it('adresse invalide : aucun appel', async () => {
    const { harness, ctrl } = await setupFeature();
    await harness.navigateByUrl('/t/%3Cscript%3E');
    await harness.fixture.whenStable();
    expect(root(harness).textContent).toContain('Adresse non reconnue');
    ctrl.expectNone(() => true);
  });

  it('titre de partage : nom non fiable entre guillemets', () => {
    expect(publicPageMeta(fakeAnalysis('danger')).title).toBe('Verdict Danger pour « Pepe Thunder » — Raijin Shield');
  });
});
