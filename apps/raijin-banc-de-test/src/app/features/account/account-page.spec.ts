import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStore } from '../../core/auth/auth-store';
import { SUPABASE } from '../../core/supabase/supabase-client';
import { LOCK_SECONDS, MAX_FAILED_ATTEMPTS } from '../auth/attempt-lock';
import { AccountPage, CHANGE_ERROR_MESSAGE, CHANGE_SUCCESS_MESSAGE, CURRENT_PASSWORD_ERROR } from './account-page';

const session = { access_token: 't', user: { email: 'me@example.com' } } as unknown as Session;
const CURRENT = 'Ancien-Passw0rd!';
const NEXT = 'Tonnerre-2026!';

describe('AccountPage (change password)', () => {
  const calls: string[] = [];
  const auth = {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    signInWithPassword: vi.fn(),
    updateUser: vi.fn(),
    signOut: vi.fn(),
  };
  let fixture: ComponentFixture<AccountPage>;
  let el: HTMLElement;

  beforeEach(async () => {
    calls.length = 0;
    auth.getSession.mockReset().mockResolvedValue({ data: { session } });
    auth.signInWithPassword.mockReset().mockImplementation(async () => {
      calls.push('signInWithPassword');
      return { data: { session, user: session.user }, error: null };
    });
    auth.updateUser.mockReset().mockImplementation(async () => {
      calls.push('updateUser');
      return { data: { user: session.user }, error: null };
    });
    auth.signOut.mockReset().mockImplementation(async () => {
      calls.push('signOut');
      return { error: null };
    });
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: SUPABASE, useValue: { auth } }],
    });
    await TestBed.inject(AuthStore).whenReady();
    fixture = TestBed.createComponent(AccountPage);
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

  async function change(current = CURRENT, next = NEXT) {
    type('#current-password', current);
    type('#new-password', next);
    type('#confirm-password', next);
    el.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const submitBtn = () => el.querySelector<HTMLButtonElement>('form button[type="submit"]');
  const alertText = () => el.querySelector('[role="alert"]')?.textContent?.trim();

  it('asks for the current password with the right autocomplete attributes', () => {
    expect(el.querySelector('#current-password')?.getAttribute('autocomplete')).toBe('current-password');
    expect(el.querySelector('#new-password')?.getAttribute('autocomplete')).toBe('new-password');
    expect(el.querySelector('#confirm-password')?.getAttribute('autocomplete')).toBe('new-password');
    expect(el.textContent).toContain('me@example.com');
  });

  it('keeps submit disabled until the current password is filled', () => {
    type('#new-password', NEXT);
    type('#confirm-password', NEXT);
    expect(submitBtn()?.disabled).toBe(true);
    type('#current-password', CURRENT);
    expect(submitBtn()?.disabled).toBe(false);
  });

  it('signs in with the current password, then updates, then signs out the other sessions', async () => {
    await change();
    expect(calls).toEqual(['signInWithPassword', 'updateUser', 'signOut']);
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: 'me@example.com', password: CURRENT });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: NEXT });
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'others' });
    expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe(CHANGE_SUCCESS_MESSAGE);
    expect(el.querySelector('form')).toBeNull();
  });

  it('shows a generic error on a wrong current password and never calls updateUser', async () => {
    auth.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: { message: 'Invalid login credentials' },
    });
    await change('wrong');
    expect(alertText()).toBe(CURRENT_PASSWORD_ERROR);
    expect(el.textContent).not.toContain('Invalid login credentials');
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(el.querySelector<HTMLInputElement>('#current-password')?.value).toBe('');
  });

  it('shows a generic error when the update itself fails', async () => {
    auth.updateUser.mockResolvedValue({ data: { user: null }, error: { message: 'raw server text' } });
    await change();
    expect(alertText()).toBe(CHANGE_ERROR_MESSAGE);
    expect(el.textContent).not.toContain('raw server text');
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it(`locks after ${MAX_FAILED_ATTEMPTS} wrong current passwords for ${LOCK_SECONDS} s`, async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    auth.signInWithPassword.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'x' } });
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await change('wrong');
    type('#current-password', 'another');
    expect(submitBtn()?.disabled).toBe(true);
    expect(el.textContent).toContain(`Réessaie dans ${LOCK_SECONDS} s`);
    vi.advanceTimersByTime(LOCK_SECONDS * 1000);
    fixture.detectChanges();
    expect(submitBtn()?.disabled).toBe(false);
  });
});
