import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { BILLING_ERROR_MESSAGES, type PublicUser } from '@raijin/shared-contracts';
import {
  AUTH_INTERCEPTORS,
  AuthStore,
  BILLING_LOCATION,
  CSRF_ANON,
  CsrfToken,
  FIXTURE_MINTS,
  fakeBillingAccount,
  fakeBillingPlans,
  fakeProAccount,
  fakeSession,
  fakeTrialAccount,
  fakeTrialRecap,
  fakeWatch,
  fakeWatchId,
  fakeWatchList,
  loadContracts,
} from '@raijin/web-data-access';
import { RjToastService } from '@raijin/web-ui';
import { DISCLAIMER } from '../shared/links';
import { webFeatureAbonnementRoutes } from './abonnement.routes';
import { entitlementLines, formatPrice, planStatus } from './billing-texts';
import { SUCCESS_POLL_MAX_MS } from './checkout-success.page';
import { REDIRECT_REFUSED_MESSAGE } from './subscription.page';

const API = '/api/v1';
const ORIGIN = 'http://localhost:4200';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

@Component({ template: '<h1>Autre écran</h1>' })
class Blank {}

async function setup(auth: 'anonymous' | 'authenticated', user: Partial<PublicUser> = {}) {
  await loadContracts();
  const location = { origin: ORIGIN, assign: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideRouter(
        [
          { path: 'abonnement', children: webFeatureAbonnementRoutes },
          { path: 'analyse', component: Blank },
          { path: 'suivis', component: Blank },
          { path: 'compte/connexion', component: Blank },
          { path: 'compte/verifier-email', component: Blank },
        ],
        withComponentInputBinding(),
      ),
      provideHttpClient(withInterceptors([...AUTH_INTERCEPTORS])),
      provideHttpClientTesting(),
      { provide: BILLING_LOCATION, useValue: location },
    ],
  });
  const store = TestBed.inject(AuthStore);
  if (auth === 'authenticated') store.applySession(fakeSession(user));
  else {
    store.clear();
    TestBed.inject(CsrfToken).set(CSRF_ANON);
  }
  store.whenReady = () => Promise.resolve();
  store.reloadUser = () => Promise.resolve();
  const toasts = TestBed.inject(RjToastService);
  const show = vi.spyOn(toasts, 'show');
  const harness = await RouterTestingHarness.create();
  const ctrl = TestBed.inject(HttpTestingController);
  const root = () => harness.routeNativeElement as HTMLElement;
  const q = <T extends Element = HTMLElement>(selector: string) => root().querySelector<T>(selector);
  return { harness, ctrl, location, show, root, q, router: TestBed.inject(Router) };
}

type Env = Awaited<ReturnType<typeof setup>>;

async function waitFor(predicate: () => boolean, tries = 300): Promise<void> {
  for (let i = 0; i < tries && !predicate(); i++) await settle();
  expect(predicate()).toBe(true);
}

async function expectRequest(ctrl: HttpTestingController, url: string): Promise<TestRequest> {
  let found: TestRequest[] = [];
  for (let i = 0; i < 300 && found.length === 0; i++) {
    found = ctrl.match(url);
    if (found.length === 0) await settle();
  }
  expect(found).toHaveLength(1);
  return found[0] as TestRequest;
}

async function stable(env: Env): Promise<void> {
  await settle();
  await env.harness.fixture.whenStable();
}

const primaries = (env: Env) => env.root().querySelectorAll('.bg-thunder');

async function openSubscription(env: Env, url = '/abonnement', account: ReturnType<typeof fakeBillingAccount> | null = fakeTrialAccount(3), plans = fakeBillingPlans()) {
  void env.harness.navigateByUrl(url);
  (await expectRequest(env.ctrl, `${API}/billing/plans`)).flush(plans);
  if (account) (await expectRequest(env.ctrl, `${API}/billing/subscription`)).flush(account);
  await waitFor(() => env.q('[data-plan="PRO"]') !== null);
  await stable(env);
}

describe('textes de l’abonnement', () => {
  it('formate les centimes en fr-FR depuis la devise de l’API', () => {
    expect(formatPrice(1490, 'EUR')).toBe('14,90 €');
    expect(formatPrice(14900, 'EUR')).toBe('149 €');
  });

  it('liste les droits renvoyés par l’API (icône + texte)', () => {
    const free = entitlementLines(fakeBillingPlans().free.entitlements);
    expect(free.map((line) => line.text)).toContain('5 analyses par jour');
    expect(free.find((line) => line.text === 'Scan de wallet')?.included).toBe(false);
    expect(entitlementLines(fakeBillingPlans().pro.entitlements)[0]?.text).toBe('Analyses illimitées');
  });

  it('statut : actif, retard de paiement, résiliation en fin de période', () => {
    expect(planStatus(fakeProAccount()).tone).toBe('safe');
    expect(planStatus(fakeProAccount({ status: 'past_due' }, { paymentIssue: true })).detail).toContain('Pro reste actif');
    expect(planStatus(fakeProAccount({ cancelAtPeriodEnd: true })).detail).toContain('Résiliation programmée');
  });

  it('statut : Pro offert par l’admin (source gift)', () => {
    const gift = planStatus(fakeProAccount({}, { source: 'gift', subscription: null, giftEndsAt: '2026-12-22T00:00:00.000Z' }));
    expect(gift.title).toBe('Pro offert');
    expect(gift.detail).toContain('22 décembre 2026');
  });
});

describe('Page Abonnement', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('visiteur : offres, prix de l’API, bascule annuelle, offre d’essai, une seule action jaune, mention légale', async () => {
    const env = await setup('anonymous');
    await openSubscription(env, '/abonnement', null);
    expect(env.q('[data-price]')?.textContent).toContain('14,90');
    expect(env.q('[data-trial-offer]')?.textContent).toBe('Essaie Pro gratuitement pendant 7 jours. Sans carte bancaire.');
    const year = env.root().querySelectorAll<HTMLInputElement>('input[type="radio"]')[1] as HTMLInputElement;
    year.click();
    await stable(env);
    expect(env.q('[data-price]')?.textContent).toContain('149');
    expect(env.root().textContent).toContain('−17 %');
    expect(env.q('[data-price-detail]')?.textContent).toContain('12,42');
    expect(env.q('[data-checkout]')?.getAttribute('href')).toBe('/compte/inscription?redirect=%2Fabonnement');
    expect(primaries(env)).toHaveLength(1);
    expect(env.q('[data-disclaimer]')?.textContent).toBe(DISCLAIMER);
    expect(env.root().textContent).not.toMatch(/dépêche|dernière chance|vite/i);
  });

  it('Checkout : POST de la périodicité seule, puis redirection vers Stripe', async () => {
    const env = await setup('authenticated', { plan: 'PRO', trial: { status: 'active', startedAt: '2026-11-19T10:00:00.000Z', endsAt: '2026-11-25T10:00:00.000Z' } });
    await openSubscription(env);
    expect(env.q('[data-status-detail]')?.textContent).toContain('Il reste 3 jours');
    env.q<HTMLButtonElement>('button[data-checkout]')?.click();
    const req = await expectRequest(env.ctrl, `${API}/billing/checkout-sessions`);
    expect(req.request.body).toEqual({ interval: 'month' });
    req.flush({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    await waitFor(() => env.location.assign.mock.calls.length === 1);
    expect(env.location.assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_1');
  });

  it('Checkout : URL hors Stripe et hors origine refusée, l’app n’est pas quittée', async () => {
    const env = await setup('authenticated');
    await openSubscription(env, '/abonnement', fakeBillingAccount());
    env.q<HTMLButtonElement>('button[data-checkout]')?.click();
    (await expectRequest(env.ctrl, `${API}/billing/checkout-sessions`)).flush({ url: 'https://checkout.stripe.com.evil.io/pay' });
    await waitFor(() => env.show.mock.calls.length > 0);
    expect(env.show).toHaveBeenCalledWith(REDIRECT_REFUSED_MESSAGE, { tone: 'error' });
    expect(env.location.assign).not.toHaveBeenCalled();
  });

  it('Pro en retard de paiement : explication neutre et portail', async () => {
    const env = await setup('authenticated', { plan: 'PRO' });
    await openSubscription(env, '/abonnement', fakeProAccount({ status: 'past_due' }, { paymentIssue: true }));
    expect(env.q('[data-payment-issue]')?.textContent).toContain('Pro reste actif');
    expect(env.q('button[data-checkout]')).toBeNull();
    env.q<HTMLButtonElement>('button[data-portal]')?.click();
    (await expectRequest(env.ctrl, `${API}/billing/portal-sessions`)).flush({ url: 'https://billing.stripe.com/p/session/test_1' });
    await waitFor(() => env.location.assign.mock.calls.length === 1);
  });

  it('résiliation programmée : date de fin affichée', async () => {
    const env = await setup('authenticated', { plan: 'PRO' });
    await openSubscription(env, '/abonnement', fakeProAccount({ cancelAtPeriodEnd: true }));
    expect(env.q('[data-status-detail]')?.textContent).toContain('Pro reste actif jusqu’au 22 décembre 2026');
  });

  it('paiement non configuré : message propre, bouton désactivé', async () => {
    const env = await setup('authenticated');
    await openSubscription(env, '/abonnement', fakeBillingAccount({ mode: 'unavailable', checkoutAvailable: false }), fakeBillingPlans({ mode: 'unavailable' }));
    expect(env.q('[data-billing-unavailable]')?.textContent).toContain(BILLING_ERROR_MESSAGES.BILLING_NOT_CONFIGURED);
    expect(env.q<HTMLButtonElement>('button[data-checkout]')?.disabled).toBe(true);
  });

  it('erreur BILLING_NOT_CONFIGURED au clic : message de l’API côté front', async () => {
    const env = await setup('authenticated');
    await openSubscription(env, '/abonnement', fakeBillingAccount());
    env.q<HTMLButtonElement>('button[data-checkout]')?.click();
    (await expectRequest(env.ctrl, `${API}/billing/checkout-sessions`)).flush({ code: 'BILLING_NOT_CONFIGURED', message: 'x' }, { status: 503, statusText: 'x' });
    await waitFor(() => env.show.mock.calls.length > 0);
    expect(env.show).toHaveBeenCalledWith(BILLING_ERROR_MESSAGES.BILLING_NOT_CONFIGURED, { tone: 'error' });
    (await expectRequest(env.ctrl, `${API}/billing/subscription`)).flush(fakeBillingAccount());
  });

  it('retour de Checkout annulé : toast neutre, paramètre retiré', async () => {
    const env = await setup('authenticated');
    await openSubscription(env, '/abonnement?checkout=annule', fakeBillingAccount());
    await waitFor(() => env.show.mock.calls.length > 0);
    expect(env.show).toHaveBeenCalledWith('Paiement annulé : rien n’a été débité.');
    await waitFor(() => env.router.url === '/abonnement');
  });

  it('simulation : badge visible', async () => {
    const env = await setup('authenticated');
    await openSubscription(env, '/abonnement', fakeBillingAccount({ mode: 'simulation' }), fakeBillingPlans({ mode: 'simulation' }));
    expect(env.q('[data-mode-badge]')).not.toBeNull();
  });

  it('offres indisponibles : Rai alerte et « Réessayer »', async () => {
    const env = await setup('anonymous');
    void env.harness.navigateByUrl('/abonnement');
    (await expectRequest(env.ctrl, `${API}/billing/plans`)).error(new ProgressEvent('error'));
    await waitFor(() => env.q('rj-error-state') !== null);
    expect(env.q('rj-error-state img')?.getAttribute('src')).toContain('rai-alerte');
  });
});

describe('Retour de Checkout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.inject(HttpTestingController).verify();
  });

  it('relit le compte : abonnement confirmé → Rai bravo (le plan vient du webhook)', async () => {
    const env = await setup('authenticated');
    void env.harness.navigateByUrl('/abonnement/succes?session_id=cs_test_1');
    (await expectRequest(env.ctrl, `${API}/billing/subscription`)).flush(fakeProAccount());
    await waitFor(() => env.q('[data-state="confirmed"]') !== null);
    expect(env.q('rj-mascot img')?.getAttribute('src')).toContain('rai-bravo');
  });

  it('confirmation trop longue : état « en cours » sans promettre de plan', async () => {
    const env = await setup('authenticated');
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    void env.harness.navigateByUrl('/abonnement/succes');
    const req = await expectRequest(env.ctrl, `${API}/billing/subscription`);
    now.mockReturnValue(start + SUCCESS_POLL_MAX_MS);
    req.flush(fakeBillingAccount());
    await waitFor(() => env.q('[data-state="timeout"]') !== null);
    expect(env.root().textContent).toContain('sans nouveau paiement');
  });
});

describe('Simulation', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());
  const SESSION = 'cs_fake_abcdefghijklmnop';

  it('faux Checkout : aucun champ de carte, « Simuler le paiement » → page de succès', async () => {
    const env = await setup('authenticated');
    void env.harness.navigateByUrl(`/abonnement/simulation?session=${SESSION}`);
    (await expectRequest(env.ctrl, `${API}/billing/plans`)).flush(fakeBillingPlans({ mode: 'simulation' }));
    (await expectRequest(env.ctrl, `${API}/billing/subscription`)).flush(fakeBillingAccount({ mode: 'simulation' }));
    await waitFor(() => env.q('[data-simulate-paid]') !== null);
    await stable(env);
    expect(env.root().querySelectorAll('input')).toHaveLength(0);
    expect(primaries(env)).toHaveLength(1);
    env.q<HTMLButtonElement>('[data-simulate-paid]')?.click();
    const req = await expectRequest(env.ctrl, `${API}/billing/simulation/checkout`);
    expect(req.request.body).toEqual({ sessionId: SESSION, outcome: 'paid' });
    req.flush(null, { status: 204, statusText: 'No Content' });
    await waitFor(() => env.router.url.startsWith('/abonnement/succes'));
    expect(env.router.url).toBe(`/abonnement/succes?session_id=${SESSION}`);
    (await expectRequest(env.ctrl, `${API}/billing/subscription`)).flush(fakeProAccount());
  });

  it('faux Checkout : « Annuler » → abonnement avec checkout=annule', async () => {
    const env = await setup('authenticated');
    void env.harness.navigateByUrl(`/abonnement/simulation?session=${SESSION}`);
    (await expectRequest(env.ctrl, `${API}/billing/plans`)).flush(fakeBillingPlans({ mode: 'simulation' }));
    (await expectRequest(env.ctrl, `${API}/billing/subscription`)).flush(fakeBillingAccount({ mode: 'simulation' }));
    await waitFor(() => env.q('[data-simulate-cancel]') !== null);
    env.q<HTMLButtonElement>('[data-simulate-cancel]')?.click();
    await waitFor(() => env.router.url.startsWith('/abonnement?'));
    expect(env.router.url).toBe('/abonnement?checkout=annule');
    (await expectRequest(env.ctrl, `${API}/billing/plans`)).flush(fakeBillingPlans({ mode: 'simulation' }));
    (await expectRequest(env.ctrl, `${API}/billing/subscription`)).flush(fakeBillingAccount({ mode: 'simulation' }));
  });

  it('session invalide : boutons désactivés', async () => {
    const env = await setup('authenticated');
    void env.harness.navigateByUrl('/abonnement/simulation?session=cs_live_x');
    (await expectRequest(env.ctrl, `${API}/billing/plans`)).flush(fakeBillingPlans({ mode: 'simulation' }));
    (await expectRequest(env.ctrl, `${API}/billing/subscription`)).flush(fakeBillingAccount({ mode: 'simulation' }));
    await waitFor(() => env.q('[data-invalid-session]') !== null);
    await stable(env);
    expect(env.q<HTMLButtonElement>('[data-simulate-paid]')?.disabled).toBe(true);
  });

  it('hors mode simulé : page indisponible, aucune action', async () => {
    const env = await setup('authenticated');
    void env.harness.navigateByUrl(`/abonnement/simulation?session=${SESSION}`);
    (await expectRequest(env.ctrl, `${API}/billing/plans`)).flush(fakeBillingPlans());
    (await expectRequest(env.ctrl, `${API}/billing/subscription`)).flush(fakeBillingAccount());
    await waitFor(() => env.q('[data-simulation-unavailable]') !== null);
    expect(env.q('[data-simulate-paid]')).toBeNull();
  });

  it('faux portail : résiliation en fin de période puis relecture', async () => {
    const env = await setup('authenticated', { plan: 'PRO' });
    void env.harness.navigateByUrl('/abonnement/simulation-portail');
    (await expectRequest(env.ctrl, `${API}/billing/plans`)).flush(fakeBillingPlans({ mode: 'simulation' }));
    (await expectRequest(env.ctrl, `${API}/billing/subscription`)).flush(fakeProAccount({}, { mode: 'simulation' }));
    await waitFor(() => env.q('[data-action="cancel_at_period_end"]') !== null);
    env.q<HTMLButtonElement>('[data-action="cancel_at_period_end"]')?.click();
    const req = await expectRequest(env.ctrl, `${API}/billing/simulation/portal`);
    expect(req.request.body).toEqual({ action: 'cancel_at_period_end' });
    req.flush(null, { status: 204, statusText: 'No Content' });
    (await expectRequest(env.ctrl, `${API}/billing/subscription`)).flush(fakeProAccount({ cancelAtPeriodEnd: true }, { mode: 'simulation' }));
    await waitFor(() => env.q('[data-action="resume"]') !== null);
  });
});

describe('Fin d’essai (J0)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  async function openEnd(env: Env, recap = fakeTrialRecap()) {
    void env.harness.navigateByUrl('/abonnement/fin-essai');
    (await expectRequest(env.ctrl, `${API}/trial/recap`)).flush(recap);
    (await expectRequest(env.ctrl, `${API}/billing/plans`)).flush(fakeBillingPlans());
    await waitFor(() => env.q('[data-continue-free]') !== null);
    await stable(env);
  }

  it('Rai bravo, récapitulatif, ce qui change, « Garder Pro » seule action jaune', async () => {
    const env = await setup('authenticated');
    await openEnd(env);
    expect(env.q('rj-mascot img')?.getAttribute('src')).toContain('rai-bravo');
    expect(env.q('[data-stat="analyses"]')?.textContent).toContain('42');
    expect(env.q('[data-stat="alerts"]')?.textContent).toContain('alertes reçues');
    expect(env.q('[data-stat="danger"]')?.textContent).toContain('tokens Danger repérés');
    expect(env.q('[data-stat="danger"] rj-icon')).not.toBeNull();
    expect(env.q('[data-pause-note]')?.textContent).toContain('jamais supprimés');
    expect(env.q('[data-keep-pro]')?.getAttribute('href')).toBe('/abonnement');
    expect(primaries(env)).toHaveLength(1);
    expect(env.root().textContent).not.toMatch(/dépêche|dernière chance/i);
  });

  it('« Continuer en Gratuit » : écran vu, puis choix des suivis (plus de 3)', async () => {
    const env = await setup('authenticated');
    await openEnd(env);
    env.q<HTMLButtonElement>('[data-continue-free]')?.click();
    const req = await expectRequest(env.ctrl, `${API}/trial/end-screen/seen`);
    expect(req.request.method).toBe('POST');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await waitFor(() => env.router.url === '/abonnement/suivis');
    (await expectRequest(env.ctrl, `${API}/watches`)).flush(fakeWatchList([fakeWatch()]));
  });

  it('« Continuer en Gratuit » avec 3 suivis ou moins : retour à l’analyse', async () => {
    const env = await setup('authenticated');
    await openEnd(env, fakeTrialRecap({ activeWatches: 2, planLimitPausedWatches: 0 }));
    expect(env.q('[data-pause-note]')).toBeNull();
    env.q<HTMLButtonElement>('[data-continue-free]')?.click();
    (await expectRequest(env.ctrl, `${API}/trial/end-screen/seen`)).flush(null, { status: 204, statusText: 'No Content' });
    await waitFor(() => env.router.url === '/analyse');
  });

  it('aucun essai : état vide Rai bravo', async () => {
    const env = await setup('authenticated');
    void env.harness.navigateByUrl('/abonnement/fin-essai');
    (await expectRequest(env.ctrl, `${API}/trial/recap`)).flush({ code: 'TRIAL_NOT_FOUND', message: 'x' }, { status: 404, statusText: 'x' });
    (await expectRequest(env.ctrl, `${API}/billing/plans`)).flush(fakeBillingPlans());
    await waitFor(() => env.q('rj-empty-state') !== null);
    expect(env.root().textContent).toContain('Aucun essai Pro à résumer');
  });
});

describe('Choix des suivis à garder', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());
  const mints = [FIXTURE_MINTS.bonk, FIXTURE_MINTS.usdc, FIXTURE_MINTS.jup, 'So11111111111111111111111111111111111111112', '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr'];
  const watches = mints.map((mint, i) =>
    fakeWatch({
      id: fakeWatchId(i + 1),
      mint,
      token: { mint, name: `Token ${i + 1}`, symbol: `T${i + 1}`, decimals: 6, tokenProgram: 'spl-token', untrusted: true },
      status: i < 3 ? 'active' : 'paused',
      pausedReason: i < 3 ? null : 'plan_limit',
      createdAt: `2026-11-2${i}T10:00:00.000Z`,
    }),
  );

  async function openKeep(env: Env, list = fakeWatchList(watches)) {
    void env.harness.navigateByUrl('/abonnement/suivis');
    (await expectRequest(env.ctrl, `${API}/watches`)).flush(list);
    await waitFor(() => env.q('[data-counter]') !== null || env.q('rj-empty-state') !== null);
    await stable(env);
  }

  it('présélection des actifs, compteur « 3 / 3 », limite claire, cases au clavier', async () => {
    const env = await setup('authenticated');
    await openKeep(env);
    const boxes = Array.from(env.root().querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(boxes).toHaveLength(5);
    expect(env.q('[data-counter]')?.textContent).toContain('3 / 3');
    expect(env.q('[data-limit-note]')).not.toBeNull();
    expect(boxes.filter((box) => box.disabled)).toHaveLength(2);
    // Décocher libère une place : les autres cases redeviennent sélectionnables.
    boxes.find((box) => box.checked)?.click();
    await stable(env);
    expect(env.q('[data-counter]')?.textContent).toContain('2 / 3');
    expect(boxes.filter((box) => box.disabled)).toHaveLength(0);
  });

  it('« Garder ces suivis » : POST watches/keep puis retour aux suivis', async () => {
    const env = await setup('authenticated');
    await openKeep(env);
    const boxes = Array.from(env.root().querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    boxes[0]?.click();
    await stable(env);
    boxes[4]?.click();
    await stable(env);
    env.q<HTMLButtonElement>('[data-keep-submit]')?.click();
    const req = await expectRequest(env.ctrl, `${API}/watches/keep`);
    const ids = (req.request.body as { watchIds: string[] }).watchIds;
    expect(ids).toHaveLength(3);
    req.flush(fakeWatchList(watches));
    await waitFor(() => env.router.url === '/suivis');
    expect(env.show).toHaveBeenCalledWith(expect.stringContaining('3 suivis actifs, 2 en pause'), { tone: 'success' });
  });

  it('refus de l’API : message clair, on reste sur l’écran', async () => {
    const env = await setup('authenticated');
    await openKeep(env);
    env.q<HTMLButtonElement>('[data-keep-submit]')?.click();
    (await expectRequest(env.ctrl, `${API}/watches/keep`)).flush({ code: 'WATCH_KEEP_INVALID', message: 'x' }, { status: 400, statusText: 'x' });
    await waitFor(() => env.q('rj-form-alert') !== null);
    expect(env.q('rj-form-alert')?.textContent).toContain('Choisis au plus');
  });

  it('rien à choisir : état vide Rai bravo', async () => {
    const env = await setup('authenticated');
    await openKeep(env, fakeWatchList(watches.slice(0, 2)));
    expect(env.q('rj-empty-state')?.textContent).toContain('Tous tes suivis restent actifs');
  });
});
