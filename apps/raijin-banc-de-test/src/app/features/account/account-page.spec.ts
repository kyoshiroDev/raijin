import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { BenchMode, BenchSession } from '@raijin/bench-contracts';
import { describe, expect, it } from 'vitest';
import { AuthStore } from '../../core/auth/auth-store';
import { AccountPage, MODE_LABEL } from './account-page';

function render(session: BenchSession | null) {
  const current = signal(session);
  const auth = {
    session: current,
    email: () => current()?.email ?? null,
    mode: (): BenchMode | null => current()?.mode ?? null,
  };
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: AuthStore, useValue: auth }] });
  const fixture = TestBed.createComponent(AccountPage);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('AccountPage', () => {
  it('shows the signed-in owner, the bench mode and the session end', () => {
    const el = render({ email: 'me@example.com', mode: 'shadow', expiresAt: '2026-11-24T20:00:00.000Z' });
    expect(el.textContent).toContain('Connecté : me@example.com');
    expect(el.querySelector('[data-mode]')?.textContent?.trim()).toBe(MODE_LABEL.shadow);
    expect(el.textContent).toContain('24/11/2026 21:00');
  });

  it('offers no password form: password and 2FA are managed by the container CLI', () => {
    const el = render({ email: 'me@example.com', mode: 'primary', expiresAt: '2026-11-24T20:00:00.000Z' });
    expect(el.querySelector('input')).toBeNull();
    expect(el.querySelector('form')).toBeNull();
    expect(el.textContent).toContain('set-password');
    expect(el.textContent).toContain('reset-2fa');
  });
});
