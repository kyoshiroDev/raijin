import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PushService, fakeNotificationSettings, loadContracts, type PushEnableResult } from '@raijin/web-data-access';
import { IOS_PUSH_HELP, RjNotificationSettings } from './notification-settings';

const API = '/api/v1';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakePush {
  availabilityValue: 'available' | 'ios-install' | 'unsupported' = 'available';
  permissionValue: NotificationPermission = 'default';
  result: PushEnableResult = { ok: true };
  availability = () => this.availabilityValue;
  permission = () => this.permissionValue;
  refresh = vi.fn(() => Promise.resolve(false));
  enable = vi.fn(() => Promise.resolve(this.result));
  disable = vi.fn(() => Promise.resolve());
}

async function setup(settings = fakeNotificationSettings(), configure: (push: FakePush) => void = () => undefined) {
  await loadContracts();
  const push = new FakePush();
  configure(push);
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), { provide: PushService, useValue: push }],
  });
  const fixture = TestBed.createComponent(RjNotificationSettings);
  const ctrl = TestBed.inject(HttpTestingController);
  const host = fixture.nativeElement as HTMLElement;
  await fixture.whenStable();
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  ctrl.expectOne(`${API}/notifications/settings`).flush(settings);
  await settle();
  await fixture.whenStable();
  const switchOf = (key: string) => host.querySelector<HTMLButtonElement>(`[data-pref="${key}"] button[role="switch"]`) as HTMLButtonElement;
  return { fixture, ctrl, host, push, switchOf };
}

describe('RjNotificationSettings', () => {
  // Le `host: { id: 'notifications' }` remplace l'id `rootN` posé par TestBed sur l'élément hôte :
  // le nettoyage de TestBed (qui retire les `[id^="root"]`) ne le trouve plus. Sans ce retrait,
  // l'élément survit dans le document partagé par les fichiers d'un même worker et fausse les
  // `getElementById` des autres specs (ex. ?section=notifications de AccountPage).
  afterEach(() => document.querySelectorAll('body > #notifications').forEach((el) => el.remove()));

  it('Gratuit : e-mail actif, push désactivé avec un message neutre, aucune demande de permission', async () => {
    const { host, switchOf, push } = await setup(fakeNotificationSettings({ pushAllowed: false }));
    expect(switchOf('emailAlerts').getAttribute('aria-checked')).toBe('true');
    expect(switchOf('pushAlerts').disabled).toBe(true);
    expect(switchOf('pushAlerts').getAttribute('aria-checked')).toBe('false');
    const text = host.textContent ?? '';
    expect(text).toContain('font partie du plan Pro');
    expect(text).not.toMatch(/vite|dernière chance|dépêche|ne rate/i);
    expect(host.querySelector('[data-push-device]')).toBeNull();
    expect(push.enable).not.toHaveBeenCalled();
  });

  it('préférence modifiée : PATCH partiel, annulée si l’API refuse', async () => {
    const { fixture, ctrl, switchOf } = await setup();
    switchOf('weeklyDigest').click();
    const req = ctrl.expectOne(`${API}/notifications/preferences`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ weeklyDigest: true });
    req.flush(fakeNotificationSettings({ preferences: { emailAlerts: true, pushAlerts: true, weeklyDigest: true } }));
    await settle();
    await fixture.whenStable();
    expect(switchOf('weeklyDigest').getAttribute('aria-checked')).toBe('true');
    switchOf('emailAlerts').click();
    ctrl.expectOne(`${API}/notifications/preferences`).flush({ code: 'INTERNAL_ERROR', message: 'x' }, { status: 500, statusText: 'Error' });
    await settle();
    await fixture.whenStable();
    expect(switchOf('emailAlerts').getAttribute('aria-checked')).toBe('true');
  });

  it('Pro : permission demandée seulement au clic sur « Activer sur cet appareil »', async () => {
    const { fixture, host, push } = await setup(fakeNotificationSettings({ pushAllowed: true }));
    expect(push.enable).not.toHaveBeenCalled();
    const activate = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Activer sur cet appareil'));
    activate?.click();
    await settle();
    await fixture.whenStable();
    expect(push.enable).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Activées sur cet appareil');
    expect(host.textContent).toContain('1 appareil reçoit tes notifications.');
  });

  it('push refusé pour e-mail non confirmé : message et lien de renvoi', async () => {
    const { fixture, host } = await setup(fakeNotificationSettings({ pushAllowed: true }), (push) => {
      push.result = { ok: false, reason: 'error', error: { code: 'AUTH_EMAIL_NOT_VERIFIED', message: 'x', status: 403 } };
    });
    Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Activer sur cet appareil'))?.click();
    await settle();
    await fixture.whenStable();
    const error = host.querySelector('[data-push-error]');
    expect(error?.textContent).toContain('Confirme d’abord ton adresse e-mail');
    expect(error?.querySelector('a')?.getAttribute('href')).toBe('/compte/verifier-email');
  });

  it('iPhone hors PWA : explication « écran d’accueil » au lieu du bouton', async () => {
    const { host } = await setup(fakeNotificationSettings({ pushAllowed: true }), (push) => (push.availabilityValue = 'ios-install'));
    expect(host.querySelector('[data-ios-help]')?.textContent).toContain(IOS_PUSH_HELP);
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent?.includes('Activer sur cet appareil'))).toBe(false);
  });

  it('permission refusée : message neutre, bouton désactivé (pas de relance)', async () => {
    const { host } = await setup(fakeNotificationSettings({ pushAllowed: true }), (push) => (push.permissionValue = 'denied'));
    expect(host.querySelector('[data-push-denied]')).not.toBeNull();
    const activate = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Activer sur cet appareil'));
    expect(activate?.disabled).toBe(true);
  });

  it('e-mail non confirmé : alertes e-mail indisponibles, lien de confirmation', async () => {
    const { host, switchOf } = await setup(fakeNotificationSettings({ emailVerified: false }));
    expect(switchOf('emailAlerts').disabled).toBe(true);
    expect(host.querySelector('a[href="/compte/verifier-email"]')).not.toBeNull();
  });

  it('erreur de chargement : message et « Réessayer »', async () => {
    await loadContracts();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), { provide: PushService, useValue: new FakePush() }],
    });
    const fixture = TestBed.createComponent(RjNotificationSettings);
    await fixture.whenStable();
    TestBed.inject(HttpTestingController).expectOne(`${API}/notifications/settings`).error(new ProgressEvent('error'));
    await settle();
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Raijin n’a pas pu charger tes préférences');
  });
});
