import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { watchListResponseSchema } from '@raijin/shared-contracts';
import { loadContracts } from '../contracts';
import { FIXTURE_MINTS, fakeLimits, fakeWatch, fakeWatchId, fakeWatchList } from '../testing/watch-fixtures';
import { planName, watchLimitExplanation } from './watch-texts';
import { WatchesStore } from './watches.store';

const API = '/api/v1';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup() {
  await loadContracts();
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  return { store: TestBed.inject(WatchesStore), ctrl: TestBed.inject(HttpTestingController) };
}

describe('fixtures des suivis', () => {
  it('respectent watchListResponseSchema', () => {
    const list = fakeWatchList([fakeWatch(), fakeWatch({ id: fakeWatchId(2), status: 'paused', pausedReason: 'plan_limit' })]);
    expect(watchListResponseSchema.safeParse(list).success).toBe(true);
  });
});

describe('WatchesStore', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('charge la liste (actifs d’abord), les limites et les compteurs', async () => {
    const { store, ctrl } = await setup();
    const paused = fakeWatch({ id: fakeWatchId(2), mint: FIXTURE_MINTS.usdc, status: 'paused', pausedReason: 'user', createdAt: '2026-11-23T00:00:00.000Z' });
    const done = store.load();
    expect(store.status()).toBe('loading');
    ctrl.expectOne(`${API}/watches`).flush(fakeWatchList([paused, fakeWatch()]));
    await done;
    expect(store.status()).toBe('ready');
    expect(store.items().map((watch) => watch.status)).toEqual(['active', 'paused']);
    expect(store.activeCount()).toBe(1);
    expect(store.pausedCount()).toBe(1);
    expect(store.limitReached()).toBe(false);
    expect(store.findByMint(FIXTURE_MINTS.usdc)?.id).toBe(paused.id);
  });

  it('une seule requête à la fois ; pas de rechargement sans `force`', async () => {
    const { store, ctrl } = await setup();
    const first = store.load();
    void store.load();
    ctrl.expectOne(`${API}/watches`).flush(fakeWatchList());
    await first;
    await store.load();
    ctrl.expectNone(`${API}/watches`);
  });

  it('erreur au premier chargement : statut error et message', async () => {
    const { store, ctrl } = await setup();
    const done = store.load();
    ctrl.expectOne(`${API}/watches`).flush({ code: 'INTERNAL_ERROR', message: 'x' }, { status: 500, statusText: 'Error' });
    await done;
    expect(store.status()).toBe('error');
    expect(store.error()?.message).toContain('Réessaie');
  });

  it('suivre puis limite atteinte : WATCH_LIMIT_REACHED renvoyé sans exception', async () => {
    const { store, ctrl } = await setup();
    const followed = store.follow(FIXTURE_MINTS.jup);
    expect(store.isBusy(FIXTURE_MINTS.jup)).toBe(true);
    ctrl.expectOne(`${API}/watches`).flush(fakeWatch({ mint: FIXTURE_MINTS.jup }), { status: 201, statusText: 'Created' });
    expect((await followed).ok).toBe(true);
    expect(store.findByMint(FIXTURE_MINTS.jup)).toBeDefined();
    const refused = store.follow(FIXTURE_MINTS.usdc);
    ctrl.expectOne(`${API}/watches`).flush({ code: 'WATCH_LIMIT_REACHED', message: 'x' }, { status: 403, statusText: 'Forbidden' });
    const outcome = await refused;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('WATCH_LIMIT_REACHED');
    expect(store.isBusy(FIXTURE_MINTS.usdc)).toBe(false);
  });

  it('pause / reprise : PATCH { status } et liste mise à jour', async () => {
    const { store, ctrl } = await setup();
    void store.load();
    ctrl.expectOne(`${API}/watches`).flush(fakeWatchList());
    await settle();
    const watch = store.items()[0];
    if (!watch) throw new Error('Suivi absent');
    const done = store.setStatus(watch.id, 'paused');
    const req = ctrl.expectOne(`${API}/watches/${watch.id}`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ status: 'paused' });
    req.flush({ ...watch, status: 'paused', pausedReason: 'user' });
    await done;
    expect(store.items()[0]?.status).toBe('paused');
    expect(store.activeCount()).toBe(0);
  });

  it('retrait : DELETE ; un suivi déjà absent (404 WATCH_NOT_FOUND) est aussi retiré', async () => {
    const { store, ctrl } = await setup();
    void store.load();
    ctrl.expectOne(`${API}/watches`).flush(fakeWatchList([fakeWatch(), fakeWatch({ id: fakeWatchId(2), mint: FIXTURE_MINTS.usdc })]));
    await settle();
    const removed = store.remove(fakeWatchId(1));
    ctrl.expectOne(`${API}/watches/${fakeWatchId(1)}`).flush(null, { status: 204, statusText: 'No Content' });
    expect((await removed).ok).toBe(true);
    const gone = store.remove(fakeWatchId(2));
    ctrl.expectOne(`${API}/watches/${fakeWatchId(2)}`).flush({ code: 'WATCH_NOT_FOUND', message: 'x' }, { status: 404, statusText: 'Not Found' });
    expect((await gone).ok).toBe(true);
    expect(store.items()).toHaveLength(0);
  });

  it('réponse hors contrat : erreur, jamais affichée telle quelle', async () => {
    const { store, ctrl } = await setup();
    const done = store.load();
    ctrl.expectOne(`${API}/watches`).flush({ items: [{ id: 'x' }] });
    await done;
    expect(store.status()).toBe('error');
  });

  it('reset (déconnexion) : tout est oublié', async () => {
    const { store, ctrl } = await setup();
    void store.load();
    ctrl.expectOne(`${API}/watches`).flush(fakeWatchList());
    await settle();
    store.reset();
    expect(store.items()).toEqual([]);
    expect(store.limits()).toBeNull();
    expect(store.status()).toBe('idle');
  });
});

describe('textes de limite', () => {
  it('plan Gratuit, Pro, essai ; jamais d’urgence', () => {
    expect(planName(fakeLimits())).toBe('plan Gratuit');
    expect(planName(fakeLimits({ plan: 'PRO', maxActiveWatches: 50 }))).toBe('plan Pro');
    expect(planName(fakeLimits({ plan: 'PRO', trialActive: true }))).toBe('essai Pro');
    const free = watchLimitExplanation(fakeLimits());
    expect(free).toContain('3 suivis actifs');
    expect(free).toContain('Le plan Pro permet d’en suivre davantage');
    expect(watchLimitExplanation(fakeLimits({ plan: 'PRO', maxActiveWatches: 50 }))).not.toContain('Le plan Pro');
    expect(watchLimitExplanation(fakeLimits({ maxActiveWatches: 1 }))).toContain('1 suivi actif à la fois');
    for (const text of [free, watchLimitExplanation(null)]) expect(text).not.toMatch(/vite|dernière chance|dépêche|offre limitée/i);
  });
});
