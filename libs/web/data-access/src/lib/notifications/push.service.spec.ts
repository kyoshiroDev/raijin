import { DOCUMENT } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { SwPush } from '@angular/service-worker';
import { of } from 'rxjs';
import { loadContracts } from '../contracts';
import { PushService, isIosDevice, isStandalone } from './push.service';

const API = '/api/v1';
const KEY = 'B'.repeat(87);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

interface FakeWindowOptions {
  ua?: string;
  standalone?: boolean;
  permission?: NotificationPermission;
  push?: boolean;
}

function fakeWindow({ ua = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140', standalone = false, permission = 'default', push = true }: FakeWindowOptions = {}) {
  return {
    navigator: { userAgent: ua, platform: 'Linux x86_64', maxTouchPoints: 0, standalone },
    matchMedia: () => ({ matches: standalone }),
    PushManager: push ? {} : undefined,
    Notification: { permission },
  } as unknown as Window;
}

function fakeSubscription(endpoint = 'https://fcm.googleapis.com/fcm/send/abc') {
  return {
    endpoint,
    unsubscribe: vi.fn(() => Promise.resolve(true)),
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } }),
  };
}

async function setup(win: Window, sw: Partial<SwPush> & { isEnabled: boolean } = { isEnabled: true }) {
  await loadContracts();
  const swPush = { subscription: of(null), requestSubscription: vi.fn(), unsubscribe: vi.fn(() => Promise.resolve()), ...sw };
  TestBed.configureTestingModule({
    providers: [
      PushService,
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: SwPush, useValue: swPush },
      { provide: DOCUMENT, useValue: { defaultView: win } },
    ],
  });
  return { push: TestBed.inject(PushService), ctrl: TestBed.inject(HttpTestingController), swPush };
}

describe('détection de plateforme', () => {
  it('iPhone hors PWA, iPadOS, PWA installée', () => {
    expect(isIosDevice(fakeWindow({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }))).toBe(true);
    const ipad = { navigator: { userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 } } as unknown as Window;
    expect(isIosDevice(ipad)).toBe(true);
    expect(isIosDevice(fakeWindow())).toBe(false);
    expect(isStandalone(fakeWindow({ standalone: true }))).toBe(true);
    expect(isStandalone(fakeWindow())).toBe(false);
  });
});

describe('PushService', () => {
  it('iPhone hors écran d’accueil : explication iOS, jamais de demande de permission', async () => {
    const { push, swPush } = await setup(fakeWindow({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', push: false }));
    expect(push.availability()).toBe('ios-install');
    expect(await push.enable()).toEqual({ ok: false, reason: 'ios-install' });
    expect(swPush.requestSubscription).not.toHaveBeenCalled();
  });

  it('service worker inactif ou navigateur sans Push API : indisponible', async () => {
    const off = await setup(fakeWindow(), { isEnabled: false });
    expect(off.push.availability()).toBe('unsupported');
    TestBed.resetTestingModule();
    const noPush = await setup(fakeWindow({ push: false }));
    expect(noPush.push.availability()).toBe('unsupported');
  });

  it('activation : clé VAPID de l’API, abonnement du navigateur, POST push/subscriptions', async () => {
    const subscription = fakeSubscription();
    const { push, ctrl, swPush } = await setup(fakeWindow(), { isEnabled: true, requestSubscription: vi.fn(() => Promise.resolve(subscription as unknown as PushSubscription)) });
    expect(push.availability()).toBe('available');
    const done = push.enable();
    ctrl.expectOne(`${API}/push/vapid-public-key`).flush({ publicKey: KEY });
    await settle();
    expect(swPush.requestSubscription).toHaveBeenCalledWith({ serverPublicKey: KEY });
    await settle();
    const req = ctrl.expectOne(`${API}/push/subscriptions`);
    expect(req.request.body.endpoint).toBe(subscription.endpoint);
    req.flush({ id: '01968b3a-7c2e-7d4a-9f00-0123456789ab', createdAt: '2026-11-22T10:00:00.000Z' }, { status: 201, statusText: 'Created' });
    expect(await done).toEqual({ ok: true });
    expect(push.subscribed()).toBe(true);
  });

  it('plan Gratuit (403 PUSH_PLAN_REQUIRED) : abonnement local retiré, erreur neutre', async () => {
    const subscription = fakeSubscription();
    const { push, ctrl } = await setup(fakeWindow(), { isEnabled: true, requestSubscription: vi.fn(() => Promise.resolve(subscription as unknown as PushSubscription)) });
    const done = push.enable();
    ctrl.expectOne(`${API}/push/vapid-public-key`).flush({ publicKey: KEY });
    await settle();
    await settle();
    ctrl.expectOne(`${API}/push/subscriptions`).flush({ code: 'PUSH_PLAN_REQUIRED', message: 'x' }, { status: 403, statusText: 'Forbidden' });
    const result = await done;
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'error') expect(result.error.message).toContain('plan Pro');
    expect(subscription.unsubscribe).toHaveBeenCalled();
  });

  it('endpoint hors des services push connus : refusé avant tout envoi', async () => {
    const subscription = fakeSubscription('https://evil.example/push');
    const { push, ctrl } = await setup(fakeWindow(), { isEnabled: true, requestSubscription: vi.fn(() => Promise.resolve(subscription as unknown as PushSubscription)) });
    const done = push.enable();
    ctrl.expectOne(`${API}/push/vapid-public-key`).flush({ publicKey: KEY });
    const result = await done;
    expect(result.ok).toBe(false);
    ctrl.expectNone(`${API}/push/subscriptions`);
  });

  it('permission refusée : motif « denied », pas de relance', async () => {
    const win = fakeWindow({ permission: 'denied' });
    const { push, ctrl } = await setup(win, { isEnabled: true, requestSubscription: vi.fn(() => Promise.reject(new Error('Permission denied'))) });
    const done = push.enable();
    ctrl.expectOne(`${API}/push/vapid-public-key`).flush({ publicKey: KEY });
    expect(await done).toEqual({ ok: false, reason: 'denied' });
  });

  it('désactivation : POST push/unsubscribe { endpoint } puis désabonnement du navigateur', async () => {
    const subscription = fakeSubscription();
    const { push, ctrl, swPush } = await setup(fakeWindow(), { isEnabled: true, subscription: of(subscription as unknown as PushSubscription) });
    const done = push.disable();
    await settle();
    const req = ctrl.expectOne(`${API}/push/unsubscribe`);
    expect(req.request.body).toEqual({ endpoint: subscription.endpoint });
    req.flush(null, { status: 204, statusText: 'No Content' });
    await done;
    expect(swPush.unsubscribe).toHaveBeenCalled();
    expect(push.subscribed()).toBe(false);
  });
});
