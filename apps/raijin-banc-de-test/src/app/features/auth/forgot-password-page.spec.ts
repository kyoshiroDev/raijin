import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStore } from '../../core/auth/auth-store';
import { ForgotPasswordPage, RESET_SENT_MESSAGE } from './forgot-password-page';

describe('ForgotPasswordPage', () => {
  const requestPasswordReset = vi.fn<(email: string) => Promise<void>>();
  let fixture: ComponentFixture<ForgotPasswordPage>;
  let el: HTMLElement;

  beforeEach(() => {
    requestPasswordReset.mockReset();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthStore, useValue: { requestPasswordReset } }],
    });
    fixture = TestBed.createComponent(ForgotPasswordPage);
    el = fixture.nativeElement;
    fixture.detectChanges();
  });

  async function send(value = ' Me@Example.com ') {
    const input = el.querySelector<HTMLInputElement>('#email');
    if (!input) throw new Error('email input not found');
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    el.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const status = () => el.querySelector('[role="status"]')?.textContent?.trim();

  it('shows the neutral message on success', async () => {
    requestPasswordReset.mockResolvedValue(undefined);
    await send();
    expect(requestPasswordReset).toHaveBeenCalledWith('me@example.com');
    expect(status()).toBe(RESET_SENT_MESSAGE);
  });

  it('shows the exact same message when the request fails', async () => {
    requestPasswordReset.mockRejectedValue(new Error('User not found'));
    await send();
    expect(status()).toBe(RESET_SENT_MESSAGE);
    expect(el.textContent).not.toContain('User not found');
  });

  it('links back to the login page', () => {
    const link = Array.from(el.querySelectorAll('a')).find((a) => a.textContent?.includes('Retour'));
    expect(link?.getAttribute('href')).toBe('/login');
  });
});
