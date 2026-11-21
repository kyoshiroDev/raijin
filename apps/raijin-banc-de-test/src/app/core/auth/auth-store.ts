import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type { Session } from '@supabase/supabase-js';
import { SUPABASE } from '../supabase/supabase-client';

export type ChangePasswordResult = 'ok' | 'wrong-current' | 'update-failed';

/**
 * Global auth state. MUST be instantiated at bootstrap (see `provideAppInitializer` in
 * app.config.ts): the constructor creates the Supabase client, which starts the PKCE code
 * exchange of a reset link right away. The auth listener is registered synchronously in the
 * same tick, before any await, so the PASSWORD_RECOVERY event cannot be missed even though
 * the reset page is lazy-loaded much later.
 */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly supabase = inject(SUPABASE);

  private readonly _session = signal<Session | null>(null);
  private readonly _ready = signal(false);
  /**
   * True only once a PASSWORD_RECOVERY event has been received during THIS page load.
   * In memory only (never persisted): a plain session never unlocks the reset form.
   */
  private readonly _recoveryPending = signal(false);

  readonly session = this._session.asReadonly();
  readonly ready = this._ready.asReadonly();
  readonly recoveryPending = this._recoveryPending.asReadonly();
  readonly isAuthenticated = computed(() => this._session() !== null);
  readonly email = computed(() => this._session()?.user.email ?? null);

  // Field order matters: `supabase` (client creation) → listener → init(). No await before this.
  private readonly subscription = this.supabase.auth.onAuthStateChange((event, session) => {
    this._session.set(session);
    if (event === 'PASSWORD_RECOVERY') this._recoveryPending.set(true);
    if (event === 'SIGNED_OUT') this._recoveryPending.set(false);
  }).data.subscription;

  private readonly initialized: Promise<void> = this.init();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.subscription.unsubscribe());
  }

  private async init(): Promise<void> {
    try {
      const { data } = await this.supabase.auth.getSession();
      this._session.set(data.session);
    } catch {
      this._session.set(null);
    } finally {
      this._ready.set(true);
    }
  }

  whenReady(): Promise<void> {
    return this.initialized;
  }

  /**
   * Email + password sign-in. Returns false on any failure (wrong credentials, unknown
   * account, network…): callers show one generic message, never the raw error.
   */
  async signInWithPassword(email: string, password: string): Promise<boolean> {
    try {
      const { data, error } = await this.supabase.auth.signInWithPassword({ email, password });
      if (error || !data.session) return false;
      this._session.set(data.session);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sends a password reset e-mail. Never throws and never reports the outcome:
   * callers show the same message whatever happens (no account enumeration).
   */
  async requestPasswordReset(email: string): Promise<void> {
    try {
      await this.supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/reset`,
      });
    } catch {
      // Swallowed on purpose: see above.
    }
  }

  /** Sets a new password for the current session. Returns false on any failure. */
  async updatePassword(password: string): Promise<boolean> {
    try {
      const { error } = await this.supabase.auth.updateUser({ password });
      if (error) return false;
      this._recoveryPending.set(false);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * In-app password change for a signed-in user: proves knowledge of the current password
   * with a fresh sign-in (which also makes the session recent for `secure_password_change`),
   * then updates the password, then revokes every other session.
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<ChangePasswordResult> {
    const email = this.email();
    if (!email) return 'wrong-current';
    if (!(await this.signInWithPassword(email, currentPassword))) return 'wrong-current';
    if (!(await this.updatePassword(newPassword))) return 'update-failed';
    await this.signOutOtherSessions();
    return 'ok';
  }

  /** Revokes every other session of the user (e.g. after a password change). Best effort. */
  async signOutOtherSessions(): Promise<void> {
    try {
      await this.supabase.auth.signOut({ scope: 'others' });
    } catch {
      // Best effort: the password is already changed.
    }
  }

  async signOut(): Promise<void> {
    this._recoveryPending.set(false);
    await this.supabase.auth.signOut();
  }
}
