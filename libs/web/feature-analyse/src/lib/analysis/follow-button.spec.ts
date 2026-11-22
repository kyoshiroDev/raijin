import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import {
  AUTH_INTERCEPTORS,
  AuthStore,
  CsrfToken,
  FIXTURE_MINTS,
  fakeSession,
  fakeWatch,
  fakeWatchList,
  loadContracts,
} from '@raijin/web-data-access';
import { RjFollowButton } from './follow-button';

@Component({ template: '' })
class Blank {}

const API = '/api/v1';
const MINT = FIXTURE_MINTS.bonk;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup(auth: 'anonymous' | 'verified' | 'unverified') {
  await loadContracts();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', component: Blank }]),
      provideHttpClient(withInterceptors([...AUTH_INTERCEPTORS])),
      provideHttpClientTesting(),
    ],
  });
  const store = TestBed.inject(AuthStore);
  if (auth === 'anonymous') store.clear();
  else store.applySession(fakeSession({ emailVerified: auth === 'verified' }));
  store.whenReady = () => Promise.resolve();
  TestBed.inject(CsrfToken).set('csrf-session-token-0123456789abcdef');
  const fixture = TestBed.createComponent(RjFollowButton);
  fixture.componentRef.setInput('mint', MINT);
  await fixture.whenStable();
  const ctrl = TestBed.inject(HttpTestingController);
  const host = fixture.nativeElement as HTMLElement;
  const button = () => host.querySelector<HTMLButtonElement>('button[data-follow]') as HTMLButtonElement;
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  return { fixture, ctrl, host, button, dialog, router: TestBed.inject(Router) };
}

async function flushList(ctrl: HttpTestingController, list = fakeWatchList([])) {
  ctrl.expectOne(`${API}/watches`).flush(list);
  await settle();
}

describe('RjFollowButton', () => {
  afterEach(() => document.querySelectorAll('[role="dialog"]').forEach((el) => el.remove()));

  it('visiteur : connexion avec retour sur l’analyse, sans requête de suivi', async () => {
    const { button, ctrl, router, fixture } = await setup('anonymous');
    expect(button().textContent).toContain('Suivre');
    button().click();
    await fixture.whenStable();
    await settle();
    expect(router.url).toBe(`/compte/connexion?redirect=%2Fanalyse%2F${MINT}`);
    ctrl.expectNone(`${API}/watches`);
  });

  it('e-mail non confirmé : explication et lien de confirmation', async () => {
    const { button, dialog, fixture, ctrl } = await setup('unverified');
    ctrl.expectNone(`${API}/watches`);
    button().click();
    await fixture.whenStable();
    await settle();
    await fixture.whenStable();
    expect(dialog()?.textContent).toContain('Confirme ton adresse e-mail');
    expect(dialog()?.querySelector('a')?.getAttribute('href')).toBe('/compte/verifier-email');
  });

  it('suivre : POST watches { mint }, puis état « Suivi » (aria-pressed)', async () => {
    const { button, fixture, ctrl } = await setup('verified');
    await flushList(ctrl);
    button().click();
    await settle();
    const req = ctrl.expectOne(`${API}/watches`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ mint: MINT });
    req.flush(fakeWatch({ mint: MINT }), { status: 201, statusText: 'Created' });
    await settle();
    await fixture.whenStable();
    expect(button().textContent).toContain('Suivi');
    expect(button().getAttribute('aria-pressed')).toBe('true');
  });

  it('limite atteinte : bottom sheet explicative avec le plan, sans urgence', async () => {
    const { button, dialog, fixture, ctrl } = await setup('verified');
    await flushList(ctrl, fakeWatchList([fakeWatch({ mint: FIXTURE_MINTS.usdc })], { maxActiveWatches: 3 }));
    button().click();
    await settle();
    ctrl
      .expectOne((r) => r.method === 'POST' && r.url === `${API}/watches`)
      .flush({ code: 'WATCH_LIMIT_REACHED', message: 'x' }, { status: 403, statusText: 'Forbidden' });
    await settle();
    ctrl.match(`${API}/watches`).forEach((r) => r.flush(fakeWatchList([fakeWatch({ mint: FIXTURE_MINTS.usdc })])));
    await settle();
    await fixture.whenStable();
    const text = dialog()?.textContent ?? '';
    expect(text).toContain('Limite de suivis atteinte');
    expect(text).toContain('plan Gratuit permet 3 suivis actifs');
    expect(text).not.toMatch(/vite|dernière chance|dépêche/i);
    expect(dialog()?.querySelector('a[href="/suivis"]')).not.toBeNull();
    // Gratuit hors essai : lien sobre vers la page Abonnement (plus de lien provisoire vers /compte).
    expect(dialog()?.querySelector('[data-limit-upgrade] a')?.getAttribute('href')).toBe('/abonnement');
    expect(dialog()?.querySelector('a[href="/compte"]')).toBeNull();
  });

  it('déjà suivi : « Ne plus suivre » après confirmation (DELETE)', async () => {
    const watch = fakeWatch({ mint: MINT });
    const { button, dialog, fixture, ctrl } = await setup('verified');
    await flushList(ctrl, fakeWatchList([watch]));
    await fixture.whenStable();
    expect(button().textContent).toContain('Suivi');
    button().click();
    await fixture.whenStable();
    await settle();
    const confirm = Array.from(dialog()?.querySelectorAll('button') ?? []).find((b) => b.textContent?.includes('Ne plus suivre'));
    confirm?.click();
    const req = ctrl.expectOne(`${API}/watches/${watch.id}`);
    expect(req.request.method).toBe('DELETE');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    await fixture.whenStable();
    expect(button().textContent).toContain('Suivre');
    expect(button().getAttribute('aria-pressed')).toBe('false');
  });
});
