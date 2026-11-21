import { TestBed } from '@angular/core/testing';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPABASE } from '../supabase/supabase-client';
import { AuthStore } from './auth-store';

const session = { access_token: 't', user: { email: 'a@b.co' } } as unknown as Session;

type AuthListener = (event: AuthChangeEvent, session: Session | null) => void;

function setup(initial: { session?: Session | null } = {}) {
  const listeners: AuthListener[] = [];
  const unsubscribe = vi.fn();
  const auth = {
    getSession: vi.fn().mockResolvedValue({ data: { session: initial.session ?? null } }),
    onAuthStateChange: vi.fn((cb: AuthListener) => {
      listeners.push(cb);
      return { data: { subscription: { unsubscribe } } };
    }),
    signInWithPassword: vi.fn(),
    resetPasswordForEmail: vi.fn().mockResolvedValue({ data: {}, error: null }),
    updateUser: vi.fn(),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  };
  TestBed.configureTestingModule({ providers: [{ provide: SUPABASE, useValue: { auth } }] });
  return { auth, listeners, unsubscribe, store: TestBed.inject(AuthStore) };
}

describe('AuthStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  describe('signInWithPassword', () => {
    it('stores the session and returns true on success', async () => {
      const { auth, store } = setup();
      await store.whenReady();
      auth.signInWithPassword.mockResolvedValue({ data: { session, user: session.user }, error: null });
      await expect(store.signInWithPassword('a@b.co', 'pw')).resolves.toBe(true);
      expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: 'a@b.co', password: 'pw' });
      expect(store.isAuthenticated()).toBe(true);
    });

    it('returns false on a Supabase error', async () => {
      const { auth, store } = setup();
      auth.signInWithPassword.mockResolvedValue({
        data: { session: null, user: null },
        error: { message: 'Invalid login credentials' },
      });
      await expect(store.signInWithPassword('a@b.co', 'bad')).resolves.toBe(false);
      expect(store.isAuthenticated()).toBe(false);
    });

    it('returns false when the call throws', async () => {
      const { auth, store } = setup();
      auth.signInWithPassword.mockRejectedValue(new Error('network'));
      await expect(store.signInWithPassword('a@b.co', 'pw')).resolves.toBe(false);
    });
  });

  describe('requestPasswordReset', () => {
    it('redirects the reset link to /auth/reset', async () => {
      const { auth, store } = setup();
      await store.requestPasswordReset('a@b.co');
      expect(auth.resetPasswordForEmail).toHaveBeenCalledWith('a@b.co', {
        redirectTo: `${window.location.origin}/auth/reset`,
      });
    });

    it('never throws', async () => {
      const { auth, store } = setup();
      auth.resetPasswordForEmail.mockRejectedValue(new Error('network'));
      await expect(store.requestPasswordReset('a@b.co')).resolves.toBeUndefined();
    });
  });

  describe('recoveryPending', () => {
    it('subscribes to auth events synchronously at construction, before getSession', () => {
      const { auth } = setup();
      expect(auth.onAuthStateChange).toHaveBeenCalledTimes(1);
      expect(auth.onAuthStateChange.mock.invocationCallOrder[0]).toBeLessThan(
        auth.getSession.mock.invocationCallOrder[0],
      );
    });

    it('is set only by a PASSWORD_RECOVERY event', async () => {
      const { listeners, store } = setup();
      await store.whenReady();
      expect(store.recoveryPending()).toBe(false);
      for (const event of ['INITIAL_SESSION', 'SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED'] as const) {
        listeners[0](event, session);
        expect(store.recoveryPending(), event).toBe(false);
      }
      listeners[0]('PASSWORD_RECOVERY', session);
      expect(store.recoveryPending()).toBe(true);
      expect(store.isAuthenticated()).toBe(true);
    });

    it('is not set by an existing session alone', async () => {
      const { auth, store } = setup({ session });
      await store.whenReady();
      expect(auth.getSession).toHaveBeenCalled();
      expect(store.isAuthenticated()).toBe(true);
      expect(store.recoveryPending()).toBe(false);
    });

    it('records an event emitted before getSession resolves', async () => {
      const { listeners, store } = setup();
      listeners[0]('PASSWORD_RECOVERY', session);
      await store.whenReady();
      expect(store.recoveryPending()).toBe(true);
    });

    it('is cleared after a successful password update', async () => {
      const { auth, listeners, store } = setup();
      listeners[0]('PASSWORD_RECOVERY', session);
      auth.updateUser.mockResolvedValueOnce({ data: { user: null }, error: { message: 'weak' } });
      await store.updatePassword('x');
      expect(store.recoveryPending()).toBe(true);
      auth.updateUser.mockResolvedValueOnce({ data: { user: session.user }, error: null });
      await store.updatePassword('N3w-Password!!');
      expect(store.recoveryPending()).toBe(false);
    });

    it('is cleared on sign-out and on a SIGNED_OUT event', async () => {
      const { listeners, store } = setup();
      listeners[0]('PASSWORD_RECOVERY', session);
      await store.signOut();
      expect(store.recoveryPending()).toBe(false);
      listeners[0]('PASSWORD_RECOVERY', session);
      listeners[0]('SIGNED_OUT', null);
      expect(store.recoveryPending()).toBe(false);
      expect(store.isAuthenticated()).toBe(false);
    });

    it('unsubscribes when the injector is destroyed', () => {
      const { unsubscribe } = setup();
      TestBed.resetTestingModule();
      expect(unsubscribe).toHaveBeenCalled();
    });
  });

  describe('changePassword', () => {
    async function signedIn() {
      const ctx = setup({ session });
      await ctx.store.whenReady();
      return ctx;
    }

    it('verifies the current password, then updates, then signs out the other sessions', async () => {
      const { auth, store } = await signedIn();
      const calls: string[] = [];
      auth.signInWithPassword.mockImplementation(async () => {
        calls.push('signInWithPassword');
        return { data: { session, user: session.user }, error: null };
      });
      auth.updateUser.mockImplementation(async () => {
        calls.push('updateUser');
        return { data: { user: session.user }, error: null };
      });
      auth.signOut.mockImplementation(async () => {
        calls.push('signOut');
        return { error: null };
      });
      await expect(store.changePassword('old-Passw0rd!', 'N3w-Password!!')).resolves.toBe('ok');
      expect(calls).toEqual(['signInWithPassword', 'updateUser', 'signOut']);
      expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: 'a@b.co', password: 'old-Passw0rd!' });
      expect(auth.updateUser).toHaveBeenCalledWith({ password: 'N3w-Password!!' });
      expect(auth.signOut).toHaveBeenCalledWith({ scope: 'others' });
    });

    it('stops at a wrong current password: no updateUser, no signOut', async () => {
      const { auth, store } = await signedIn();
      auth.signInWithPassword.mockResolvedValue({
        data: { session: null, user: null },
        error: { message: 'Invalid login credentials' },
      });
      await expect(store.changePassword('wrong', 'N3w-Password!!')).resolves.toBe('wrong-current');
      expect(auth.updateUser).not.toHaveBeenCalled();
      expect(auth.signOut).not.toHaveBeenCalled();
      expect(store.isAuthenticated()).toBe(true);
    });

    it('reports update-failed and keeps the other sessions when updateUser fails', async () => {
      const { auth, store } = await signedIn();
      auth.signInWithPassword.mockResolvedValue({ data: { session, user: session.user }, error: null });
      auth.updateUser.mockResolvedValue({ data: { user: null }, error: { message: 'reauthentication_needed' } });
      await expect(store.changePassword('old-Passw0rd!', 'N3w-Password!!')).resolves.toBe('update-failed');
      expect(auth.signOut).not.toHaveBeenCalled();
    });

    it('refuses without a signed-in e-mail', async () => {
      const { auth, store } = setup();
      await store.whenReady();
      await expect(store.changePassword('x', 'N3w-Password!!')).resolves.toBe('wrong-current');
      expect(auth.signInWithPassword).not.toHaveBeenCalled();
    });
  });

  describe('updatePassword', () => {
    it('returns true on success', async () => {
      const { auth, store } = setup();
      auth.updateUser.mockResolvedValue({ data: { user: session.user }, error: null });
      await expect(store.updatePassword('N3w-Password!!')).resolves.toBe(true);
      expect(auth.updateUser).toHaveBeenCalledWith({ password: 'N3w-Password!!' });
    });

    it('returns false on error or throw', async () => {
      const { auth, store } = setup();
      auth.updateUser.mockResolvedValueOnce({ data: { user: null }, error: { message: 'weak' } });
      await expect(store.updatePassword('x')).resolves.toBe(false);
      auth.updateUser.mockRejectedValueOnce(new Error('network'));
      await expect(store.updatePassword('x')).resolves.toBe(false);
    });
  });

  it('signs out the other sessions only, without throwing', async () => {
    const { auth, store } = setup();
    await store.signOutOtherSessions();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'others' });
    auth.signOut.mockRejectedValueOnce(new Error('network'));
    await expect(store.signOutOtherSessions()).resolves.toBeUndefined();
  });
});
