import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStore } from '../../core/auth/auth-store';
import { LOCK_SECONDS, LOGIN_ERROR_MESSAGE, LoginPage, MAX_FAILED_ATTEMPTS } from './login-page';

describe('LoginPage', () => {
  const signInWithPassword = vi.fn<(email: string, password: string) => Promise<boolean>>();
  let fixture: ComponentFixture<LoginPage>;
  let el: HTMLElement;
  let navigateByUrl: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    signInWithPassword.mockReset();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthStore, useValue: { signInWithPassword } }],
    });
    navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    fixture = TestBed.createComponent(LoginPage);
    el = fixture.nativeElement;
    fixture.detectChanges();
  });

  afterEach(() => vi.useRealTimers());

  function type(selector: string, value: string) {
    const input = el.querySelector<HTMLInputElement>(selector);
    if (!input) throw new Error(`${selector} not found`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  async function login(email = ' Me@Example.com ', password = 'secret-pass') {
    type('#email', email);
    type('#password', password);
    el.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const submitBtn = () => el.querySelector<HTMLButtonElement>('form button[type="submit"]');

  it('has the right autocomplete attributes and an accessible show/hide toggle', () => {
    expect(el.querySelector('#email')?.getAttribute('autocomplete')).toBe('email');
    const password = el.querySelector<HTMLInputElement>('#password');
    expect(password?.getAttribute('autocomplete')).toBe('current-password');
    expect(password?.type).toBe('password');
    const toggle = el.querySelector<HTMLButtonElement>('button[aria-controls="password"]');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    expect(toggle?.getAttribute('aria-label')).toBe('Afficher le mot de passe');
    toggle?.click();
    fixture.detectChanges();
    expect(password?.type).toBe('text');
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    expect(toggle?.getAttribute('aria-label')).toBe('Masquer le mot de passe');
  });

  it('links to the forgot-password page', () => {
    const link = Array.from(el.querySelectorAll('a')).find((a) => a.textContent?.includes('Mot de passe oublié'));
    expect(link?.getAttribute('href')).toBe('/forgot-password');
  });

  it('keeps submit disabled until e-mail and password are filled', () => {
    expect(submitBtn()?.disabled).toBe(true);
    type('#email', 'me@example.com');
    expect(submitBtn()?.disabled).toBe(true);
    type('#password', 'x');
    expect(submitBtn()?.disabled).toBe(false);
  });

  it('signs in with the normalised e-mail and redirects to / on success', async () => {
    signInWithPassword.mockResolvedValue(true);
    await login();
    expect(signInWithPassword).toHaveBeenCalledWith('me@example.com', 'secret-pass');
    expect(navigateByUrl).toHaveBeenCalledWith('/', { replaceUrl: true });
  });

  it('shows a generic error message on failure and does not redirect', async () => {
    signInWithPassword.mockResolvedValue(false);
    await login();
    expect(navigateByUrl).not.toHaveBeenCalled();
    expect(el.querySelector('[role="alert"]')?.textContent?.trim()).toBe(LOGIN_ERROR_MESSAGE);
  });

  it('disables submit while the request is pending', async () => {
    let resolve: (ok: boolean) => void = () => undefined;
    signInWithPassword.mockReturnValue(new Promise<boolean>((r) => (resolve = r)));
    type('#email', 'me@example.com');
    type('#password', 'pw');
    el.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    fixture.detectChanges();
    expect(submitBtn()?.disabled).toBe(true);
    expect(submitBtn()?.textContent).toContain('Connexion…');
    resolve(false);
    await fixture.whenStable();
  });

  it(`locks the button after ${MAX_FAILED_ATTEMPTS} failures and unlocks after ${LOCK_SECONDS} s`, async () => {
    // Only the countdown interval is faked: the zoneless scheduler keeps its real timers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    signInWithPassword.mockResolvedValue(false);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await login();
    expect(signInWithPassword).toHaveBeenCalledTimes(MAX_FAILED_ATTEMPTS);

    type('#password', 'another');
    expect(submitBtn()?.disabled).toBe(true);
    expect(el.textContent).toContain(`Réessaie dans ${LOCK_SECONDS} s`);

    vi.advanceTimersByTime(10_000);
    fixture.detectChanges();
    expect(el.textContent).toContain(`Réessaie dans ${LOCK_SECONDS - 10} s`);
    expect(submitBtn()?.disabled).toBe(true);

    vi.advanceTimersByTime((LOCK_SECONDS - 10) * 1000);
    fixture.detectChanges();
    expect(el.textContent).not.toContain('Réessaie dans');
    expect(submitBtn()?.disabled).toBe(false);

    // Counter was reset: one more failure does not lock again.
    await login();
    type('#password', 'again');
    expect(submitBtn()?.disabled).toBe(false);
  });

  it('resets the failure counter on success', async () => {
    signInWithPassword.mockResolvedValue(false);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) await login();
    signInWithPassword.mockResolvedValueOnce(true);
    await login();
    expect(fixture.componentInstance.failedAttempts()).toBe(0);
    await login();
    type('#password', 'again');
    expect(submitBtn()?.disabled).toBe(false);
  });
});
