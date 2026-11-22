import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AuthStore } from '../auth/auth.store';
import { fakeSession } from '../testing/fixtures';
import { UnreadAlerts, readUnreadCount } from './unread-alerts';

const API = '/api/v1';

function setup() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  return { unread: TestBed.inject(UnreadAlerts), auth: TestBed.inject(AuthStore), ctrl: TestBed.inject(HttpTestingController) };
}

describe('readUnreadCount', () => {
  it('lecture sans Zod : entier positif seulement', () => {
    expect(readUnreadCount({ unread: 3 })).toBe(3);
    for (const body of [null, {}, { unread: -1 }, { unread: 1.5 }, { unread: '3' }, 'x']) expect(readUnreadCount(body)).toBeNull();
  });
});

describe('UnreadAlerts', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('visiteur : 0, aucune requête', async () => {
    const { unread, auth } = setup();
    auth.clear();
    await unread.refresh();
    expect(unread.count()).toBe(0);
  });

  it('connecté : GET alerts/unread-count ; une réponse invalide garde la dernière valeur', async () => {
    const { unread, auth, ctrl } = setup();
    auth.applySession(fakeSession());
    const first = unread.refresh();
    ctrl.expectOne(`${API}/alerts/unread-count`).flush({ unread: 4 });
    await first;
    expect(unread.count()).toBe(4);
    const second = unread.refresh();
    ctrl.expectOne(`${API}/alerts/unread-count`).flush({ unread: 'beaucoup' });
    await second;
    expect(unread.count()).toBe(4);
    const failed = unread.refresh();
    ctrl.expectOne(`${API}/alerts/unread-count`).error(new ProgressEvent('error'));
    await failed;
    expect(unread.count()).toBe(4);
  });

  it('set : entier positif', () => {
    const { unread } = setup();
    unread.set(-3);
    expect(unread.count()).toBe(0);
    unread.set(12.7);
    expect(unread.count()).toBe(12);
  });
});
