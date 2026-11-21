import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStore } from '../../core/auth/auth-store';
import {
  INVALID_LINK_MESSAGE,
  RECOVERY_TIMEOUT_MS,
  ResetPasswordPage,
  SESSION_SETTLE_MS,
  UPDATE_ERROR_MESSAGE,
} from './reset-password-page';

const STRONG = 'Tonnerre-2026!';

describe('ResetPasswordPage', () => {
  const recoveryPending = signal(false);
  const isAuthenticated = signal(false);
  const auth = {
    recoveryPending: recoveryPending.asReadonly(),
    isAuthenticated: isAuthenticated.asReadonly(),
    whenReady: vi.fn<() => Promise<void>>(),
    updatePassword: vi.fn<(password: string) => Promise<boolean>>(),
    signOutOtherSessions: vi.fn<() => Promise<void>>(),
  };
  let fixture: ComponentFixture<ResetPasswordPage>;
  let el: HTMLElement;
  let navigateByUrl: ReturnType<typeof vi.spyOn>;
  const calls: string[] = [];
  const initialUrl = window.location.href;

  beforeEach(() => {
    calls.length = 0;
    recoveryPending.set(false);
    isAuthenticated.set(false);
    auth.whenReady.mockReset().mockResolvedValue(undefined);
    auth.updatePassword.mockReset().mockImplementation(async () => {
      calls.push('updatePassword');
      recoveryPending.set(false); // like the real store
      return true;
    });
    auth.signOutOtherSessions.mockReset().mockImplementation(async () => {
      calls.push('signOutOtherSessions');
    });
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthStore, useValue: auth }],
    });
    navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockImplementation(async () => {
      calls.push('navigate');
      return true;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState(null, '', initialUrl);
  });

  async function create() {
    fixture = TestBed.createComponent(ResetPasswordPage);
    el = fixture.nativeElement;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /** Advances fake timers and lets the whenReady() continuation run. */
  async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    fixture.detectChanges();
  }

  function type(selector: string, value: string) {
    const input = el.querySelector<HTMLInputElement>(selector);
    if (!input) throw new Error(`${selector} not found`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  async function submit() {
    el.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const submitBtn = () => el.querySelector<HTMLButtonElement>('form button[type="submit"]');

  it(`shows the invalid-link message after ${RECOVERY_TIMEOUT_MS / 1000} s without session nor event`, async () => {
    vi.useFakeTimers();
    await create();
    expect(el.textContent).toContain('Vérification du lien');
    await advance(RECOVERY_TIMEOUT_MS - 1);
    expect(el.textContent).not.toContain(INVALID_LINK_MESSAGE);
    await advance(1);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(INVALID_LINK_MESSAGE);
    const link = Array.from(el.querySelectorAll('a')).find((a) => a.textContent?.includes('Redemander'));
    expect(link?.getAttribute('href')).toBe('/forgot-password');
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it('shows the invalid-link message right away when the URL carries an error', async () => {
    window.history.replaceState(null, '', '/auth/reset?error=access_denied&error_code=otp_expired');
    recoveryPending.set(true);
    await create();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(INVALID_LINK_MESSAGE);
    expect(el.querySelector('#new-password')).toBeNull();
  });

  it('shows the form when PASSWORD_RECOVERY was already received during this page load', async () => {
    isAuthenticated.set(true);
    recoveryPending.set(true);
    await create();
    expect(el.querySelector('#new-password')?.getAttribute('autocomplete')).toBe('new-password');
    expect(el.querySelector('#confirm-password')?.getAttribute('autocomplete')).toBe('new-password');
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it('shows the form when PASSWORD_RECOVERY arrives within the timeout', async () => {
    vi.useFakeTimers();
    isAuthenticated.set(true); // the code exchange stores the session just before the event
    await create();
    expect(el.querySelector('#new-password')).toBeNull();
    recoveryPending.set(true);
    await advance(SESSION_SETTLE_MS - 1);
    expect(el.querySelector('#new-password')).not.toBeNull();
    await advance(RECOVERY_TIMEOUT_MS);
    expect(el.querySelector('#new-password')).not.toBeNull();
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it('redirects a normal session (no recovery event) to / and never shows the form', async () => {
    vi.useFakeTimers();
    isAuthenticated.set(true);
    await create();
    expect(el.querySelector('#new-password')).toBeNull();
    await advance(SESSION_SETTLE_MS);
    expect(navigateByUrl).toHaveBeenCalledWith('/', { replaceUrl: true });
    expect(el.querySelector('#new-password')).toBeNull();
    expect(auth.updatePassword).not.toHaveBeenCalled();
  });

  it('redirects to / at the timeout when a session appears without a recovery event', async () => {
    vi.useFakeTimers();
    await create();
    await advance(SESSION_SETTLE_MS);
    isAuthenticated.set(true);
    await advance(RECOVERY_TIMEOUT_MS);
    expect(navigateByUrl).toHaveBeenCalledWith('/', { replaceUrl: true });
    expect(el.textContent).not.toContain(INVALID_LINK_MESSAGE);
  });

  it('does nothing after destroy', async () => {
    vi.useFakeTimers();
    isAuthenticated.set(true);
    await create();
    fixture.destroy();
    await vi.advanceTimersByTimeAsync(RECOVERY_TIMEOUT_MS);
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it('keeps submit disabled until every rule passes and both passwords match', async () => {
    recoveryPending.set(true);
    await create();
    type('#new-password', STRONG);
    type('#confirm-password', `${STRONG}x`);
    expect(submitBtn()?.disabled).toBe(true);
    expect(el.querySelector('[data-rule="match"]')?.classList.contains('text-bull')).toBe(false);
    type('#confirm-password', STRONG);
    expect(submitBtn()?.disabled).toBe(false);
    expect(el.querySelectorAll('[data-rule].text-bull').length).toBe(6);
  });

  it('updates the password, then signs out other sessions, then redirects to /', async () => {
    recoveryPending.set(true);
    await create();
    type('#new-password', STRONG);
    type('#confirm-password', STRONG);
    await submit();
    expect(auth.updatePassword).toHaveBeenCalledWith(STRONG);
    expect(calls).toEqual(['updatePassword', 'signOutOtherSessions', 'navigate']);
    expect(navigateByUrl).toHaveBeenCalledWith('/', { replaceUrl: true });
  });

  it('shows a generic message when the update fails and stays on the page', async () => {
    recoveryPending.set(true);
    auth.updatePassword.mockResolvedValue(false);
    await create();
    type('#new-password', STRONG);
    type('#confirm-password', STRONG);
    await submit();
    expect(el.querySelector('[role="alert"]')?.textContent?.trim()).toBe(UPDATE_ERROR_MESSAGE);
    expect(auth.signOutOtherSessions).not.toHaveBeenCalled();
    expect(navigateByUrl).not.toHaveBeenCalled();
  });
});
