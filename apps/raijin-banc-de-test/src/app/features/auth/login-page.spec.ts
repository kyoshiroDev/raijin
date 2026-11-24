import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { BenchLoginRequest } from '@raijin/bench-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStore, type SignInResult } from '../../core/auth/auth-store';
import { LOCK_SECONDS, LOGIN_ERROR_MESSAGE, LOGIN_MESSAGES, LoginPage, MAX_FAILED_ATTEMPTS, normalizeSecondFactor } from './login-page';

describe('normalizeSecondFactor', () => {
  it('accepts 6 digits (spaces removed) for the TOTP and nothing else', () => {
    expect(normalizeSecondFactor('totp', '123 456')).toBe('123456');
    expect(normalizeSecondFactor('totp', '12345')).toBeNull();
    expect(normalizeSecondFactor('totp', 'abcdef')).toBeNull();
  });

  it('accepts a recovery code in any case', () => {
    expect(normalizeSecondFactor('recovery', 'abcde-fgh23')).toBe('ABCDE-FGH23');
    expect(normalizeSecondFactor('recovery', 'ABCDE-FGH2')).toBeNull();
  });
});

describe('LoginPage', () => {
  const signIn = vi.fn<(request: BenchLoginRequest) => Promise<SignInResult>>();
  let fixture: ComponentFixture<LoginPage>;
  let el: HTMLElement;
  let navigateByUrl: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    signIn.mockReset();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthStore, useValue: { signIn } }],
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

  async function login(email = ' Me@Example.com ', password = 'secret-pass', code = '123 456') {
    type('#email', email);
    type('#password', password);
    type('#code', code);
    el.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const submitBtn = () => el.querySelector<HTMLButtonElement>('form button[type="submit"]');
  const toggleBtn = () =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button[type="button"]')).find((b) => b.textContent?.includes('Utiliser'));

  it('has the right autocomplete attributes and an accessible show/hide toggle', () => {
    expect(el.querySelector('#email')?.getAttribute('autocomplete')).toBe('username');
    expect(el.querySelector('#code')?.getAttribute('autocomplete')).toBe('one-time-code');
    expect(el.querySelector('#code')?.getAttribute('inputmode')).toBe('numeric');
    const password = el.querySelector<HTMLInputElement>('#password');
    expect(password?.getAttribute('autocomplete')).toBe('current-password');
    expect(password?.type).toBe('password');
    const toggle = el.querySelector<HTMLButtonElement>('button[aria-controls="password"]');
    expect(toggle?.getAttribute('aria-label')).toBe('Afficher le mot de passe');
    toggle?.click();
    fixture.detectChanges();
    expect(password?.type).toBe('text');
  });

  it('offers no sign-up nor password reset link', () => {
    expect(el.querySelectorAll('a').length).toBe(0);
    expect(el.textContent).not.toContain('oublié');
  });

  it('keeps submit disabled until e-mail, password and a well-formed code are filled', () => {
    expect(submitBtn()?.disabled).toBe(true);
    type('#email', 'me@example.com');
    type('#password', 'x');
    expect(submitBtn()?.disabled).toBe(true);
    type('#code', '12345');
    expect(submitBtn()?.disabled).toBe(true);
    type('#code', '123456');
    expect(submitBtn()?.disabled).toBe(false);
  });

  it('signs in with the normalised e-mail and the TOTP, then redirects to /', async () => {
    signIn.mockResolvedValue('ok');
    await login();
    expect(signIn).toHaveBeenCalledWith({ email: 'me@example.com', password: 'secret-pass', totp: '123456' });
    expect(navigateByUrl).toHaveBeenCalledWith('/', { replaceUrl: true });
  });

  it('switches to a recovery code (never both factors sent)', async () => {
    signIn.mockResolvedValue('ok');
    toggleBtn()?.click();
    fixture.detectChanges();
    expect(el.querySelector('label[for="code"]')?.textContent).toContain('Code de secours');
    await login('me@example.com', 'pw', 'abcde-fgh23');
    expect(signIn).toHaveBeenCalledWith({ email: 'me@example.com', password: 'pw', recovery_code: 'ABCDE-FGH23' });
  });

  it('shows one generic message on failure, clears the secrets and does not redirect', async () => {
    signIn.mockResolvedValue('invalid');
    await login();
    expect(navigateByUrl).not.toHaveBeenCalled();
    expect(el.querySelector('[role="alert"]')?.textContent?.trim()).toBe(LOGIN_ERROR_MESSAGE);
    expect(el.querySelector<HTMLInputElement>('#password')?.value).toBe('');
    expect(el.querySelector<HTMLInputElement>('#code')?.value).toBe('');
  });

  it('tells apart a throttled or unreachable API', async () => {
    signIn.mockResolvedValue('throttled');
    await login();
    expect(el.querySelector('[role="alert"]')?.textContent?.trim()).toBe(LOGIN_MESSAGES.throttled);
    signIn.mockResolvedValue('error');
    await login();
    expect(el.querySelector('[role="alert"]')?.textContent?.trim()).toBe(LOGIN_MESSAGES.error);
    expect(fixture.componentInstance.failedAttempts()).toBe(0);
  });

  it('disables submit while the request is pending', async () => {
    let resolve: (r: SignInResult) => void = () => undefined;
    signIn.mockReturnValue(new Promise<SignInResult>((r) => (resolve = r)));
    type('#email', 'me@example.com');
    type('#password', 'pw');
    type('#code', '123456');
    el.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    fixture.detectChanges();
    expect(submitBtn()?.disabled).toBe(true);
    expect(submitBtn()?.textContent).toContain('Connexion…');
    resolve('invalid');
    await fixture.whenStable();
  });

  it(`locks the button after ${MAX_FAILED_ATTEMPTS} failures and unlocks after ${LOCK_SECONDS} s`, async () => {
    // Only the countdown interval is faked: the zoneless scheduler keeps its real timers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    signIn.mockResolvedValue('invalid');
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await login();
    expect(signIn).toHaveBeenCalledTimes(MAX_FAILED_ATTEMPTS);

    type('#password', 'another');
    type('#code', '654321');
    expect(submitBtn()?.disabled).toBe(true);
    expect(el.textContent).toContain(`Réessaie dans ${LOCK_SECONDS} s`);

    vi.advanceTimersByTime(LOCK_SECONDS * 1000);
    fixture.detectChanges();
    expect(el.textContent).not.toContain('Réessaie dans');
    expect(submitBtn()?.disabled).toBe(false);
  });
});
