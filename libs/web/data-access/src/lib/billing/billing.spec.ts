import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { billingAccountSchema, billingPlansResponseSchema, trialDaysRemaining, trialRecapSchema } from '@raijin/shared-contracts';
import { AuthStore } from '../auth/auth.store';
import { loadContracts } from '../contracts';
import { fakeSession } from '../testing/fixtures';
import {
  fakeBillingAccount,
  fakeBillingPlans,
  fakeProAccount,
  fakeTrialAccount,
  fakeTrialRecap,
} from '../testing/billing-fixtures';
import { FIXTURE_MINTS, fakeWatch, fakeWatchId, fakeWatchList } from '../testing/watch-fixtures';
import { WatchesStore } from '../watch/watches.store';
import { BILLING_LOCATION, BillingApi, BillingRedirectRefusedError } from './billing-api';
import { BillingStore } from './billing.store';
import { TrialApi } from './trial-api';
import { TRIAL_BANNER_STORAGE_KEY, TrialBannerState, bannerDaysRemaining, localDay, trialBannerFor, trialBannerText } from './trial-banner';

const API = '/api/v1';
const ORIGIN = 'http://localhost:4200';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup() {
  await loadContracts();
  const location = { origin: ORIGIN, assign: vi.fn() };
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), { provide: BILLING_LOCATION, useValue: location }],
  });
  return { api: TestBed.inject(BillingApi), ctrl: TestBed.inject(HttpTestingController), location };
}

describe('fixtures de l’abonnement', () => {
  it('respectent les contrats', () => {
    expect(billingPlansResponseSchema.safeParse(fakeBillingPlans()).success).toBe(true);
    for (const account of [fakeBillingAccount(), fakeTrialAccount(5), fakeTrialAccount(1), fakeProAccount({ status: 'past_due' }, { paymentIssue: true })]) {
      expect(billingAccountSchema.safeParse(account).success).toBe(true);
    }
    expect(trialRecapSchema.safeParse(fakeTrialRecap()).success).toBe(true);
  });
});

describe('BillingApi : redirections limitées aux hôtes autorisés', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  async function checkout(url: string) {
    const { api, ctrl, location } = await setup();
    const done = api.startCheckout('year');
    await settle();
    const req = ctrl.expectOne(`${API}/billing/checkout-sessions`);
    expect(req.request.method).toBe('POST');
    // Jamais de prix ni d'URL venus du front : la périodicité seule.
    expect(req.request.body).toEqual({ interval: 'year' });
    req.flush({ url });
    return { done, location };
  }

  it('suit une URL Stripe Checkout en https', async () => {
    const { done, location } = await checkout('https://checkout.stripe.com/c/pay/cs_test_123');
    await done;
    expect(location.assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_123');
  });

  it('suit la page de simulation de la même origine', async () => {
    const { done, location } = await checkout(`${ORIGIN}/abonnement/simulation?session=cs_fake_abcdefghijklmnop`);
    await done;
    expect(location.assign).toHaveBeenCalledTimes(1);
  });

  it.each([
    'https://checkout.stripe.com.evil.io/c/pay',
    'http://checkout.stripe.com/c/pay',
    'https://evil.io/abonnement/succes',
    'http://localhost:4300/abonnement/simulation',
  ])('refuse %s sans quitter l’app', async (url) => {
    const { done, location } = await checkout(url);
    await expect(done).rejects.toBeInstanceOf(BillingRedirectRefusedError);
    expect(location.assign).not.toHaveBeenCalled();
  });

  it('refuse une réponse qui n’est pas une URL (javascript:)', async () => {
    const { done, location } = await checkout('javascript:alert(1)');
    await expect(done).rejects.toBeTruthy();
    expect(location.assign).not.toHaveBeenCalled();
  });

  it('portail : même contrôle de l’URL', async () => {
    const { api, ctrl, location } = await setup();
    const done = api.openPortal();
    ctrl.expectOne(`${API}/billing/portal-sessions`).flush({ url: 'https://billing.stripe.com/p/session/test_1' });
    await done;
    expect(location.assign).toHaveBeenCalledWith('https://billing.stripe.com/p/session/test_1');
  });

  it('simulation : corps validé avant l’envoi', async () => {
    const { api, ctrl } = await setup();
    await expect(api.simulateCheckout({ sessionId: 'cs_live_x', outcome: 'paid' })).rejects.toBeTruthy();
    const done = api.simulateCheckout({ sessionId: 'cs_fake_abcdefghijklmnop', outcome: 'paid' });
    await settle();
    ctrl.expectOne(`${API}/billing/simulation/checkout`).flush(null, { status: 204, statusText: 'No Content' });
    await done;
    const portal = api.simulatePortal({ action: 'cancel_at_period_end' });
    await settle();
    const req = ctrl.expectOne(`${API}/billing/simulation/portal`);
    expect(req.request.body).toEqual({ action: 'cancel_at_period_end' });
    req.flush(null, { status: 204, statusText: 'No Content' });
    await portal;
  });
});

describe('BillingStore', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('visiteur : offres seules ; connecté : offres et compte', async () => {
    const { ctrl } = await setup();
    const store = TestBed.inject(BillingStore);
    const anon = store.load(false);
    ctrl.expectOne(`${API}/billing/plans`).flush(fakeBillingPlans({ mode: 'simulation' }));
    await anon;
    expect(store.status()).toBe('ready');
    expect(store.account()).toBeNull();
    expect(store.mode()).toBe('simulation');
    const auth = store.load(true);
    ctrl.expectOne(`${API}/billing/plans`).flush(fakeBillingPlans());
    ctrl.expectOne(`${API}/billing/subscription`).flush(fakeTrialAccount(4));
    await auth;
    expect(store.account()?.source).toBe('trial');
  });

  it('erreur : état error et message affichable', async () => {
    const { ctrl } = await setup();
    const store = TestBed.inject(BillingStore);
    const done = store.load(false);
    ctrl.expectOne(`${API}/billing/plans`).flush({ code: 'BILLING_NOT_CONFIGURED', message: 'x' }, { status: 503, statusText: 'x' });
    await done;
    expect(store.status()).toBe('error');
    expect(store.error()?.code).toBe('BILLING_NOT_CONFIGURED');
  });
});

describe('TrialApi et WatchesStore.keep', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('lit le récapitulatif et marque l’écran vu', async () => {
    const { ctrl } = await setup();
    const api = TestBed.inject(TrialApi);
    const recap = api.recap();
    ctrl.expectOne(`${API}/trial/recap`).flush(fakeTrialRecap());
    expect((await recap).dangerTokensCount).toBe(7);
    const seen = api.markEndScreenSeen();
    const req = ctrl.expectOne(`${API}/trial/end-screen/seen`);
    expect(req.request.method).toBe('POST');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await seen;
  });

  it('garde les suivis choisis et remplace la liste', async () => {
    const { ctrl } = await setup();
    const store = TestBed.inject(WatchesStore);
    const ids = [fakeWatchId(1), fakeWatchId(2)];
    const done = store.keep(ids);
    await settle();
    const req = ctrl.expectOne(`${API}/watches/keep`);
    expect(req.request.body).toEqual({ watchIds: ids });
    req.flush(fakeWatchList([fakeWatch(), fakeWatch({ id: fakeWatchId(3), mint: FIXTURE_MINTS.usdc, status: 'paused', pausedReason: 'plan_limit' })]));
    expect(await done).toEqual({ ok: true });
    expect(store.pausedCount()).toBe(1);
  });

  it('refus de l’API : erreur affichable, liste inchangée', async () => {
    const { ctrl } = await setup();
    const store = TestBed.inject(WatchesStore);
    const done = store.keep([fakeWatchId(1)]);
    await settle();
    ctrl.expectOne(`${API}/watches/keep`).flush({ code: 'WATCH_KEEP_INVALID', message: 'x' }, { status: 400, statusText: 'x' });
    const outcome = await done;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('WATCH_KEEP_INVALID');
  });
});

describe('bandeau d’essai', () => {
  const NOW = Date.parse('2026-11-22T10:00:00.000Z');
  const trialUser = (endsAt: string) => fakeSession({ plan: 'PRO', trial: { status: 'active', startedAt: '2026-11-20T10:00:00.000Z', endsAt } }).user;

  beforeEach(() => localStorage.removeItem(TRIAL_BANNER_STORAGE_KEY));

  it('compte les jours comme le contrat partagé avec l’API', () => {
    for (const endsAt of ['2026-11-25T09:00:00.000Z', '2026-11-22T10:00:01.000Z', '2026-11-21T10:00:00.000Z', '2026-11-29T10:00:00.000Z', 'invalide']) {
      expect(bannerDaysRemaining(endsAt, NOW)).toBe(trialDaysRemaining(endsAt, new Date(NOW)));
    }
  });

  it('texte sobre, « aujourd’hui » le dernier jour, rien hors essai actif', () => {
    expect(trialBannerText(3)).toBe('Essai Pro : plus que 3 jours');
    expect(trialBannerText(1)).toBe('Essai Pro : se termine aujourd’hui');
    expect(trialBannerFor(trialUser('2026-11-25T10:00:00.000Z'), NOW)?.linkPath).toBe('/abonnement');
    expect(trialBannerFor(trialUser('2026-11-22T20:00:00.000Z'), NOW)?.linkPath).toBe('/abonnement/fin-essai');
    expect(trialBannerFor(trialUser('2026-11-22T09:00:00.000Z'), NOW)).toBeNull();
    expect(trialBannerFor(fakeSession().user, NOW)).toBeNull();
    expect(trialBannerFor(null, NOW)).toBeNull();
  });

  it('refermable une fois par jour : masqué jusqu’au lendemain, sans donnée personnelle', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    TestBed.inject(AuthStore).applySession(fakeSession({ plan: 'PRO', trial: { status: 'active', startedAt: '2026-11-20T10:00:00.000Z', endsAt: '2026-11-26T10:00:00.000Z' } }));
    const state = TestBed.inject(TrialBannerState);
    state.tick(NOW);
    expect(state.banner()?.text).toBe('Essai Pro : plus que 4 jours');
    state.dismiss(NOW);
    expect(state.banner()).toBeNull();
    expect(localStorage.getItem(TRIAL_BANNER_STORAGE_KEY)).toBe(localDay(NOW));
    state.tick(NOW + 3_600_000);
    expect(state.banner()).toBeNull();
    state.tick(NOW + 86_400_000);
    expect(state.banner()?.text).toBe('Essai Pro : plus que 3 jours');
  });

  it('fermeture du jour relue au démarrage', () => {
    localStorage.setItem(TRIAL_BANNER_STORAGE_KEY, localDay(Date.now()));
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    TestBed.inject(AuthStore).applySession(fakeSession({ plan: 'PRO', trial: { status: 'active', startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() } }));
    expect(TestBed.inject(TrialBannerState).banner()).toBeNull();
  });
});
