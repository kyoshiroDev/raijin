import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { alertListResponseSchema } from '@raijin/shared-contracts';
import { loadContracts } from '../contracts';
import { FIXTURE_MINTS, fakeAlertId, fakeAlertPage, fakeAlerts } from '../testing/watch-fixtures';
import { DEFAULT_ALERT_FILTERS, alertListParams } from './alerts-api';
import { ALERTS_PAGE_SIZE, AlertsStore } from './alerts.store';
import { UnreadAlerts } from './unread-alerts';

const API = '/api/v1';
const listUrl = (req: { url: string }) => req.url === `${API}/alerts`;

async function setup() {
  await loadContracts();
  TestBed.configureTestingModule({ providers: [AlertsStore, provideHttpClient(), provideHttpClientTesting()] });
  return { store: TestBed.inject(AlertsStore), ctrl: TestBed.inject(HttpTestingController), unread: TestBed.inject(UnreadAlerts) };
}

describe('fixtures des alertes', () => {
  it('une alerte de chaque type, conformes au contrat', () => {
    const page = fakeAlertPage();
    expect(alertListResponseSchema.safeParse(page).success).toBe(true);
    expect(new Set(page.items.map((alert) => alert.type)).size).toBe(5);
  });
});

describe('alertListParams', () => {
  it('filtres par défaut : seulement la taille de page', () => {
    expect(alertListParams(DEFAULT_ALERT_FILTERS, null, 20).toString()).toBe('limit=20');
  });

  it('état, types séparés par des virgules, mint et curseur opaque', () => {
    const params = alertListParams({ status: 'unread', types: ['lp_removed', 'holder_sold'], mint: FIXTURE_MINTS.bonk }, 'abc_DEF-1', 20);
    expect(params.get('status')).toBe('unread');
    expect(params.get('types')).toBe('lp_removed,holder_sold');
    expect(params.get('mint')).toBe(FIXTURE_MINTS.bonk);
    expect(params.get('cursor')).toBe('abc_DEF-1');
  });
});

describe('AlertsStore', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('première page, puis « Charger plus » avec le curseur, sans doublon ; badge mis à jour', async () => {
    const { store, ctrl, unread } = await setup();
    const [a, b, c] = fakeAlerts();
    if (!a || !b || !c) throw new Error('fixtures');
    const first = store.load();
    const req = ctrl.expectOne(listUrl);
    expect(req.request.params.get('limit')).toBe(String(ALERTS_PAGE_SIZE));
    req.flush(fakeAlertPage([a, b], 'cursor-2', 7));
    await first;
    expect(store.items()).toHaveLength(2);
    expect(store.hasMore()).toBe(true);
    expect(unread.count()).toBe(7);
    const more = store.loadMore();
    expect(store.loadingMore()).toBe(true);
    const next = ctrl.expectOne(listUrl);
    expect(next.request.params.get('cursor')).toBe('cursor-2');
    next.flush(fakeAlertPage([b, c], null, 6));
    await more;
    expect(store.items().map((alert) => alert.id)).toEqual([a.id, b.id, c.id]);
    expect(store.hasMore()).toBe(false);
    expect(unread.count()).toBe(6);
  });

  it('échec de « Charger plus » : la liste reste, erreur à côté du bouton', async () => {
    const { store, ctrl } = await setup();
    void store.load();
    ctrl.expectOne(listUrl).flush(fakeAlertPage(fakeAlerts().slice(0, 1), 'c2'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const more = store.loadMore();
    ctrl.expectOne(listUrl).error(new ProgressEvent('error'));
    await more;
    expect(store.items()).toHaveLength(1);
    expect(store.moreError()?.code).toBe('NETWORK_ERROR');
    expect(store.status()).toBe('ready');
  });

  it('filtres actifs comptés ; une réponse dépassée par un nouveau filtre est ignorée', async () => {
    const { store, ctrl } = await setup();
    const stale = store.load({ status: 'unread', types: [], mint: null });
    const fresh = store.load({ status: 'read', types: ['lp_removed'], mint: FIXTURE_MINTS.bonk });
    const [first, second] = ctrl.match(listUrl);
    second?.flush(fakeAlertPage([], null, 0));
    first?.flush(fakeAlertPage());
    await Promise.all([stale, fresh]);
    expect(store.items()).toEqual([]);
    expect(store.activeFilterCount()).toBe(3);
  });

  it('marquer lue / non lue : POST alerts/read { ids, read }, optimiste, annulé en cas d’erreur', async () => {
    const { store, ctrl, unread } = await setup();
    void store.load();
    ctrl.expectOne(listUrl).flush(fakeAlertPage());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const id = fakeAlertId(1);
    const done = store.markRead([id], true);
    expect(store.items().find((alert) => alert.id === id)?.readAt).not.toBeNull();
    const req = ctrl.expectOne(`${API}/alerts/read`);
    expect(req.request.body).toEqual({ ids: [id], read: true });
    req.flush({ unread: 2 });
    expect(await done).toBeNull();
    expect(unread.count()).toBe(2);

    const failed = store.markRead([id], false);
    ctrl.expectOne(`${API}/alerts/read`).flush({ code: 'INTERNAL_ERROR', message: 'x' }, { status: 500, statusText: 'Error' });
    expect((await failed)?.code).toBe('INTERNAL_ERROR');
    expect(store.items().find((alert) => alert.id === id)?.readAt).not.toBeNull();
  });

  it('tout marquer comme lu : POST { all: true, read: true }', async () => {
    const { store, ctrl, unread } = await setup();
    void store.load();
    ctrl.expectOne(listUrl).flush(fakeAlertPage());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const done = store.markAllRead();
    const req = ctrl.expectOne(`${API}/alerts/read`);
    expect(req.request.body).toEqual({ all: true, read: true });
    req.flush({ unread: 0 });
    await done;
    expect(store.items().every((alert) => alert.readAt !== null)).toBe(true);
    expect(unread.count()).toBe(0);
  });
});
